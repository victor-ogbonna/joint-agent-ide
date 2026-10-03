/**
 * The circuit simulator's compile route (admin only): who may use it, what
 * it refuses before building, and the build settings it writes. With
 * SIM_CORE_DIR set to a PlatformIO core folder, it also builds Blink for the
 * Uno, Nano and Mega for real and runs each program in the simulator.
 */
import express from "express";
import { registerSimRoutes, simPlatformioIni, SIM_BOARDS, SIM_MAX_CODE_BYTES } from "../server/simCompile.ts";
import { parseIntelHex } from "../src/sim/hex.ts";
import { Simulation } from "../src/sim/circuit.ts";
import { PART_MODELS } from "../src/sim/parts.ts";
import { BOARDS } from "../src/sim/boards.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const app = express();
app.use(express.json({ limit: "1mb" }));
const requireAdmin = (req, res, next) => (req.headers.authorization === "Bearer admin-token" ? next() : res.status(401).json({ error: "Not authenticated." }));
registerSimRoutes(app, requireAdmin, process.env.SIM_CORE_DIR || "/nonexistent-core");
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/admin/sim/compile`;
const post = (body, token = "admin-token") => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

console.log("Admins only");
{
  const r = await post({ code: "void setup(){} void loop(){}", board: "uno" }, null);
  check(r.status === 401, "no admin session: refused", String(r.status));
  const r2 = await post({ code: "void setup(){} void loop(){}", board: "uno" }, "someone-else");
  check(r2.status === 401, "a wrong token: refused");
}

console.log("Refused before anything is built");
{
  check((await post({ board: "uno" })).status === 400, "no sketch");
  check((await post({ code: "   ", board: "uno" })).status === 400, "an empty sketch");
  const esp = await post({ code: "void setup(){} void loop(){}", board: "esp32" });
  check(esp.status === 400 && /uno, nano or mega/.test((await esp.json()).error), "a board the simulator doesn't run");
  for (const name of ["__proto__", "constructor", "toString"]) check((await post({ code: "void setup(){} void loop(){}", board: name })).status === 400, `a board named "${name}"`);
  const big = await post({ code: "x".repeat(SIM_MAX_CODE_BYTES + 1), board: "uno" });
  check(big.status === 400, "a sketch over the size limit");
  const inc = await post({ code: '#include "/etc/passwd"\nvoid setup(){} void loop(){}', board: "uno" });
  const incBody = await inc.json();
  check(inc.status === 400 && /names a file path/.test(incBody.error), "#include of a file path", incBody.error);
}

console.log("Build settings");
{
  check(SIM_BOARDS.uno === "uno" && SIM_BOARDS.nano === "nanoatmega328" && SIM_BOARDS.mega === "megaatmega2560", "Uno, Nano and Mega build targets");
  for (const [id, target] of Object.entries(SIM_BOARDS)) check(BOARDS[id].buildBoard === target, `${id}: the same target as the simulator's board`);
  const ini = simPlatformioIni("uno", "#include <Servo.h>\n#include <DHT.h>\n#include <Wire.h>\nvoid setup(){} void loop(){}");
  check(/\[env:uno\]\nplatform = atmelavr\nboard = uno\nframework = arduino/.test(ini), "the board's environment");
  check(ini.includes("arduino-libraries/Servo@") && ini.includes("adafruit/DHT sensor library@") && ini.includes("adafruit/Adafruit Unified Sensor@"), "known libraries from the #includes");
  const sneaky = simPlatformioIni("uno", "#include <evil.h>\n#include <x>\nextra_scripts = pre:/tmp/x.py\n// [env:other]\nvoid setup(){} void loop(){}");
  check(!/extra_scripts|evil|env:other/.test(sneaky), "nothing from the sketch itself reaches the settings");
}

if (process.env.SIM_CORE_DIR) {
  console.log("Real builds, run in the simulator");
  const blink = "void setup() { pinMode(13, OUTPUT); Serial.begin(9600); Serial.println(\"hi\"); }\nvoid loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }\n";
  for (const board of ["uno", "nano", "mega"]) {
    const r = await post({ code: blink, board });
    const body = await r.json();
    if (!(r.ok && typeof body.hex === "string")) { check(false, `${board}: compiled`, JSON.stringify(body).slice(0, 300)); continue; }
    let ok = true;
    try { parseIntelHex(body.hex, BOARDS[board].flashBytes); } catch { ok = false; }
    check(ok, `${board}: compiled to a program that loads`);
    const type = { uno: "wokwi-arduino-uno", nano: "wokwi-arduino-nano", mega: "wokwi-arduino-mega" }[board];
    let serial = "";
    const sim = new Simulation({ version: 1, parts: [{ id: board, type, left: 0, top: 0 }], connections: [] }, body.hex, { models: PART_MODELS, onSerial: (t) => (serial += t) });
    const seen = new Set();
    for (let i = 0; i < 40; i++) { sim.run(16000 * 16); seen.add(sim.boardLeds.led13 > 0.5); }
    check(serial.startsWith("hi") && seen.size === 2, `${board}: runs, prints and blinks pin 13`);
  }
  const broken = await post({ code: "void setup() { int x = ; }\nvoid loop() {}\n", board: "uno" });
  const bb = await broken.json();
  check(broken.status === 422 && /expected primary-expression/.test(bb.output || ""), "a compile error comes back with the compiler's message");
  check(!/platformio|\.pio\b|penv/i.test(JSON.stringify(bb)), "without build-tool names");
}

server.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll simulator compile checks passed");
process.exit(bad ? 1 : 0);
