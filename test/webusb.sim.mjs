/**
 * Drives the REAL flasher through the REAL WebUSB adapter, against a mock USB
 * device wired to the same Mega 2560 bootloader model used by
 * test/avrFlash.sim.mjs. No phone required.
 *
 * What this proves: the adapter presents a Web Serial-compatible surface
 * (open/close/setSignals/readable/writable), chunks and reassembles correctly
 * across 64-byte bulk packets, strips FTDI's 2-byte status prefix, and drives
 * DTR through each bridge's own control protocol.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wus-"));
async function bundle(rel, name) {
  const out = join(dir, name);
  await build({ entryPoints: [join(here, "..", rel)], bundle: true, format: "esm",
                platform: "neutral", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}
const { flashAvr } = await bundle("src/lib/avrFlash.ts", "avrFlash.mjs");
const { WebUsbSerialPort } = await bundle("src/lib/webusbSerial.ts", "webusb.mjs");

const MESSAGE_START = 0x1b, TOKEN = 0x0e, STATUS_CMD_OK = 0x00;
const CMD_SIGN_ON = 0x01, CMD_LOAD_ADDRESS = 0x06, CMD_ENTER_PROGMODE_ISP = 0x10,
      CMD_LEAVE_PROGMODE_ISP = 0x11, CMD_PROGRAM_FLASH_ISP = 0x13;

const FLASH_SIZE = 256 * 1024;

class MegaBootloader {
  constructor(opts = {}) {
    this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    this.address = 0;
    this.rx = [];
    this.out = [];
    this.log = [];
    this.badFrames = 0;
    this.chunkBytes = opts.chunkBytes ?? 64;   // how the USB bridge batches replies
    this.running = false;                       // becomes true after reset
  }
  reset() { this.running = true; this.rx.length = 0; this.address = 0; }

  feed(bytes) {
    if (!this.running) return;                  // sketch is running, not the bootloader
    for (const b of bytes) this.rx.push(b);
    this.parse();
  }

  parse() {
    // Scan for complete frames.
    for (;;) {
      const i = this.rx.indexOf(MESSAGE_START);
      if (i < 0) { this.rx.length = 0; return; }
      if (i > 0) this.rx.splice(0, i);
      if (this.rx.length < 5) return;
      const seq = this.rx[1];
      const len = (this.rx[2] << 8) | this.rx[3];
      if (this.rx[4] !== TOKEN) { this.rx.shift(); this.badFrames++; continue; }
      if (len + 1 > 285) { this.rx.shift(); this.badFrames++; continue; }
      const total = 5 + len + 1;
      if (this.rx.length < total) return;
      const frame = this.rx.splice(0, total);
      let ck = 0; for (let k = 0; k < total - 1; k++) ck ^= frame[k];
      if (ck !== frame[total - 1]) { this.badFrames++; this.log.push("BAD CHECKSUM"); continue; }
      this.handle(seq, frame.slice(5, 5 + len));
    }
  }

  reply(seq, body) {
    const head = [MESSAGE_START, seq, (body.length >> 8) & 0xff, body.length & 0xff, TOKEN];
    let ck = 0; for (const b of [...head, ...body]) ck ^= b;
    this.out.push(...head, ...body, ck);
  }

  handle(seq, msg) {
    const cmd = msg[0];
    switch (cmd) {
      case CMD_SIGN_ON:
        this.log.push("SIGN_ON");
        this.reply(seq, [cmd, STATUS_CMD_OK, 8, ...Array.from("AVRISP_2", c => c.charCodeAt(0))]);
        break;
      case CMD_ENTER_PROGMODE_ISP:
        this.log.push("ENTER_PROGMODE");
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      case CMD_LEAVE_PROGMODE_ISP:
        this.log.push("LEAVE_PROGMODE");
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      case CMD_LOAD_ADDRESS: {
        // exactly as stk500boot.c does it for a RAMPZ part
        const a = ((msg[1] << 24) | (msg[2] << 16) | (msg[3] << 8) | msg[4]) >>> 0;
        this.address = (a << 1) >>> 0;
        this.log.push(`LOAD_ADDRESS -> byte 0x${this.address.toString(16)}`);
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      }
      case CMD_PROGRAM_FLASH_ISP: {
        let size = (msg[1] << 8) | msg[2];
        let p = 10;                               // <-- the fixed offset
        if (size % 2 !== 0) { this.log.push("ODD SIZE -> would underflow on real silicon"); this.oddSize = true; }
        let addr = this.address;
        let words = 0;
        do {
          const lo = msg[p++], hi = msg[p++];
          if (lo === undefined || hi === undefined) { this.log.push("READ PAST END OF MESSAGE"); this.overran = true; break; }
          this.flash[addr] = lo; this.flash[addr + 1] = hi;
          addr += 2; size -= 2; words++;
          if (words > 4096) { this.log.push("RUNAWAY"); this.runaway = true; break; }
        } while (size);
        this.log.push(`PROGRAM_FLASH ${words * 2} bytes @0x${this.address.toString(16)}`);
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      }
      default:
        this.log.push(`UNKNOWN 0x${cmd.toString(16)}`);
        this.reply(seq, [cmd, 0xc0]);
        break;
    }
  }

  // Deliver buffered output the way a USB-serial bridge would: in batches.
  drain() {
    if (!this.out.length) return null;
    return new Uint8Array(this.out.splice(0, this.chunkBytes));
  }
}


// --- a mock WebUSB device in front of that bootloader ---
function mockUsbDevice(boot, kind) {
  const control = [];              // every control transfer, for assertions
  let outQueue = [];
  return {
    vendorId: kind === "ch34x" ? 0x1a86 : kind === "cp210x" ? 0x10c4 : kind === "ftdi" ? 0x0403 : 0x2341,
    productId: 0x0042,
    opened: false,
    configuration: null,
    control,
    configurations: [{ interfaces: [{
      interfaceNumber: 0,
      alternates: [{
        interfaceClass: kind === "cdc" ? 0x0a : 0xff,
        endpoints: [
          { direction: "in", type: "bulk", endpointNumber: 1 },
          { direction: "out", type: "bulk", endpointNumber: 2 },
        ],
      }],
    }] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = this.configurations[0]; },
    async claimInterface() {},
    async releaseInterface() {},
    async clearHalt() {},
    async controlTransferOut(setup, data) {
      control.push({ ...setup, len: data ? data.byteLength : 0 });
      // DTR assert on any bridge resets the board; the flasher relies on it.
      const asserted =
        (kind === "cdc"   && setup.request === 0x22 && (setup.value & 1)) ||
        (kind === "ch34x" && setup.request === 0xa4 && ((~setup.value) & 0x20)) ||
        (kind === "cp210x"&& setup.request === 0x07 && (setup.value & 1)) ||
        (kind === "ftdi"  && setup.request === 0x01 && setup.value === 0x0101);
      if (asserted) boot.reset();
      return { status: "ok" };
    },
    async transferOut(_ep, chunk) {
      boot.feed(new Uint8Array(chunk));
      return { status: "ok", bytesWritten: chunk.byteLength };
    },
    async transferIn(_ep, len) {
      // Deliver in real 64-byte bulk packets, the way hardware would.
      for (let i = 0; i < 400; i++) {
        if (outQueue.length) break;
        const d = boot.drain();
        if (d && d.length) { outQueue.push(...d); break; }
        await new Promise((r) => setTimeout(r, 2));
      }
      const take = outQueue.splice(0, Math.min(len, 64));
      let bytes = new Uint8Array(take);
      // FTDI puts two modem-status bytes in front of every IN packet.
      if (kind === "ftdi") bytes = new Uint8Array([0x01, 0x60, ...bytes]);
      return { status: "ok", data: new DataView(bytes.buffer) };
    },
  };
}

function makeHex(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const rec = bytes.slice(i, i + 16);
    const b = [rec.length, (i >> 8) & 0xff, i & 0xff, 0x00, ...rec];
    let sum = 0; for (const x of b) sum += x;
    lines.push(":" + b.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase() +
      (((~sum + 1) & 0xff).toString(16).padStart(2, "0")).toUpperCase());
  }
  lines.push(":00000001FF");
  return lines.join("\n");
}

let failures = 0;
const SIZE = 1474;
const program = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) program[i] = (i * 31 + 7) & 0xff;
const hex = makeHex(program);

for (const kind of ["cdc", "ch34x", "cp210x", "ftdi"]) {
  const boot = new MegaBootloader({ chunkBytes: 64 });
  const device = mockUsbDevice(boot, kind);
  const port = new WebUsbSerialPort(device, kind);
  let verdict;
  try {
    await flashAvr({ hex, uploadProtocol: "wiring", uploadSpeed: 115200,
                     chip: "ATMEGA2560", port, onProgress: () => {} });
    let bad = -1;
    for (let i = 0; i < SIZE; i++) if (boot.flash[i] !== program[i]) { bad = i; break; }
    const clean = !boot.oddSize && !boot.overran && !boot.runaway && boot.badFrames === 0;
    verdict = bad >= 0 ? `flash corrupt at byte ${bad}`
            : !clean   ? "protocol faults"
            : `${SIZE} bytes identical`;
  } catch (e) { verdict = `threw: ${e.message}`; }
  const ok = /identical/.test(verdict);
  if (!ok) failures++;
  const baudSet = device.control.some((c) =>
    (kind === "cdc" && c.request === 0x20) || (kind === "ch34x" && c.request === 0x9a) ||
    (kind === "cp210x" && c.request === 0x1e) || (kind === "ftdi" && c.request === 0x03));
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${kind.padEnd(7)} -> ${verdict}${baudSet ? "" : "  (BAUD NEVER SET)"}`);
  if (!baudSet) failures++;
}

console.log(failures ? `\n${failures} failing case(s)` : "\nAll WebUSB bridges passed.");
process.exit(failures ? 1 : 0);
