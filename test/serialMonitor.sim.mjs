/**
 * Taking the serial port twice must not brick it.
 *
 * The post-flash monitor starts by itself; a user can then ask for the monitor
 * too. That second start used to close-and-reopen a port whose readable stream
 * was still locked by the first reader. Web Serial rejects close() while the
 * stream is locked, and the swallowed rejection was followed by an open() that
 * threw "The port is already open" — after which the error path dropped the
 * reference to the live reader holding the lock. Nothing could release it, and
 * every later flash failed the same way until the board was replugged.
 *
 * The mock below implements the locking contract that makes that possible:
 *   - close() REJECTS while readable is locked
 *   - open() THROWS on an already-open port
 *   - getReader() THROWS while another reader holds the lock
 */

class MockReader {
  constructor(stream) { this.stream = stream; this.done = false; this.waiters = []; this.queue = []; }
  read() {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  deliver(bytes) {
    const w = this.waiters.shift();
    if (w) w({ value: bytes, done: false });
    else this.queue.push(bytes);
  }
  async cancel() {
    this.done = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
    this.stream.locked = false;
  }
  releaseLock() { this.stream.locked = false; }
}

class MockStream {
  constructor() { this.locked = false; this.reader = null; }
  getReader() {
    if (this.locked) throw new TypeError("ReadableStream is locked to a reader");
    this.locked = true;
    this.reader = new MockReader(this);
    return this.reader;
  }
}

class MockSerialPort {
  constructor() { this.isOpen = false; this.readable = null; this.opens = 0; }
  async open() {
    if (this.isOpen) throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open.");
    this.isOpen = true; this.opens++; this.readable = new MockStream();
  }
  async close() {
    if (this.readable && this.readable.locked) throw new Error("Failed to execute 'close' on 'SerialPort': the stream is locked");
    this.isOpen = false; this.readable = null;
  }
  async setSignals() {}
  emit(text) { this.readable?.reader?.deliver(new TextEncoder().encode(text)); }
}

// --- the two implementations, old and new -----------------------------------

function makeMonitor({ stopFirst }) {
  const state = { reader: null, loop: null, lines: [], errors: [] };

  const pump = async (reader) => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const l of parts) { const c = l.trim(); if (c) state.lines.push(c); }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
      if (state.reader === reader) state.reader = null;
    }
  };

  const stop = async () => {
    const reader = state.reader;
    state.reader = null;
    if (reader) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    const loop = state.loop;
    state.loop = null;
    if (loop) { try { await loop; } catch {} }
  };

  const start = async (port) => {
    if (stopFirst) await stop();                       // <-- the fix
    try {
      try { await port.close(); } catch {}
      await port.open({ baudRate: 115200 });
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      const reader = port.readable.getReader();
      state.reader = reader;
      state.loop = pump(reader);
    } catch (e) {
      state.errors.push(e.message);
      if (stopFirst) await stop();                     // never leave it locked
      else state.reader = null;                        // the old, destructive path
    }
  };

  // What each era's flash path did to reclaim the port. The old one cancelled
  // the reader only if the ref still pointed at it — and the failed second
  // start had just cleared that ref, so it cancelled nothing.
  const releaseForFlash = stopFirst
    ? stop
    : async () => {
        if (state.reader) { try { await state.reader.cancel(); } catch {} state.reader = null; }
      };

  return { state, start, stop, releaseForFlash };
}

// What the flasher does next: take the port for esptool.
async function flasherTakesPort(port, monitor) {
  await monitor.releaseForFlash().catch(() => {});
  try { await port.close(); } catch {}
  await port.open({ baudRate: 115200 });               // throws if still open
}

// --- cases -------------------------------------------------------------------

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// 1. The old behaviour, reproduced: this is the bug the user hit.
{
  const port = new MockSerialPort();
  const m = makeMonitor({ stopFirst: false });
  await m.start(port);
  await m.start(port);                                  // "activate serial monitor"
  check(m.state.errors.some(e => /already open/.test(e)),
        "old code: second start errors 'already open'", `(${m.state.errors[0] || "no error"})`);
  let flashErr = null;
  try { await flasherTakesPort(port, m); } catch (e) { flashErr = e.message; }
  check(/already open/.test(flashErr || ""),
        "old code: the next flash is then broken", `(${flashErr})`);
}

// 2. The fix.
{
  const port = new MockSerialPort();
  const m = makeMonitor({ stopFirst: true });
  await m.start(port);
  await m.start(port);
  check(m.state.errors.length === 0, "fix: second start succeeds", `(${m.state.errors.join("; ") || "no errors"})`);
  check(port.readable.locked === true, "fix: exactly one reader holds the lock");
  check(port.opens === 2, "fix: the port really was reopened", `(opens=${port.opens})`);

  port.emit("temp 23.5C\r\ntemp 23.6C\r\n");
  await new Promise(r => setTimeout(r, 10));
  check(m.state.lines.length === 2, "fix: serial data still reaches the monitor",
        `(${JSON.stringify(m.state.lines)})`);

  let flashErr = null;
  try { await flasherTakesPort(port, m); } catch (e) { flashErr = e.message; }
  check(flashErr === null, "fix: the flasher can take the port afterwards", `(${flashErr || "clean"})`);
}

// 3. Five starts in a row — the post-flash auto-start plus impatient clicking.
{
  const port = new MockSerialPort();
  const m = makeMonitor({ stopFirst: true });
  for (let i = 0; i < 5; i++) await m.start(port);
  check(m.state.errors.length === 0, "fix: five consecutive starts, no error");
  port.emit("still alive\n");
  await new Promise(r => setTimeout(r, 10));
  check(m.state.lines.includes("still alive"), "fix: the last monitor is the live one");
  let flashErr = null;
  try { await flasherTakesPort(port, m); } catch (e) { flashErr = e.message; }
  check(flashErr === null, "fix: port still usable after five starts");
}

console.log(bad ? `\n${bad} failing case(s)` : "\nTaking the port twice no longer bricks it.");
process.exit(bad ? 1 : 0);
