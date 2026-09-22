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

/**
 * A pumped, buffered view over the port's ReadableStream.
 *
 * This replaces a readExactly() that raced reader.read() against a timeout and
 * returned `out.slice(0, count)`. Both halves of that were wrong, and together
 * they made STK500v2 sync impossible on a Mega:
 *
 *   1. Bytes past `count` in a chunk were DISCARDED. A USB-serial bridge
 *      hands over a whole frame in one chunk, so reading the 1-byte
 *      MESSAGE_START threw away the other 16 bytes of the sign-on reply and
 *      every subsequent read timed out waiting for bytes already binned.
 *   2. When the timeout won the race, the read() request stayed QUEUED on the
 *      reader. Real ReadableStreamDefaultReaders serve queued requests in
 *      order, so that orphan consumed the next chunk and handed it to nobody —
 *      one timeout poisoned every retry after it.
 *
 * Here a single pump loop owns read(); callers wait on the buffer instead, so
 * nothing is dropped and nothing is left in flight.
 */
class SerialBuffer {
  private buf: number[] = [];
  /** Every byte the port has produced, across discards. Purely diagnostic:
   *  "0 bytes" and "some bytes" are completely different faults. */
  received = 0;
  /** First bytes ever seen, kept for the failure message. "N bytes but none
   *  valid" does not say WHAT arrived, and the answer changes the diagnosis
   *  completely: 0x01 0x60 repeating is an FTDI status header leaking through,
   *  printable ASCII is a sketch still running, and anything else is a baud
   *  rate or wiring problem. */
  private sample: number[] = [];
  /** Rolling window of the most recent bytes, for pinpointing where a reply
   *  stopped making sense mid-session. */
  private recent: number[] = [];
  private ended = false;
  private err: Error | null = null;
  private wake: (() => void) | null = null;
  /** Resolves when the pump stops — awaited before releasing the lock. */
  readonly pumping: Promise<void>;

  /** Optional hook to describe the transport's raw framing in errors. */
  framing: (() => string) | null = null;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.pumping = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) { this.ended = true; break; }
        if (value) {
          this.received += value.length;
          for (let i = 0; i < value.length; i++) {
            this.buf.push(value[i]);
            if (this.sample.length < 24) this.sample.push(value[i]);
            this.recent.push(value[i]);
            if (this.recent.length > 32) this.recent.shift();
          }
        }
        this.signal();
      }
    } catch (e: any) {
      this.err = e instanceof Error ? e : new Error(String(e));
    }
    this.signal();
  }

  private signal(): void {
    const w = this.wake;
    this.wake = null;
    if (w) w();
  }

  /** Drop anything already received — used right after a reset pulse. */
  discard(): void {
    this.buf.length = 0;
  }

  /** Hex of the most recent bytes, to show what a bad reply sat among. */
  describeRecent(): string {
    if (!this.recent.length) return "";
    return this.recent.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  /** Hex plus printable ASCII of the first bytes seen, for the error message. */
  describeSample(): string {
    if (!this.sample.length) return "";
    const hex = this.sample.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = this.sample.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    return ` First bytes: ${hex} ("${ascii}").`;
  }

  /** Resolve with exactly `count` bytes, or reject once `timeoutMs` elapses. */
  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < count) {
      if (this.err) throw this.err;
      if (this.ended) throw new Error("Serial port closed during upload.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for the board (got ${this.buf.length} of ${count} bytes).` +
          (this.recent.length ? ` Recent bytes: ${this.describeRecent()}` : " Nothing has been received at all.") +
          // Raw framing on timeouts too. It was only on the sync-failure path,
          // so the one log that could have settled the FTDI question arrived
          // without it and cost another round.
          (this.framing ? ` ${this.framing()}` : "")
        );
      }
      // Capped so a wake-up that races the assignment below cannot stall us.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { clearTimeout(timer); resolve(); }, Math.min(remaining, 25));
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    return new Uint8Array(this.buf.splice(0, count));
  }
}

/**
 * Send a command and consume the INSYNC/OK envelope every STK500v1 reply is
 * wrapped in. `expectBytes` is the payload length between the two markers.
 */
async function command(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  rx: SerialBuffer,
  payload: number[],
  expectBytes = 0,
  timeoutMs = 2000
): Promise<Uint8Array> {
  await writer.write(new Uint8Array([...payload, CRC_EOP]));

  // One deadline for the whole exchange, so skipping junk cannot add up to a
  // fresh timeout per byte.
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());

  // Resync on INSYNC instead of demanding it be the very first byte. The v2
  // path has always done this; v1 did not, so a SINGLE stray byte ahead of the
  // reply killed the handshake outright — and stray bytes are the normal case,
  // not an exception: an FTDI bridge hands over whatever was sitting in its
  // receive buffer, and a sketch that printed on boot leaves its output there.
  // That is what "the port sent N bytes but none formed a valid reply" was.
  let head = await rx.read(1, left());
  let skipped = 0;
  while (head[0] !== Resp.INSYNC) {
    if (++skipped > 512) {
      throw new Error(
        `Board out of sync — ${skipped} bytes read without a 0x14 reply. ` +
        `Recent bytes: ${rx.describeRecent()}`
      );
    }
    head = await rx.read(1, left());
  }
  const body = expectBytes > 0 ? await rx.read(expectBytes, left()) : new Uint8Array(0);
  let tail = await rx.read(1, left());

  // Junk can also land BETWEEN the two markers, which is what produced
  // "expected 0x10, got 0xfc" the moment resynchronising got sync working.
  // Skipping to the OK is only safe when no payload is expected between them —
  // otherwise a data byte that happened to be 0x10 would be mistaken for the
  // terminator. Every v1 command this flasher sends expects an empty body, so
  // the guard holds; it is asserted rather than assumed.
  if (expectBytes === 0) {
    let junk = 0;
    while (tail[0] !== Resp.OK && junk < 64) {
      junk++;
      tail = await rx.read(1, left());
    }
    skipped += junk;
  }

  if (tail[0] !== Resp.OK) {
    // Name the command and show the surrounding bytes. "expected 0x10, got
    // 0xfc" alone cannot distinguish a stream that is one reply out of step
    // from real corruption, and those need opposite fixes.
    throw new Error(
      `Command 0x${payload[0].toString(16)} got 0x${tail[0].toString(16)} where 0x10 was due` +
      `${skipped ? ` (after skipping ${skipped} byte(s))` : ""}. ` +
      `Recent bytes: ${rx.describeRecent()}`
    );
  }
  return body;
}

/**
 * Sync failed — say which of the two very different faults it was, because the
 * fix is completely different. Silence means we are not connected to the
 * board at all (wrong port, charge-only cable, no auto-reset). Bytes that
 * never formed a valid reply means we ARE talking to something, but it is not
 * speaking this protocol.
 */
function heardNothing(received: number, sample = ""): string {
  return received === 0
    ? "Could not reach the bootloader — the port sent nothing at all (0 bytes). " +
      "That usually means this is not the board's port, the cable is charge-only, " +
      "or the board is not auto-resetting. Unplug and replug the board, then use " +
      "Detect Board and pick the Arduino in the chooser."
    : `Could not reach the bootloader — the port sent ${received} bytes but none formed a valid ` +
      `reply.${sample} Close any serial monitor holding the port and try again.`;
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
  rx: SerialBuffer,
  seq: number,
  body: number[],
  timeoutMs = 3000
): Promise<Uint8Array> {
  await writer.write(v2Frame(seq, body));

  // One deadline for the whole exchange. Giving each byte its own fresh
  // timeout let a noisy line stall here for 256 x timeoutMs — over ten
  // minutes on a page write — instead of failing and retrying.
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());

  // Resync on MESSAGE_START rather than assuming the next byte is ours — a
  // board that just reset can still have boot noise in the buffer.
  let guard = 0;
  let b = await rx.read(1, left());
  while (b[0] !== V2.MESSAGE_START) {
    if (++guard > 256) throw new Error("No STK500v2 frame start from the board.");
    b = await rx.read(1, left());
  }

  const seqByte = await rx.read(1, left());
  if (seqByte[0] !== (seq & 0xff)) {
    throw new Error(`Frame out of order (expected sequence ${seq & 0xff}, got ${seqByte[0]}).`);
  }
  const lenBytes = await rx.read(2, left());
  const len = (lenBytes[0] << 8) | lenBytes[1];
  const token = await rx.read(1, left());
  if (token[0] !== V2.TOKEN) throw new Error("Malformed STK500v2 frame (bad token).");

  const payload = await rx.read(len, left());
  await rx.read(1, left()); // checksum — framing already validated above

  // The bootloader echoes the command it answered. A mismatch means we are
  // reading somebody else's frame, which is worth failing loudly rather than
  // interpreting as a status.
  if (payload.length >= 1 && payload[0] !== body[0]) {
    throw new Error(`Board answered command 0x${payload[0].toString(16)} but we sent 0x${body[0].toString(16)}.`);
  }
  if (payload.length >= 2 && payload[1] !== V2.STATUS_CMD_OK) {
    throw new Error(`Board rejected command 0x${payload[0].toString(16)} (status 0x${payload[1].toString(16)}).`);
  }
  return payload;
}

async function flashStk500v2(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  rx: SerialBuffer,
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
      const reply = await v2Command(writer, rx, seq, [V2.CMD_SIGN_ON], 900);
      // Reply is [CMD_SIGN_ON, status, len, ...signature]
      const sig = new TextDecoder().decode(reply.slice(3)).replace(/\0+$/, "");
      log(`Bootloader responded${sig ? ` (${sig})` : ""}.`);
      rx.discard();   // same reasoning as the v1 path: start clean once synced
      signedOn = true;
      next();
    } catch {
      if (attempt < 3) {
        log(`Sync attempt ${attempt} failed, retrying…`);
        await resetBoard(port, resetDelayMs);
        rx.discard();
      }
    }
  }
  if (!signedOn) {
    throw new Error(heardNothing(rx.received, rx.describeSample()));
  }

  // Values mirror what avrdude sends for wiring boards.
  await v2Command(writer, rx, seq, [
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
    await v2Command(writer, rx, seq, [
      V2.CMD_LOAD_ADDRESS,
      ((wordAddr >> 24) & 0xff) | 0x80,
      (wordAddr >> 16) & 0xff,
      (wordAddr >> 8) & 0xff,
      wordAddr & 0xff,
    ]);
    next();

    // The bootloader writes with `do { ... size -= 2 } while (size)`, so an
    // odd length underflows the counter and scribbles 32K words across the
    // chip. Pad a short final page to an even length with erased-flash 0xFF.
    let payload = chunk;
    if (payload.length % 2 !== 0) {
      const padded = new Uint8Array(payload.length + 1);
      padded.set(payload);
      padded[payload.length] = 0xff;
      payload = padded;
    }

    await v2Command(writer, rx, seq, [
      V2.CMD_PROGRAM_FLASH_ISP,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff,
      // mode, delay, the three ISP command bytes, two poll values — exactly
      // seven, because stk500boot.c reads the page from msgBuffer+10 and does
      // not parse these at all. The COUNT is what matters; get it wrong and
      // the sketch lands offset by the difference. Values mirror avrdude.
      0xc1, 6, 0x40, 0x4c, 0x20, 0x00, 0x00,
      ...payload,
    ], 5000);
    next();

    const pct = Math.round(((page + 1) / totalPages) * 100);
    if (pct !== lastPct && pct % 10 === 0) { log(`Writing… ${pct}%`); lastPct = pct; }
  }

  await v2Command(writer, rx, seq, [V2.CMD_LEAVE_PROGMODE_ISP, 1, 1]);
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
  let rx: SerialBuffer | null = null;

  try {
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    rx = new SerialBuffer(reader!);
    if (typeof (port as any).describeFraming === "function") {
      rx.framing = () => (port as any).describeFraming();
    }

    log("Resetting board into bootloader…");
    await resetBoard(port, resetDelayMs);
    // Whatever the previous sketch printed on its way out is not our reply.
    rx.discard();

    if (transport === "stk500v2") {
      await flashStk500v2(writer!, rx!, port, data, startAddress, pageSize, resetDelayMs, log);
      return;
    }

    // --- stk500v1 (optiboot: Uno, Nano, Pro Mini, urclock boards) ---
    //
    // The catalogue's upload speed is the board's NOMINAL rate, which is not
    // always the rate the bootloader actually on the chip runs at. An
    // FT232-based "Uno" is usually a Duemilanove or a Nano clone carrying the
    // older ATmegaBOOT at 57600, and older boards still use 19200. At the
    // wrong rate the line produces framing garbage rather than silence, which
    // is far more confusing than no reply at all. Try the configured rate
    // first, then the historical ones.
    const bauds = [baudRate, 57600, 19200].filter((b, i, a) => a.indexOf(b) === i);
    let synced = false;

    for (const baud of bauds) {
      if (baud !== baudRate) {
        log(`No reply at ${baudRate} baud. Trying ${baud}…`);
        try { await port.close(); } catch { /* already closed */ }
        await port.open({ baudRate: baud });
        reader = port.readable.getReader();
        writer = port.writable.getWriter();
        rx = new SerialBuffer(reader!);
      }

      for (let attempt = 1; attempt <= 3 && !synced; attempt++) {
        await resetBoard(port, resetDelayMs);
        rx!.discard();
        try {
          await command(writer!, rx!, [Cmd.GET_SYNC], 0, 500);
          synced = true;
        } catch {
          if (attempt < 3) log(`Sync attempt ${attempt} failed, retrying…`);
        }
      }
      if (synced) {
        if (baud !== baudRate) log(`Synced at ${baud} baud.`);
        break;
      }
    }

    if (!synced) {
      // Surface the raw framing when the adapter can describe it. Post-strip
      // bytes alone could not settle whether the status-byte handling was
      // right; the pre-strip packets can.
      const framing = typeof (port as any).describeFraming === "function"
        ? ` ${(port as any).describeFraming()}`
        : "";
      throw new Error(heardNothing(rx!.received, rx!.describeSample() + framing));
    }
    // Drain BEFORE asking anything else. Sync may have succeeded by skipping
    // past junk, and the rest of that junk is still queued — a probe issued now
    // reads it instead of the reply and latches onto the wrong marker.
    rx!.discard();

    // "Bootloader responded" is a weaker claim than it sounds: resynchronising
    // accepts 0x14 followed by 0x10, and in a noisy stream those can occur by
    // chance. Ask the chip to identify itself — a real bootloader answers with
    // its three signature bytes, and junk will not.
    // A signature probe used to sit here. It cost more than it told us:
    // optiboot's verifySpace() busy-loops until the watchdog resets the chip
    // if it reads a byte that is not CRC_EOP, so a probe that misread left the
    // board OUT of the bootloader and every command after it timed out. A
    // diagnostic must not break the thing it is diagnosing. Raw packet logging
    // gives the same insight without touching the protocol.
    log("Bootloader responded.");

    await command(writer!, rx!, [Cmd.ENTER_PROGMODE]);

    const totalPages = Math.ceil(data.length / pageSize);
    let lastPct = -1;

    for (let page = 0; page < totalPages; page++) {
      const offset = page * pageSize;
      const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));

      // STK500 addresses flash in WORDS, not bytes.
      const wordAddr = (startAddress + offset) >> 1;
      await command(writer!, rx!, [Cmd.LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff]);

      await command(writer!, rx!, [
        Cmd.PROG_PAGE,
        (chunk.length >> 8) & 0xff,
        chunk.length & 0xff,
        0x46, // 'F' — flash
        ...chunk,
      ]);

      const pct = Math.round(((page + 1) / totalPages) * 100);
      if (pct !== lastPct && pct % 10 === 0) { log(`Writing… ${pct}%`); lastPct = pct; }
    }

    await command(writer!, rx!, [Cmd.LEAVE_PROGMODE]);
    log(`Done — ${data.length} bytes written across ${totalPages} pages.`);
  } finally {
    // cancel() ends the pump's in-flight read; without this releaseLock()
    // throws over a pending request and buries whatever actually went wrong.
    try { await reader?.cancel(); } catch { /* already gone */ }
    try { await rx?.pumping; } catch { /* pump already stopped */ }
    try { reader?.releaseLock(); } catch { /* already released */ }
    try { writer?.releaseLock(); } catch { /* already released */ }
    try { await port.close(); } catch { /* already closed */ }
  }
}
