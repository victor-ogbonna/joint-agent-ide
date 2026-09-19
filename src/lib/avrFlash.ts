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

export interface AvrBoardProfile {
  /** Flash page size in bytes — page-aligned writes are required. */
  pageSize: number;
  /** Bootloader baud rate. */
  baudRate: number;
  /** Some bootloaders need a longer settle after reset. */
  resetDelayMs: number;
}

/**
 * Per-board bootloader parameters. Getting pageSize wrong corrupts the upload
 * silently — the bytes land at the wrong offsets — so these are explicit rather
 * than guessed.
 */
export const AVR_PROFILES: Record<string, AvrBoardProfile> = {
  uno:        { pageSize: 128, baudRate: 115200, resetDelayMs: 250 },
  nanoatmega328:     { pageSize: 128, baudRate: 57600,  resetDelayMs: 250 },
  nanoatmega328new:  { pageSize: 128, baudRate: 115200, resetDelayMs: 250 },
  megaatmega2560:    { pageSize: 256, baudRate: 115200, resetDelayMs: 250 },
  megaatmega1280:    { pageSize: 256, baudRate: 57600,  resetDelayMs: 250 },
  leonardo:   { pageSize: 128, baudRate: 57600,  resetDelayMs: 250 },
  pro16MHzatmega328: { pageSize: 128, baudRate: 57600, resetDelayMs: 250 },
};

export function profileFor(boardId: string | undefined): AvrBoardProfile {
  return (boardId && AVR_PROFILES[boardId]) || AVR_PROFILES.uno;
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

export interface AvrFlashOptions {
  /** The .hex produced by the build, as text. */
  hex: string;
  boardId?: string;
  /** An already-granted Web Serial port. */
  port: any;
  onProgress?: (message: string) => void;
}

/**
 * Flash an AVR board over Web Serial. Assumes `port` has been granted but NOT
 * opened — this owns the open/close so the reset signals happen in the right
 * order.
 */
export async function flashAvr({ hex, boardId, port, onProgress }: AvrFlashOptions): Promise<void> {
  const log = (m: string) => onProgress?.(m);
  const profile = profileFor(boardId);

  const { data, startAddress } = parseIntelHex(hex);
  log(`Parsed ${data.length} bytes of firmware (page size ${profile.pageSize}).`);

  // Ensure a clean slate — a port left open by an earlier serial monitor
  // session would make open() throw.
  try { await port.close(); } catch { /* not open, which is the normal case */ }
  await port.open({ baudRate: profile.baudRate });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  try {
    reader = port.readable.getReader();
    writer = port.writable.getWriter();

    log("Resetting board into bootloader…");
    await resetBoard(port, profile.resetDelayMs);

    // The bootloader window is short, so retry sync rather than failing on the
    // first miss. Three attempts covers a slow USB enumeration.
    let synced = false;
    for (let attempt = 1; attempt <= 3 && !synced; attempt++) {
      try {
        await command(writer!, reader!, [Cmd.GET_SYNC], 0, 500);
        synced = true;
      } catch {
        if (attempt < 3) {
          log(`Sync attempt ${attempt} failed, retrying…`);
          await resetBoard(port, profile.resetDelayMs);
        }
      }
    }
    if (!synced) {
      throw new Error(
        "Could not reach the bootloader. Check the board is an AVR (Uno/Nano/Mega), the cable carries data, and no serial monitor is holding the port."
      );
    }
    log("Bootloader responded.");

    await command(writer!, reader!, [Cmd.ENTER_PROGMODE]);

    const pageSize = profile.pageSize;
    const totalPages = Math.ceil(data.length / pageSize);
    let lastPct = -1;

    for (let page = 0; page < totalPages; page++) {
      const offset = page * pageSize;
      const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));

      // STK500 addresses flash in WORDS, not bytes — a byte address here writes
      // everything to double the intended offset and produces a board that
      // flashes "successfully" and then does nothing.
      const wordAddr = (startAddress + offset) >> 1;
      await command(writer!, reader!, [Cmd.LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff]);

      await command(writer!, reader!, [
        Cmd.PROG_PAGE,
        (chunk.length >> 8) & 0xff,
        chunk.length & 0xff,
        0x46, // 'F' — flash memory
        ...chunk,
      ]);

      const pct = Math.round(((page + 1) / totalPages) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        log(`Writing… ${pct}%`);
        lastPct = pct;
      }
    }

    await command(writer!, reader!, [Cmd.LEAVE_PROGMODE]);
    log(`Done — ${data.length} bytes written across ${totalPages} pages.`);
  } finally {
    // Release in order; a lock left held makes every later attempt fail with
    // "port is already open".
    try { reader?.releaseLock(); } catch { /* already released */ }
    try { writer?.releaseLock(); } catch { /* already released */ }
    try { await port.close(); } catch { /* already closed */ }
  }
}
