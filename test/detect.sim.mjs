/**
 * A board we cannot claim is still a board we can name.
 *
 * Detect Board used to open the port purely so it could call getInfo() and
 * close again. getInfo() reads the USB descriptor and needs no open port, but
 * open() claims an interface — and on Android the phone's own cdc_acm driver
 * holds a genuine Arduino's, so the claim fails and the whole scan aborted.
 * The chooser would list "Arduino Mega 2560" by name, the user would tap
 * Connect, and the app would show nothing connected at all.
 *
 * Flashing that board from the phone's USB port really is impossible (Chrome
 * is not allowed to detach cdc_acm). Detecting it never was.
 */

const BOARDS = {
  "0x2341:0x0042": { name: "Arduino Mega 2560", type: "arduino" },
  "0x1a86:0x7523": { name: "USB serial device (CH340)", type: null },
};
const lookup = (vid, pid) =>
  BOARDS[`0x${vid.toString(16).padStart(4, "0")}:0x${pid.toString(16).padStart(4, "0")}`] || null;

class MockPort {
  constructor({ vid, pid, claimable }) {
    this.vid = vid; this.pid = pid; this.claimable = claimable; this.calls = [];
  }
  getInfo() { this.calls.push("getInfo"); return { usbVendorId: this.vid, usbProductId: this.pid }; }
  async open() {
    this.calls.push("open");
    if (!this.claimable) {
      const e = new Error("Unable to claim interface.");
      e.code = "HELD_BY_PHONE_DRIVER"; e.usbVendorId = this.vid; e.usbProductId = this.pid;
      throw e;
    }
  }
  async close() { this.calls.push("close"); }
}

// How it used to work: identity was only reachable through an open port.
async function detectOld(port) {
  try {
    try { await port.close(); } catch {}
    await port.open({ baudRate: 115200 });
    const info = await port.getInfo();
    await port.close();
    const board = lookup(info.usbVendorId, info.usbProductId);
    return { connected: true, name: board?.name ?? "Generic serial device", claimable: true };
  } catch {
    return { connected: false, name: null, claimable: false };
  }
}

// How it works now: identify first, then find out whether we can claim it.
async function detectNew(port) {
  const info = await port.getInfo();
  let claimable = true;
  try {
    try { await port.close(); } catch {}
    await port.open({ baudRate: 115200 });
    await port.close();
  } catch { claimable = false; }
  const board = lookup(info.usbVendorId, info.usbProductId);
  return { connected: true, name: board?.name ?? "Generic serial device", claimable };
}

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// 1. The reported case: a genuine Mega on Android.
{
  const mega = () => new MockPort({ vid: 0x2341, pid: 0x0042, claimable: false });
  const before = await detectOld(mega());
  check(before.connected === false, "old: held Mega shows as NOT connected (the bug)");

  const port = mega();
  const after = await detectNew(port);
  check(after.connected === true, "fix: held Mega shows as connected");
  check(after.name === "Arduino Mega 2560", "fix: and is named correctly", `(${after.name})`);
  check(after.claimable === false, "fix: but is known to be unclaimable");
  check(port.calls[0] === "getInfo", "fix: identity is read before any open", `(${port.calls.join(" → ")})`);
}

// 2. A board that does work must be unaffected.
{
  const port = new MockPort({ vid: 0x1a86, pid: 0x7523, claimable: true });
  const r = await detectNew(port);
  check(r.connected === true && r.claimable === true, "fix: a CH340 adapter still connects normally");
  check(r.name === "USB serial device (CH340)", "fix: and is still named", `(${r.name})`);
  check(port.calls.includes("open"), "fix: a claimable port is still actually opened");
  check(port.calls[port.calls.length - 1] === "close", "fix: and closed again after the probe",
        `(${port.calls.join(" → ")})`);
}

// 3. An unknown chip is still reported rather than dropped.
{
  const r = await detectNew(new MockPort({ vid: 0x9999, pid: 0x0001, claimable: false }));
  check(r.connected === true && r.name === "Generic serial device",
        "fix: an unknown unclaimable device still reports", `(${r.name})`);
}

console.log(bad ? `\n${bad} failing case(s)` : "\nA board that cannot be claimed is still detected and named.");
process.exit(bad ? 1 : 0);
