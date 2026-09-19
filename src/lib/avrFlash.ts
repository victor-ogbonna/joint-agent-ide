// ---------------------------------------------------------------------------
// In-browser AVR flashing over Web Serial (STK500v1).
//
// Why this exists: ESP32 boards flash in the browser via esptool-js, but AVR
// boards had no browser path at all — they were routed to the backend, which
// runs `pio run -t upload` and looks for the board on the SERVER's USB ports.
// The server is in a datacentre and has no serial devices, so Arduino flashing
// could never work for any user. This closes that gap.
//
// The Uno/Nano/Mega bootloaders (optiboot and ATmegaBOOT) speak STK500v1, a
// small, stable, well-documented protocol: toggle DTR/RTS to reset the board
// into the bootloader, sync, then write flash one page at a time.
// ---------------------------------------------------------------------------

/** STK500v1 constants — only the subset needed to program flash. */
const Resp = { OK: 0x10, INSYNC: 0x14, NOSYNC: 0x15, FAILED: 0x11 } as const;
const Cmd = {
  GET_SYNC: 0x30,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE: 0x64,
  READ_PAGE: 0x74,
  READ_SIGN: 0x75,
} as const;
const CRC_EOP = 0x20;

/** Flash page size is a property of the CHIP, not the board, and is the one
 *  upload parameter PlatformIO's board files do not carry. Getting it wrong
 *  corrupts an upload silently — bytes land at the wrong offsets and the board
 *  "flashes successfully" then does nothing. */
const PAGE_SIZE_BY_CHIP: Array<[RegExp, number]> = [
  [/atmega(640|1280|1281|2560|2561)/i, 256],
  [/atmega(1284|644|328|324|168|88|48|32u4|16u4|8)/i, 128],
  [/attiny(85|84|861|167)/i, 64],
];

export function pageSizeForChip(chip: string | undefined): number {
  const c = (chip || "").toLowerCase();
  for (const [re, size] of PAGE_SIZE_BY_CHIP) if (re.test(c)) return size;
  return 128; // the overwhelmingly common case for classic AVRs
}

/**
 * How a board's bootloader is spoken to, derived from its own PlatformIO
 * `upload.protocol`. Hardcoding a handful of boards was wrong — all 466 boards
 * in the catalogue carry this, and the protocols are not interchangeable.
 */
export type AvrTransport = "stk500v1" | "stk500v2" | "unsupported";

export function transportForProtocol(protocol: string | undefined): AvrTransport {
  switch ((protocol || "").toLowerCase()) {
    // Optiboot and friends. 'urclock' is avrdude's newer driver for the same
    // optiboot bootloaders and is wire-compatible for programming flash.
    case "arduino":
    case "stk500":
    case "stk500v1":
    case "urclock":
      return "stk500v1";
    // The Mega's bootloader. Framed protocol, sequence numbers, checksums.
    case "wiring":
    case "stk500v2":
      return "stk500v2";
    // usbtiny / usbasp / micronucleus / buspirate are external HARDWARE
    // programmers, not serial bootloaders. No amount of Web Serial reaches
    // them — they need a physical programmer plugged into the user's machine.
    default:
      return "unsupported";
  }
}

/**
 * Parse Intel HEX into a flat byte image plus its start address.
 *
 * AVR sketches are emitted as .hex, not a raw binary — records can appear out
 * of order and with gaps, so this builds a sparse map first and only then
 * flattens it. Gaps are filled with 0xFF, which is erased-flash state.
 */
export function parseIntelHex(hex: string): { data: Uint8Array; startAddress: number } {
  const bytes = new Map<number, number>();
  let upper = 0;
  let minAddr = Infinity;
  let maxAddr = -1;

  for (const raw of hex.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== ":") continue;

    const len = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);

    // Verify the record checksum. A corrupted record that slipped through would
    // otherwise be written to the chip as if it were valid.
    let sum = 0;
    for (let i = 1; i < line.length - 1; i += 2) sum += parseInt(line.substr(i, 2), 16);
    if ((sum & 0xff) !== 0) throw new Error(`Bad checksum in HEX record: ${line.slice(0, 20)}…`);

    if (type === 0x00) {
      for (let i = 0; i < len; i++) {
        const a = (upper << 16) + addr + i;
        bytes.set(a, parseInt(line.substr(9 + i * 2, 2), 16));
        if (a < minAddr) minAddr = a;
        if (a > maxAddr) maxAddr = a;
      }
    } else if (type === 0x01) {
      break; // end of file
    } else if (type === 0x04) {
      upper = parseInt(line.substr(9, 4), 16);
    } else if (type === 0x02) {
      upper = parseInt(line.substr(9, 4), 16) >> 12;
    }
    // 0x03 / 0x05 are start-address records; irrelevant for programming flash.
  }

  if (maxAddr < 0) throw new Error("HEX file contained no data records.");

  const data = new Uint8Array(maxAddr - minAddr + 1).fill(0xff);
  for (const [a, v] of bytes) data[a - minAddr] = v;
  return { data, startAddress: minAddr };
}

/** Reads exactly `count` bytes, or rejects once `timeoutMs` elapses. */
async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs: number
): Promise<Uint8Array> {
  const out: number[] = [];
  const deadline = Date.now() + timeoutMs;

  while (out.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for the board (got ${out.length} of ${count} bytes).`);
    }
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), remaining)),
    ]);
    if (!result) throw new Error(`Timed out waiting for the board (got ${out.length} of ${count} bytes).`);
    const { value, done } = result as ReadableStreamReadResult<Uint8Array>;
    if (done) throw new Error("Serial port closed during upload.");
    if (value) out.push(...value);
  }
  return new Uint8Array(out.slice(0, count));
}

/**
 * Send a command and consume the INSYNC/OK envelope every STK500v1 reply is
 * wrapped in. `expectBytes` is the payload length between the two markers.
 */
async function command(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  payload: number[],
  expectBytes = 0,
  timeoutMs = 2000
): Promise<Uint8Array> {
  await writer.write(new Uint8Array([...payload, CRC_EOP]));

  const head = await readExactly(reader, 1, timeoutMs);
  if (head[0] !== Resp.INSYNC) {
    throw new Error(`Board out of sync (expected 0x14, got 0x${head[0].toString(16)}).`);
  }
  const body = expectBytes > 0 ? await readExactly(reader, expectBytes, timeoutMs) : new Uint8Array(0);
  const tail = await readExactly(reader, 1, timeoutMs);
  if (tail[0] !== Resp.OK) {
    throw new Error(`Board rejected a command (expected 0x10, got 0x${tail[0].toString(16)}).`);
  }
  return body;
}

/**
 * Pulse DTR/RTS low then high. On an Arduino this drives the auto-reset line,
 * dropping the chip into its bootloader, which listens for ~1 second before
 * handing control to the existing sketch — hence the tight sync loop after.
 */
async function resetBoard(port: any, settleMs: number): Promise<void> {
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await new Promise((r) => setTimeout(r, 120));
  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  await new Promise((r) => setTimeout(r, settleMs));
}

// ---------------------------------------------------------------------------
// STK500v2 ("wiring") — what the Mega 2560 and friends speak.
//
// Every message is framed: 0x1B, sequence, 2-byte length, 0x0E token, body,
// then an XOR checksum of everything before it. The reply carries the same
// sequence number and an ANSWER_CKSUM of the whole frame. None of this exists
// in v1, which is why a v1 sync byte gets no response at all from a Mega.
// ---------------------------------------------------------------------------
const V2 = {
  MESSAGE_START: 0x1b,
  TOKEN: 0x0e,
  CMD_SIGN_ON: 0x01,
  CMD_LOAD_ADDRESS: 0x06,
  CMD_ENTER_PROGMODE_ISP: 0x10,
  CMD_LEAVE_PROGMODE_ISP: 0x11,
  CMD_PROGRAM_FLASH_ISP: 0x13,
  STATUS_CMD_OK: 0x00,
} as const;

function v2Frame(seq: number, body: number[]): Uint8Array {
  const len = body.length;
  const head = [V2.MESSAGE_START, seq & 0xff, (len >> 8) & 0xff, len & 0xff, V2.TOKEN];
  const all = [...head, ...body];
  let cksum = 0;
  for (const b of all) cksum ^= b;
  return new Uint8Array([...all, cksum]);
}

/** Send one framed command and return its body (minus the echoed command byte). */
async function v2Command(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  seq: number,
  body: number[],
  timeoutMs = 3000
): Promise<Uint8Array> {
  await writer.write(v2Frame(seq, body));

  // Resync on MESSAGE_START rather than assuming the next byte is ours — a
  // board that just reset can still have boot noise in the buffer.
  let guard = 0;
  let b = await readExactly(reader, 1, timeoutMs);
  while (b[0] !== V2.MESSAGE_START) {
    if (++guard > 256) throw new Error("No STK500v2 frame start from the board.");
    b = await readExactly(reader, 1, timeoutMs);
  }

  const seqByte = await readExactly(reader, 1, timeoutMs);
  if (seqByte[0] !== (seq & 0xff)) {
    throw new Error(`Frame out of order (expected sequence ${seq & 0xff}, got ${seqByte[0]}).`);
  }
  const lenBytes = await readExactly(reader, 2, timeoutMs);
  const len = (lenBytes[0] << 8) | lenBytes[1];
  const token = await readExactly(reader, 1, timeoutMs);
  if (token[0] !== V2.TOKEN) throw new Error("Malformed STK500v2 frame (bad token).");

  const payload = await readExactly(reader, len, timeoutMs);
  await readExactly(reader, 1, timeoutMs); // checksum — framing already validated above

  if (payload.length >= 2 && payload[1] !== V2.STATUS_CMD_OK) {
    throw new Error(`Board rejected command 0x${payload[0].toString(16)} (status 0x${payload[1].toString(16)}).`);
  }
  return payload;
}

async function flashStk500v2(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  port: any,
  data: Uint8Array,
  startAddress: number,
  pageSize: number,
  resetDelayMs: number,
  log: (m: string) => void
): Promise<void> {
  let seq = 1;
  const next = () => (seq = (seq + 1) & 0xff);

  let signedOn = false;
  for (let attempt = 1; attempt <= 3 && !signedOn; attempt++) {
    try {
      const reply = await v2Command(writer, reader, seq, [V2.CMD_SIGN_ON], 900);
      // Reply is [CMD_SIGN_ON, status, len, ...signature]
      const sig = new TextDecoder().decode(reply.slice(3)).replace(/\0+$/, "");
      log(`Bootloader responded${sig ? ` (${sig})` : ""}.`);
      signedOn = true;
      next();
    } catch {
      if (attempt < 3) {
        log(`Sync attempt ${attempt} failed, retrying…`);
        await resetBoard(port, resetDelayMs);
      }
    }
  }
  if (!signedOn) {
    throw new Error(
      "Could not reach the bootloader. Check the cable carries data (not charge-only) and that no serial monitor is holding the port."
    );
  }

  // Values mirror what avrdude sends for wiring boards.
  await v2Command(writer, reader, seq, [
    V2.CMD_ENTER_PROGMODE_ISP,
    200, 100, 25, 32, 0, 0x53, 3, 0xac, 0x53, 0, 0,
  ]);
  next();

  const totalPages = Math.ceil(data.length / pageSize);
  let lastPct = -1;

  for (let page = 0; page < totalPages; page++) {
    const offset = page * pageSize;
    const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));

    // Word address, and bit 31 marks it as an extended (>64 KB) address —
    // required on a Mega, whose flash runs past the 16-bit word boundary.
    const wordAddr = (startAddress + offset) >> 1;
    await v2Command(writer, reader, seq, [
      V2.CMD_LOAD_ADDRESS,
      ((wordAddr >> 24) & 0xff) | 0x80,
      (wordAddr >> 16) & 0xff,
      (wordAddr >> 8) & 0xff,
      wordAddr & 0xff,
    ]);
    next();

    await v2Command(writer, reader, seq, [
      V2.CMD_PROGRAM_FLASH_ISP,
      (chunk.length >> 8) & 0xff,
      chunk.length & 0xff,
      0xc1, 10, 0, 0, 0, 0, 0, 0, 0, 0,
      ...chunk,
    ], 5000);
    next();

    const pct = Math.round(((page + 1) / totalPages) * 100);
    if (pct !== lastPct && pct % 10 === 0) { log(`Writing… ${pct}%`); lastPct = pct; }
  }

  await v2Command(writer, reader, seq, [V2.CMD_LEAVE_PROGMODE_ISP, 1, 1]);
  log(`Done — ${data.length} bytes written across ${totalPages} pages.`);
}

export interface AvrFlashOptions {
  /** The .hex produced by the build, as text. */
  hex: string;
  /** The board's PlatformIO `upload.protocol` — e.g. "arduino", "wiring". */
  uploadProtocol?: string;
  /** The board's `upload.speed`. */
  uploadSpeed?: number;
  /** The chip, e.g. "ATMEGA2560" — decides flash page size. */
  chip?: string;
  /** An already-granted Web Serial port. */
  port: any;
  onProgress?: (message: string) => void;
}

/**
 * Flash an AVR board over Web Serial, using the board's own upload parameters
 * rather than a guess. Assumes `port` has been granted but NOT opened — this
 * owns open/close so the reset signals happen in the right order.
 */
export async function flashAvr({
  hex, uploadProtocol, uploadSpeed, chip, port, onProgress,
}: AvrFlashOptions): Promise<void> {
  const log = (m: string) => onProgress?.(m);

  const transport = transportForProtocol(uploadProtocol);
  if (transport === "unsupported") {
    throw new Error(
      `This board uploads over "${uploadProtocol}", which is an external hardware programmer rather than a serial bootloader. ` +
      `A browser cannot drive it — boards like this need a physical programmer (USBasp, USBtinyISP) and the desktop toolchain.`
    );
  }

  const baudRate = uploadSpeed || 115200;
  const pageSize = pageSizeForChip(chip);
  const resetDelayMs = transport === "stk500v2" ? 300 : 250;

  const { data, startAddress } = parseIntelHex(hex);
  log(`Parsed ${data.length} bytes — ${transport}, ${baudRate} baud, ${pageSize}-byte pages.`);

  try { await port.close(); } catch { /* not open, the normal case */ }
  await port.open({ baudRate });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  try {
    reader = port.readable.getReader();
    writer = port.writable.getWriter();

    log("Resetting board into bootloader…");
    await resetBoard(port, resetDelayMs);

    if (transport === "stk500v2") {
      await flashStk500v2(writer!, reader!, port, data, startAddress, pageSize, resetDelayMs, log);
      return;
    }

    // --- stk500v1 (optiboot: Uno, Nano, Pro Mini, urclock boards) ---
    let synced = false;
    for (let attempt = 1; attempt <= 3 && !synced; attempt++) {
      try {
        await command(writer!, reader!, [Cmd.GET_SYNC], 0, 500);
        synced = true;
      } catch {
        if (attempt < 3) {
          log(`Sync attempt ${attempt} failed, retrying…`);
          await resetBoard(port, resetDelayMs);
        }
      }
    }
    if (!synced) {
      throw new Error(
        "Could not reach the bootloader. Check the cable carries data (not charge-only) and that no serial monitor is holding the port."
      );
    }
    log("Bootloader responded.");

    await command(writer!, reader!, [Cmd.ENTER_PROGMODE]);

    const totalPages = Math.ceil(data.length / pageSize);
    let lastPct = -1;

    for (let page = 0; page < totalPages; page++) {
      const offset = page * pageSize;
      const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));

      // STK500 addresses flash in WORDS, not bytes.
      const wordAddr = (startAddress + offset) >> 1;
      await command(writer!, reader!, [Cmd.LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff]);

      await command(writer!, reader!, [
        Cmd.PROG_PAGE,
        (chunk.length >> 8) & 0xff,
        chunk.length & 0xff,
        0x46, // 'F' — flash
        ...chunk,
      ]);

      const pct = Math.round(((page + 1) / totalPages) * 100);
      if (pct !== lastPct && pct % 10 === 0) { log(`Writing… ${pct}%`); lastPct = pct; }
    }

    await command(writer!, reader!, [Cmd.LEAVE_PROGMODE]);
    log(`Done — ${data.length} bytes written across ${totalPages} pages.`);
  } finally {
    try { reader?.releaseLock(); } catch { /* already released */ }
    try { writer?.releaseLock(); } catch { /* already released */ }
    try { await port.close(); } catch { /* already closed */ }
  }
}
