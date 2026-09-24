/**
 * Nothing the server prints may name the build toolchain.
 *
 * These samples are the real shapes a build emits — the banner, the size
 * report, a dependency-finder link, an install error. A new toolchain version
 * that words something differently should fail here, loudly, rather than
 * quietly print the wrong brand to a user.
 */
import { scrubToolchainNames as scrub } from "../server/scrub.js";

const samples = {
  "build banner + size report": `Processing uno (platform: atmelavr; board: uno; framework: arduino)
CONFIGURATION: https://docs.platformio.org/page/boards/atmelavr/uno.html
LDF: Library Dependency Finder -> https://bit.ly/configure-pio-ldf
Building in release mode
Checking size .pio/build/uno/firmware.elf
Flash: [          ]   2.9% (used 924 bytes from 32256 bytes)
========================= [SUCCESS] Took 1.23 seconds =========================`,

  "version + install error": `PlatformIO Core, version 6.1.11
Error: Please install the platform first via \`pio pkg install\`
See https://docs.platformio.org/en/latest/core/index.html
Config file: /project/platformio.ini
Cache dir: ~/.platformio/.cache`,

  "registry + home": `Looking for dependencies in the PlatformIO Registry...
Tool Manager: Installing platformio/tool-esptoolpy
Please run \`pio run -t upload\` or open PlatformIO Home.`,

  "upload failure": `Uploading .pio/build/megaatmega2560/firmware.hex
avrdude: stk500v2_ReceiveMessage(): timeout
*** [upload] Error 1`,
};

let bad = 0;
for (const [name, sample] of Object.entries(samples)) {
  const out = scrub(sample);
  const leaks = [...out.matchAll(/platformio|(?<![a-z])pio(?![a-z])/gi)].map((m) => m[0]);
  const ok = leaks.length === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(28)}${ok ? "" : " leaked: " + JSON.stringify(leaks)}`);
}

// The reverse guarantee: real names must survive untouched everywhere else,
// because the server writes them to disk and runs them.
const untouched = [
  ["platform = espressif32", "board platform key"],
  ["board = megaatmega2560", "board id"],
  ["framework = arduino", "framework key"],
  ["monitor_speed = 115200", "monitor speed"],
];
for (const [line, what] of untouched) {
  const ok = scrub(line) === line;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${("keeps " + what).padEnd(28)}${ok ? "" : ` -> ${scrub(line)}`}`);
}

console.log(bad ? `\n${bad} failing case(s)` : "\nNo toolchain branding survives; build-critical names intact.");
process.exit(bad ? 1 : 0);
