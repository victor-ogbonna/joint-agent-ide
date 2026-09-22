/**
 * Closing and reopening the WebUSB port must not leave two read loops running.
 *
 * That is the exact cycle between flashing and starting the serial monitor:
 * esptool disconnects (close), the monitor reopens. If the loop pending on a
 * transferIn at close time resumes after the reopen, two loops read the same
 * endpoint and enqueue into the same stream, and the bytes arrive interleaved
 * — which is what showed up as gibberish in the monitor on a phone.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "pump-")), "webusb.mjs");
await build({ entryPoints: [join(here, "..", "src", "lib", "webusbSerial.ts")],
              bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const { WebUsbSerialPort } = await import(pathToFileURL(out).href);

// A device whose transferIn resolves slowly, so a read is always in flight
// when close() is called — the situation the bug needs.
function slowDevice() {
  let counter = 0;
  let reads = 0;
  return {
    get readCount() { return reads; },
    vendorId: 0x1a86, productId: 0x7523, opened: false, configuration: null,
    configurations: [{ interfaces: [{ interfaceNumber: 0, alternates: [{
      interfaceClass: 0xff,
      endpoints: [{ direction: "in", type: "bulk", endpointNumber: 2, packetSize: 64 },
                  { direction: "out", type: "bulk", endpointNumber: 2, packetSize: 64 }],
    }] }] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = this.configurations[0]; },
    async claimInterface() {}, async releaseInterface() {}, async clearHalt() {},
    async controlTransferOut() { return { status: "ok" }; },
    async transferOut(_e, c) { return { status: "ok", bytesWritten: c.byteLength }; },
    async transferIn() {
      reads++;
      await new Promise((r) => setTimeout(r, 40));   // still pending across close()
      // Each read yields a distinct, ordered byte so interleaving is visible.
      return { status: "ok", data: new DataView(new Uint8Array([counter++ & 0xff]).buffer) };
    },
  };
}

const dev = slowDevice();
const port = new WebUsbSerialPort(dev, "ch34x");

await port.open({ baudRate: 115200 });
await new Promise((r) => setTimeout(r, 60));     // let a read get in flight
await port.close();                               // esptool's disconnect
await port.open({ baudRate: 115200 });            // the monitor reopening

// Read what the reopened stream delivers.
const reader = port.readable.getReader();
const got = [];
const deadline = Date.now() + 500;
while (Date.now() < deadline && got.length < 6) {
  const { value } = await Promise.race([
    reader.read(),
    new Promise((r) => setTimeout(() => r({ value: null }), 200)),
  ]);
  if (value) got.push(...value);
}
try { await reader.cancel(); } catch {}
try { await port.close(); } catch {}

// One loop means strictly increasing values. Two loops racing the same
// counter produce duplicates or values out of order.
const ordered = got.every((v, i) => i === 0 || v > got[i - 1]);
const unique = new Set(got).size === got.length;
const ok = got.length > 0 && ordered && unique;
console.log(`  ${ok ? "ok  " : "FAIL"}  reopen after close -> bytes [${got.join(" ")}] ordered=${ordered} unique=${unique}`);
console.log(ok ? "\nSingle reader confirmed." : "\n1 failing case(s)");
process.exit(ok ? 0 : 1);
