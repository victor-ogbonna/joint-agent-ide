/**
 * Drives the REAL esptool-js through the REAL WebUSB adapter against a
 * simulated CH340 bridge and ESP32 ROM bootloader. No phone, no board.
 *
 * What this proves: that the adapter satisfies the contract esptool-js
 * actually depends on — device.open()/close(), setSignals() semantics,
 * readable/writable streams that survive getReader()/releaseLock() on every
 * chunk (esptool's readLoop does exactly that), and a DTR/RTS waveform that
 * really latches an ESP32 into download mode.
 *
 * The ROM model refuses to answer unless the classic reset waveform is
 * correct, so a polarity or ordering mistake in the adapter fails the test
 * rather than quietly passing.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "esp-"));
const out = join(dir, "webusb.mjs");
await build({ entryPoints: [join(here, "..", "src", "lib", "webusbSerial.ts")],
              bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const { WebUsbSerialPort } = await import(pathToFileURL(out).href);

// esptool-js ships bundler-style extensionless imports that Node's ESM
// resolver rejects, so bundle it the same way as our own modules. This is the
// REAL library, not a stand-in.
const espOut = join(dir, "esptool.mjs");
// platform:"node" so esbuild resolves atob-lite's browser/main fields; the
// library code under test is identical either way.
await build({ entryPoints: [join(here, "..", "node_modules", "esptool-js", "lib", "index.js")],
              bundle: true, format: "esm", platform: "node", outfile: espOut, logLevel: "silent" });
const { ESPLoader, Transport } = await import(pathToFileURL(espOut).href);

const SLIP_END = 0xc0, SLIP_ESC = 0xdb, SLIP_ESC_END = 0xdc, SLIP_ESC_ESC = 0xdd;
const slipEncode = (p) => {
  const o = [SLIP_END];
  for (const b of p) {
    if (b === SLIP_END) o.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) o.push(SLIP_ESC, SLIP_ESC_ESC);
    else o.push(b);
  }
  o.push(SLIP_END);
  return o;
};

/**
 * Models the auto-reset circuit an ESP32 devkit actually has: two cross-coupled
 * transistors, so neither EN nor IO0 is driven unless DTR and RTS DIFFER.
 *
 *   (DTR, RTS) -> (EN, IO0)
 *   (0,0) -> (1,1)      (1,1) -> (1,1)
 *   (0,1) -> (0,1)  EN low, chip held in reset
 *   (1,0) -> (1,1)... IO0 low
 *
 * EN carries a capacitor, so it does not rise the instant it stops being
 * driven — it takes about a millisecond. That RC is the whole reason esptool's
 * sequence works: setDTR(true) then setRTS(false) passes through (1,1), where
 * EN is released while IO0 is still high, and only the capacitor keeps the
 * chip in reset long enough for IO0 to come down. Microseconds apart on a
 * desktop serial driver, that glitch is invisible. Milliseconds apart over USB
 * control transfers from a phone, EN fully charges and the chip boots the
 * application instead of the ROM loader.
 */
const EN_RC_MS = 1.0;

class Esp32Rom {
  constructor(clock) {
    this.clock = clock;              // () => ms, so latency is simulated not slept
    this.dtr = false; this.rts = false;
    this.downloadMode = false;
    this.enReleasedAt = null;        // when EN stopped being driven low
    this.rx = []; this.out = [];
    this.syncsAnswered = 0;
    this.resetEvents = [];
  }
  get enDriven() { return !this.dtr && this.rts; }   // (0,1)
  get io0Low()   { return this.dtr && !this.rts; }   // (1,0)

  /** Resolve a pending EN release using the state as it was DURING the window. */
  _settle(now) {
    if (this.enReleasedAt === null) return;
    if (now - this.enReleasedAt < EN_RC_MS) return;
    // EN has risen. Whatever IO0 was while the capacitor charged is what the
    // chip latched — not whatever arrives afterwards.
    this.downloadMode = this.io0Low;
    this.resetEvents.push(this.io0Low ? "released into DOWNLOAD mode" : "released into NORMAL boot");
    this.enReleasedAt = null;
  }

  signals(dtr, rts) {
    const now = this.clock();
    // Settle FIRST: any pending release resolves with the old line states,
    // because those are what the chip saw while EN was rising.
    this._settle(now);

    const wasDriven = this.enDriven;
    this.dtr = dtr; this.rts = rts;

    if (wasDriven && !this.enDriven) {
      this.enReleasedAt = now;                       // capacitor starts charging
    }
    // A release is pending and IO0 is low: the capacitor is still holding the
    // chip in reset, so it latches download mode when EN finally rises. This
    // is the case the atomic write hits directly, and the one a desktop wins
    // by getting there before the RC expires.
    if (this.enReleasedAt !== null && this.io0Low) {
      this.downloadMode = true;
      this.resetEvents.push("released into DOWNLOAD mode");
      this.enReleasedAt = null;
    }
  }
  feed(bytes) {
    for (const b of bytes) this.rx.push(b);
    for (;;) {
      const s = this.rx.indexOf(SLIP_END);
      if (s < 0) { this.rx.length = 0; return; }
      const e = this.rx.indexOf(SLIP_END, s + 1);
      if (e < 0) { if (s > 0) this.rx.splice(0, s); return; }
      const raw = this.rx.splice(0, e + 1).slice(s + 1, e);
      const p = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === SLIP_ESC) { i++; p.push(raw[i] === SLIP_ESC_END ? SLIP_END : SLIP_ESC); }
        else p.push(raw[i]);
      }
      if (p.length >= 8) this.handle(p);
    }
  }
  handle(p) {
    if (p[0] !== 0x00) return;              // not a request
    const op = p[1];
    if (!this.downloadMode) return;         // running the app: ROM is not listening
    if (op === 0x08) {                      // SYNC
      this.syncsAnswered++;
      // direction, op, size LE16, value LE32, then 2 ROM status bytes
      const body = [0x01, 0x08, 0x02, 0x00, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00];
      // The ROM answers a sync burst 8 times; esptool reads 1 + 7.
      for (let i = 0; i < 8; i++) this.out.push(...slipEncode(body));
    }
  }
  drain(max) { return this.out.length ? new Uint8Array(this.out.splice(0, max)) : null; }
}

function mockCh340(rom, clock, latencyMs) {
  return {
    vendorId: 0x1a86, productId: 0x7523, opened: false, configuration: null,
    configurations: [{ interfaces: [{ interfaceNumber: 0, alternates: [{
      interfaceClass: 0xff,
      endpoints: [{ direction: "in", type: "bulk", endpointNumber: 2, packetSize: 32 },
                  { direction: "out", type: "bulk", endpointNumber: 2, packetSize: 32 }],
    }] }] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = this.configurations[0]; },
    async claimInterface() {}, async releaseInterface() {}, async clearHalt() {},
    async controlTransferOut(setup) {
      // Every control transfer costs time. On a desktop serial driver this is
      // microseconds; over WebUSB from a phone it is milliseconds, which is
      // the entire difference this test exists to capture.
      clock.advance(latencyMs);
      // ch341.c: CH341_REQ_MODEM_CTRL (0xA4), value is ~mcr.
      if (setup.request === 0xa4) {
        const mcr = ~setup.value & 0xff;
        rom.signals(Boolean(mcr & (1 << 5)), Boolean(mcr & (1 << 6)));
      }
      return { status: "ok" };
    },
    async transferOut(_ep, chunk) { rom.feed(new Uint8Array(chunk)); return { status: "ok", bytesWritten: chunk.byteLength }; },
    async transferIn(_ep, len) {
      for (let i = 0; i < 60; i++) {
        const d = rom.drain(Math.min(len, 32));
        if (d) return { status: "ok", data: new DataView(d.buffer) };
        await new Promise((r) => setTimeout(r, 2));
      }
      return { status: "ok", data: new DataView(new Uint8Array(0).buffer) };
    },
  };
}

/** Virtual time: sleeps in the code under test still really sleep, but the
 *  simulated per-transfer USB cost is added on top without wall-clock waiting. */
function makeClock() {
  // Purely virtual: advanced only by simulated transfer cost. Mixing in real
  // Date.now() let event-loop jitter between awaits swamp a 1ms RC window and
  // made the result depend on machine load rather than on the waveform.
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

let failures = 0;
const report = (line, ok) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${line}`); if (!ok) failures++; };

async function run(label, { preOpen = false } = {}) {
  const clock = makeClock();
  const rom = new Esp32Rom(clock.now);
  const port = new WebUsbSerialPort(mockCh340(rom, clock, 0.05), "ch34x");
  // Mirror the app: detection opens and closes the port before flashing.
  await port.open({ baudRate: 115200 });
  await port.close();
  if (preOpen) await port.open({ baudRate: 115200 });   // the "left open" case

  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport, baudrate: 115200,
    terminal: { clean: () => {}, writeLine: () => {}, write: () => {} },
  });
  try {
    await loader.connect("default_reset", 3, false);
    report(`${label} -> connected (${rom.syncsAnswered} syncs answered; ${rom.resetEvents[0] || "no reset seen"})`, true);
  } catch (e) {
    report(`${label} -> ${e.message} | reset: ${rom.resetEvents.join(", ") || "NONE"} | syncs: ${rom.syncsAnswered}`, false);
  }
}

/**
 * After flashing, the chip must be reset with IO0 HIGH so it boots the new
 * sketch. esptool's after('hard_reset') only calls setRTS(false), which is a
 * no-op when ClassicReset already left RTS false — so the board stays in the
 * ROM bootloader until it is power-cycled. Assert that the app's own reset
 * really produces a normal-boot release.
 */
async function runPostFlashReset(label) {
  const clock = makeClock();
  const rom = new Esp32Rom(clock.now);
  const port = new WebUsbSerialPort(mockCh340(rom, clock, 0.05), "ch34x");
  const transport = new Transport(port, false);
  await port.open({ baudRate: 115200 });

  // Pretend a flash just finished: the connect sequence leaves DTR and RTS
  // both deasserted, with the chip sitting in download mode.
  await transport.setDTR(false);
  await transport.setRTS(true);
  await transport.setDTR(true);
  await transport.setRTS(false);          // -> DOWNLOAD mode
  const afterFlash = rom.downloadMode;

  // esptool's own idea of a hard reset, for comparison.
  await transport.setRTS(false);
  const afterEsptoolHardReset = rom.downloadMode;

  // What the app now does instead.
  await transport.setDTR(false);
  await transport.setRTS(true);
  await new Promise((r) => setTimeout(r, 20));
  await transport.setRTS(false);
  // Let the EN capacitor finish charging before reading the boot mode: a
  // pending release is not a decision yet. A no-op write at a later virtual
  // time is how the model observes "time passed".
  clock.advance(EN_RC_MS * 5);
  rom.signals(rom.dtr, rom.rts);
  const afterOurReset = rom.downloadMode;

  await port.close();
  const ok = afterFlash === true && afterEsptoolHardReset === true && afterOurReset === false;
  report(
    `${label} -> in download after flash: ${afterFlash}; ` +
    `after esptool hard_reset: ${afterEsptoolHardReset} (unchanged = the bug); ` +
    `after our reset: ${afterOurReset}${afterOurReset === false ? " (runs the sketch)" : " (STILL STUCK)"}`,
    ok
  );
}

/**
 * The mobile failure, isolated: esptool's reset uses two separate writes and
 * therefore passes through the both-high glitch. Compare it against a reset
 * that sets DTR and RTS in ONE register write, at desktop-like and
 * phone-like control-transfer latency.
 */
async function runResetComparison(latencyMs, label) {
  const results = {};

  // (a) esptool's own ClassicReset, via Transport.setDTR/setRTS.
  {
    const clock = makeClock();
    const rom = new Esp32Rom(clock.now);
    const port = new WebUsbSerialPort(mockCh340(rom, clock, latencyMs), "ch34x");
    await port.open({ baudRate: 115200 });
    const t = new Transport(port, false);
    await t.setDTR(false);
    await t.setRTS(true);
    await new Promise((r) => setTimeout(r, 100));
    await t.setDTR(true);
    await t.setRTS(false);
    await new Promise((r) => setTimeout(r, 50));
    await t.setDTR(false);
    results.twoWrite = rom.downloadMode;
    await port.close();
  }

  // (b) One atomic write for the critical transition.
  {
    const clock = makeClock();
    const rom = new Esp32Rom(clock.now);
    const port = new WebUsbSerialPort(mockCh340(rom, clock, latencyMs), "ch34x");
    await port.open({ baudRate: 115200 });
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });   // EN low
    await new Promise((r) => setTimeout(r, 100));
    // IO0 low AND EN released in the SAME register write: no glitch state.
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    await new Promise((r) => setTimeout(r, 50));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    results.atomic = rom.downloadMode;
    await port.close();
  }

  report(
    `${label} -> esptool two-write: ${results.twoWrite ? "download mode" : "NORMAL BOOT (fails)"}; ` +
    `atomic single-write: ${results.atomic ? "download mode" : "NORMAL BOOT (fails)"}`,
    results.atomic === true
  );
  return results;
}

console.log("esptool-js through the WebUSB adapter (simulated CH340 + ESP32 ROM)");
await run("clean port                ");
await run("port left open by caller  ", { preOpen: true });
await runPostFlashReset("post-flash reset          ");
console.log("\nreset waveform vs control-transfer latency");
await runResetComparison(0.05, "desktop-like  0.05ms/write");
await runResetComparison(8,    "phone-like    8ms/write   ");
console.log(failures ? `\n${failures} failing case(s)` : "\nAll cases passed.");
process.exit(failures ? 1 : 0);
