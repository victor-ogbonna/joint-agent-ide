/**
 * The circuit simulator, run on real programs: each fixture in
 * test/fixtures/sim is an Arduino sketch (the .cpp next to it) compiled by
 * PlatformIO with the real libraries (LiquidCrystal_I2C, Adafruit_SSD1306,
 * Adafruit_NeoPixel, DHT, Servo, Keypad, RTClib). Each is wired to parts the
 * way a diagram would, run for simulated time, and checked by what the parts
 * show and what the program prints.
 */
import fs from "fs";
import { Simulation } from "../src/sim/circuit.ts";
import { PART_MODELS, parseOhms } from "../src/sim/parts.ts";
import { parseDiagram, boardOf } from "../src/sim/diagram.ts";
import { wirePoints, routeFrom, bridgedPath } from "../src/sim/wires.ts";
import { boardPin, BOARDS } from "../src/sim/boards.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const hex = (name) => fs.readFileSync(new URL(`./fixtures/sim/${name}.hex`, import.meta.url), "utf8");
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A diagram with a board, parts and wires, and a running simulation of it. */
function start(program, parts, wires, board = { id: "uno", type: "wokwi-arduino-uno" }) {
  const diagram = parseDiagram(JSON.stringify({
    version: 1,
    parts: [{ ...board, left: 0, top: 0 }, ...parts.map(([id, type, attrs = {}]) => ({ id, type, left: 0, top: 0, attrs }))],
    connections: wires.map(([a, b]) => [a, b, "green", []]),
  }));
  let serial = "";
  const sim = new Simulation(diagram, hex(program), { models: PART_MODELS, onSerial: (t) => (serial += t) });
  return {
    sim,
    serial: () => serial,
    clear: () => { serial = ""; },
    /** Runs `ms` of simulated time in 16 ms frames, as the workspace does. */
    run(ms) { for (let t = 0; t < ms; t += 16) sim.run(Math.min(16, ms - t) * (sim.hz / 1000)); },
    model: (id) => sim.models.get(id),
    lines: () => serial.split(/\r?\n/).filter(Boolean),
  };
}
const lastLine = (t, prefix) => t.lines().filter((l) => l.startsWith(prefix)).pop() ?? "";
const field = (line, key) => { const m = new RegExp(`(?:^|\\s)${key}=(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : NaN; };

console.log("Diagrams (Wokwi's diagram.json)");
{
  const d = parseDiagram(JSON.stringify({
    version: 1, author: "x".repeat(500), editor: "wokwi",
    parts: [
      { id: "uno", type: "wokwi-arduino-uno", left: 10, top: "20", rotate: 45, attrs: { a: 1, "bad key": "x", long: "y".repeat(500) } },
      { id: "uno", type: "wokwi-led" },
      { id: "led 1", type: "wokwi-led" },
      { id: "led1", type: "Wokwi<LED>" },
      { id: "r1", type: "wokwi-resistor", left: 5, top: 5, rotate: 90, attrs: { value: "220" } },
    ],
    connections: [["uno:13", "r1:1", "green", ["v10", 5, "h-3"]], ["uno:13", "ghost:1", "red", []], ["nope", "r1:2"], ["r1:2", "uno:GND.1", "javascript:alert(1)"]],
  }));
  check(d.parts.map((p) => p.id).join(",") === "uno,r1", "bad ids, repeated ids and odd types are dropped");
  check(d.parts[0].rotate === 0 && d.parts[0].top === 0 && d.parts[1].rotate === 90, "only quarter turns; positions must be numbers");
  check(d.parts[0].attrs.a === "1" && !("bad key" in d.parts[0].attrs) && d.parts[0].attrs.long.length === 200, "settings become short strings with safe names");
  check(d.connections.length === 2 && d.connections[0][3].join() === "v10,h-3", "wires to unknown parts are dropped; routes keep their moves");
  check(d.connections[1][2] === "green", "a strange wire colour falls back to green");
  check(d.author.length === 100 && d.editor === "joint-agent", "author trimmed");
  let threw = false;
  try { parseDiagram("{not json"); } catch { threw = true; }
  check(threw, "not JSON: refused with a reason");
  const hostile = parseDiagram(JSON.stringify({ parts: [{ id: "a", type: "constructor" }, { id: "__proto__", type: "tostring" }, { id: "mega", type: "wokwi-arduino-mega" }], connections: [] }));
  check(boardOf(hostile)?.board.id === "mega", "a part typed \"constructor\" is not mistaken for a board");
  check(boardPin(BOARDS.uno, "constructor").kind === "none" && boardPin(BOARDS.uno, "toString").kind === "none", "pin names like \"constructor\" are no pin");
  check(boardPin(BOARDS.nano, "A6").kind === "analog-only" && boardPin(BOARDS.uno, "A4.2").pin === 18 && boardPin(BOARDS.mega, "SDA").pin === 20, "A6 analog-only on the Nano; A4.2 is pin 18; the Mega's SDA is pin 20");
  let simOk = true;
  try {
    const t = new Simulation(hostile, hex("mega_core"), { models: PART_MODELS });
    t.run(16000);
  } catch { simOk = false; }
  check(simOk, "a diagram with such names still runs");
}

console.log("Wires");
{
  const a = { x: 0, y: 0 };
  const b = { x: 50, y: 30 };
  check(JSON.stringify(wirePoints(a, b, [], "v")) === JSON.stringify([a, { x: 0, y: 30 }, b]), "no route: one turn, leaving the pin the way it faces");
  check(JSON.stringify(wirePoints(a, b, [], "h")) === JSON.stringify([a, { x: 50, y: 0 }, b]), "a side pin leaves sideways");
  check(JSON.stringify(wirePoints(a, b, ["v-10", "h20"])) === JSON.stringify([a, { x: 0, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 30 }, b]), "moves from the first pin, then a turn");
  check(JSON.stringify(wirePoints(a, b, ["h-5", "*", "v20"])) === JSON.stringify([a, { x: -5, y: 0 }, { x: -5, y: 10 }, { x: 50, y: 10 }, b]), "after *: the last moves into the second pin");
  check(JSON.stringify(wirePoints(a, { x: 0, y: 40 }, ["v10", "v10"])) === JSON.stringify([a, { x: 0, y: 40 }]), "straight runs merge into one segment");
  check(routeFrom(a, [{ x: 10, y: 0 }, { x: 10, y: 25.04 }]).join() === "h10,v25", "bends drawn by hand become Wokwi route moves");
  const across = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
  const upright = [{ x: 40, y: 0 }, { x: 40, y: 100 }];
  check(bridgedPath(across, [upright]) === "M0 50 L36 50 A4 4 0 0 1 44 50 L100 50", "a horizontal run hops over a wire it crosses, with a semicircle", bridgedPath(across, [upright]));
  check(bridgedPath([...across].reverse(), [upright]) === "M100 50 L44 50 A4 4 0 0 0 36 50 L0 50", "going the other way, the bridge still rises");
  check(bridgedPath(upright, [across]) === "M40 0 L40 100", "the crossed (vertical) wire stays straight: one bridge per crossing");
  check(bridgedPath(across, [[{ x: 40, y: 50 }, { x: 40, y: 100 }]]) === "M0 50 L100 50", "a wire that ends on it is a joint, not a crossing");
  check(bridgedPath(across, [[{ x: 2, y: 0 }, { x: 2, y: 100 }]]) === "M0 50 L100 50", "no bridge too close to a pin");
  check((bridgedPath(across, [upright, [{ x: 70, y: 0 }, { x: 70, y: 100 }]]).match(/A4/g) || []).length === 2, "two crossings, two bridges");
}

console.log("Resistor values");
check(parseOhms("220") === 220 && parseOhms("4.7k") === 4700 && parseOhms("10K") === 10000 && parseOhms("1M") === 1e6 && parseOhms("330Ω") === 330, "220, 4.7k, 10K, 1M, 330Ω");
check(parseOhms("abc", 1000) === 1000, "nonsense falls back");

console.log("Buttons, LED, potentiometer, servo, buzzer, serial (Uno)");
{
  const t0 = performance.now();
  const t = start("basic", [
    ["btnA", "wokwi-pushbutton"], ["btnB", "wokwi-pushbutton"], ["r1", "wokwi-resistor", { value: "10000" }],
    ["r2", "wokwi-resistor", { value: "220" }], ["led1", "wokwi-led", { color: "red" }], ["pot1", "wokwi-potentiometer"],
    ["servo1", "wokwi-servo"], ["bz1", "wokwi-buzzer"],
  ], [
    ["btnA:1.l", "uno:2"], ["btnA:2.l", "uno:GND.1"],
    ["btnB:1.l", "uno:4"], ["btnB:2.r", "uno:5V"], ["r1:1", "uno:4"], ["r1:2", "uno:GND.2"],
    ["uno:8", "r2:1"], ["r2:2", "led1:A"], ["led1:C", "uno:GND.3"],
    ["pot1:SIG", "uno:A0"], ["pot1:VCC", "uno:5V"], ["pot1:GND", "uno:GND.2"],
    ["servo1:PWM", "uno:9"], ["servo1:V+", "uno:5V"], ["servo1:GND", "uno:GND.1"],
    ["bz1:2", "uno:7"], ["bz1:1", "uno:GND.1"],
  ]);
  t.run(300);
  check(t.serial().includes("ready"), "the program starts and prints on Serial");
  check(t.lines().includes("btnA=1") && t.lines().includes("btnB=0"), "pull-up reads HIGH, pull-down resistor reads LOW", JSON.stringify(t.lines().slice(0, 4)));
  check(lastLine(t, "pot=") === "pot=0", "potentiometer at 0 reads 0", lastLine(t, "pot="));
  check(t.model("led1").state.brightness === 0, "LED off");
  t.sim.input("btnA", "press", true);
  t.run(100);
  check(lastLine(t, "btnA=") === "btnA=0", "pressing the button pulls pin 2 LOW");
  check(t.model("led1").state.brightness === 1, "LED lights through its resistor", String(t.model("led1").state.brightness));
  t.sim.input("btnA", "press", false);
  t.run(100);
  check(lastLine(t, "btnA=") === "btnA=1" && t.model("led1").state.brightness === 0, "released: HIGH again, LED off");
  t.sim.input("btnB", "press", true);
  t.run(100);
  check(lastLine(t, "btnB=") === "btnB=1", "button to 5V over the pull-down reads HIGH");
  t.sim.input("btnB", "press", false);
  t.run(100);
  check(lastLine(t, "btnB=") === "btnB=0", "released: the pull-down wins");
  t.sim.input("pot1", "value", 512);
  t.run(200);
  check(near(field(lastLine(t, "pot="), "pot"), 512, 2), "potentiometer at the middle reads ~512", lastLine(t, "pot="));
  check(near(t.model("servo1").state.angle, 90, 1), "servo follows: ~90°", String(t.model("servo1").state.angle));
  t.sim.input("pot1", "value", 1023);
  t.run(200);
  check(lastLine(t, "pot=") === "pot=1023", "potentiometer at the end reads 1023", lastLine(t, "pot="));
  check(near(t.model("servo1").state.angle, 180, 1), "servo at 180°", String(t.model("servo1").state.angle));
  t.sim.serialWrite("hello\n");
  t.run(200);
  check(t.lines().includes("echo:hello"), "text typed into the serial monitor reaches the program");
  t.sim.serialWrite("tone\n");
  t.run(200);
  check(near(t.model("bz1").state.frequency, 440, 2), "tone(440) sounds the buzzer at 440 Hz", String(t.model("bz1").state.frequency));
  t.sim.serialWrite("notone\n");
  t.run(200);
  check(t.model("bz1").state.frequency === 0, "noTone() silences it");
  const simMs = t.sim.timeMs;
  const wall = performance.now() - t0;
  console.log(`  info  ${simMs.toFixed(0)} ms simulated in ${wall.toFixed(0)} ms (${((simMs / wall) * 100).toFixed(0)}% of real time)`);
}

console.log("Timing, PWM and interrupts (Uno and Mega)");
for (const [board, program, pwmPin, irqPin, analog, inPin, duty] of [
  ["uno", "uno_core", "9", "2", "A0", "7", 0.5],
  ["mega", "mega_core", "44", "18", "A8", "30", 0.25],
]) {
  const t = start(program, [["led1", "wokwi-led"], ["btn1", "wokwi-pushbutton"], ["pot1", "wokwi-potentiometer", { value: "512" }]], [
    ["led1:A", `${board}:${pwmPin}`], ["led1:C", `${board}:GND.1`],
    ["btn1:1.l", `${board}:${irqPin}`], ["btn1:2.l", `${board}:GND.2`],
    ["pot1:SIG", `${board}:${analog}`], ["pot1:VCC", `${board}:5V`], ["pot1:GND", `${board}:GND.3`],
    [`${board}:${inPin}`, `${board}:5V`],
  ], { id: board, type: `wokwi-arduino-${board}` });
  const led13 = [];
  // Three presses: 400-448, 496-544 and 592-640 ms.
  const presses = { 400: true, 448: false, 496: true, 544: false, 592: true, 640: false };
  for (let ms = 0; ms < 3100; ms += 16) {
    if (ms in presses) t.sim.input("btn1", "press", presses[ms]);
    t.run(16);
    led13.push(t.sim.boardLeds.led13);
  }
  const name = board === "uno" ? "Uno" : "Mega";
  check(t.serial().startsWith(`Hello from ${name}`), `${name}: prints at start`);
  const line = lastLine(t, "t=");
  check(near(field(line, "t"), 2000, 2) || near(field(line, "t"), 3000, 2), `${name}: millis() keeps time`, line);
  check(near(field(line, board === "uno" ? "a0" : "a8"), 512, 2), `${name}: analogRead`, line);
  check(field(line, board === "uno" ? "d7" : "d30") === 1, `${name}: digitalRead of a pin wired to 5V`);
  check(field(line, "hits") === 3, `${name}: three presses, three FALLING interrupts`, line);
  check(near(t.model("led1").state.brightness, duty, 0.02), `${name}: analogWrite PWM duty ${duty * 100}% on pin ${pwmPin}`, String(t.model("led1").state.brightness));
  check(led13.some((v) => v === 1) && led13.some((v) => v === 0), `${name}: the board's own LED on pin 13 blinks`);
}

console.log("Resistor network: a 10k/10k divider, and a short");
{
  const t = start("basic", [["ra", "wokwi-resistor", { value: "10k" }], ["rb", "wokwi-resistor", { value: "10k" }]], [
    ["ra:1", "uno:5V"], ["ra:2", "uno:A0"], ["rb:1", "uno:A0"], ["rb:2", "uno:GND.1"],
  ]);
  t.run(200);
  check(near(field(lastLine(t, "pot="), "pot"), 512, 2), "A0 between two equal resistors reads ~512", lastLine(t, "pot="));
  check(!t.sim.shorted, "no short");
  const s = start("basic", [], [["uno:5V", "uno:GND.1"]]);
  check(s.sim.shorted, "5V wired to GND is flagged as a short");
}

console.log("LCD 16×2 over I2C (LiquidCrystal_I2C)");
{
  const t = start("lcd_i2c", [["lcd1", "wokwi-lcd1602", { pins: "i2c" }]], [
    ["lcd1:SDA", "uno:A4"], ["lcd1:SCL", "uno:A5"], ["lcd1:VCC", "uno:5V"], ["lcd1:GND", "uno:GND.1"],
  ]);
  // LiquidCrystal_I2C's init() waits a second before it starts.
  t.run(1600);
  const text = t.model("lcd1").lcd.text();
  check(text[0] === "Hello, Wokwi!   ", "first row", JSON.stringify(text[0]));
  check(text[1] === "\u0000 Joint Agent   ", "second row, starting with the custom character", JSON.stringify(text[1]));
  const st = t.model("lcd1").state;
  check(st.backlight === true && st.on === true, "display and backlight on");
  check(st.cgram[1] === 0b01010 && st.cgram[2] === 0b11111, "createChar() stored the heart");
  const wrong = start("lcd_i2c", [["lcd1", "wokwi-lcd1602", { pins: "i2c" }]], [["lcd1:SDA", "uno:A2"], ["lcd1:SCL", "uno:A3"]]);
  wrong.run(1600);
  check(wrong.model("lcd1").lcd.text()[0].trim() === "", "wired to the wrong pins, it shows nothing");
}

console.log("LCD 16×2 on its own pins (LiquidCrystal, 4-bit)");
{
  const t = start("lcd_par", [["lcd1", "wokwi-lcd1602"]], [
    ["lcd1:RS", "uno:12"], ["lcd1:E", "uno:11"], ["lcd1:D4", "uno:5"], ["lcd1:D5", "uno:4"], ["lcd1:D6", "uno:3"], ["lcd1:D7", "uno:2"],
    ["lcd1:RW", "uno:GND.1"], ["lcd1:VSS", "uno:GND.1"], ["lcd1:VDD", "uno:5V"], ["lcd1:A", "uno:5V"], ["lcd1:K", "uno:GND.2"],
  ]);
  t.run(500);
  const text = t.model("lcd1").lcd.text();
  check(text[0] === "hello, world!   " && text[1] === "   1234         ", "both rows", JSON.stringify(text));
  const st = t.model("lcd1").state;
  check(st.blink === true && st.cursorX === 7 && st.cursorY === 1, "blinking cursor after the text", `${st.cursorX},${st.cursorY}`);
  check(st.backlight === true, "backlight lit by A and K");
}

console.log("OLED 128×64 (Adafruit_SSD1306)");
{
  const t = start("oled", [["oled1", "wokwi-ssd1306"]], [
    ["oled1:DATA", "uno:A4"], ["oled1:CLK", "uno:A5"], ["oled1:VIN", "uno:5V"], ["oled1:GND", "uno:GND.1"],
  ]);
  t.run(500);
  check(t.serial().includes("oled ok"), "display.begin() found the display", JSON.stringify(t.serial()));
  const px = t.model("oled1").state.pixels;
  const at = (x, y) => px[y * 128 + x];
  let lit = 0;
  for (const p of px) lit += p;
  check(at(0, 0) === 1 && at(127, 63) === 1, "corner pixels where drawn");
  check(at(10, 20) === 1 && at(39, 34) === 1 && at(9, 20) === 0 && at(40, 20) === 0 && at(10, 35) === 0, "filled rectangle in place");
  check(lit === 2 + 30 * 15, "nothing else lit", String(lit));
}

console.log("NeoPixels (Adafruit_NeoPixel): ring, and single pixels chained DOUT → DIN");
{
  const t = start("neopixel", [["ring1", "wokwi-led-ring", { pixels: "16" }], ["px1", "wokwi-neopixel"], ["px2", "wokwi-neopixel"], ["px3", "wokwi-neopixel"]], [
    ["ring1:DIN", "uno:5"], ["ring1:VCC", "uno:5V"], ["ring1:GND", "uno:GND.1"],
    ["px1:DIN", "uno:6"], ["px1:DOUT", "px2:DIN"], ["px2:DOUT", "px3:DIN"],
  ]);
  t.run(100);
  const ring = t.model("ring1").state.pixels;
  const rgb = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]].join(",");
  check(rgb(ring, 0) === "255,0,0" && rgb(ring, 1) === "0,255,0" && rgb(ring, 15) === "0,0,255" && rgb(ring, 2) === "0,0,0", "ring colours", [0, 1, 2, 15].map((i) => rgb(ring, i)).join(" "));
  const chain = ["px1", "px2", "px3"].map((id) => rgb(t.model(id).state.pixels, 0));
  check(chain.join(" ") === "10,20,30 40,50,60 70,80,90", "each chained pixel takes its own colour", chain.join(" "));
}

console.log("DHT22 (DHT sensor library)");
{
  const t = start("dht", [["dht1", "wokwi-dht22", { temperature: "24", humidity: "40" }]], [
    ["dht1:SDA", "uno:2"], ["dht1:VCC", "uno:5V"], ["dht1:GND", "uno:GND.1"],
  ]);
  t.run(300);
  check(lastLine(t, "T=") === "T=24.0 H=40.0", "reads 24.0 °C and 40.0 %", JSON.stringify(t.lines()));
  t.sim.input("dht1", "temperature", -5.5);
  t.sim.input("dht1", "humidity", 75.3);
  t.run(2100);
  check(lastLine(t, "T=") === "T=-5.5 H=75.3", "below zero and a new humidity", lastLine(t, "T="));
  check(!t.serial().includes("dht fail"), "no failed reads");
}

console.log("HC-SR04 (pulseIn)");
{
  const t = start("sonar", [["us1", "wokwi-hc-sr04", { distance: "100" }]], [
    ["us1:TRIG", "uno:9"], ["us1:ECHO", "uno:10"], ["us1:VCC", "uno:5V"], ["us1:GND", "uno:GND.1"],
  ]);
  t.run(500);
  // pulseIn() counts loop turns and is itself accurate to about 1% (as on a real board).
  check(near(field(lastLine(t, "cm="), "cm"), 100, 1), "100 cm", lastLine(t, "cm="));
  t.sim.input("us1", "distance", 250);
  t.run(500);
  check(near(field(lastLine(t, "cm="), "cm"), 250, 2.5), "250 cm", lastLine(t, "cm="));
}

console.log("Membrane keypad (Keypad)");
{
  const t = start("keypad", [["kp1", "wokwi-membrane-keypad"]], [
    ["kp1:R1", "uno:9"], ["kp1:R2", "uno:8"], ["kp1:R3", "uno:7"], ["kp1:R4", "uno:6"],
    ["kp1:C1", "uno:5"], ["kp1:C2", "uno:4"], ["kp1:C3", "uno:3"], ["kp1:C4", "uno:2"],
  ]);
  t.run(100);
  const press = (row, column) => {
    t.sim.input("kp1", "key", { row, column, pressed: true });
    t.run(100);
    t.sim.input("kp1", "key", { row, column, pressed: false });
    t.run(100);
  };
  press(1, 1);
  press(3, 3);
  press(0, 0);
  check(t.lines().filter((l) => l.startsWith("key=")).join(" ") === "key=5 key=D key=1", "5, D, 1", JSON.stringify(t.lines()));
}

console.log("DS1307 clock (RTClib)");
{
  const t = start("rtc", [["rtc1", "wokwi-ds1307"]], [["rtc1:SDA", "uno:A4"], ["rtc1:SCL", "uno:A5"], ["rtc1:5V", "uno:5V"], ["rtc1:GND", "uno:GND.1"]]);
  t.run(2600);
  const lines = t.lines();
  check(lines[0] === "running", "the clock runs from the start", JSON.stringify(lines));
  check(lines[1]?.startsWith(`now=${new Date().getFullYear()}-`), "it starts at today's date", lines[1]);
  check(lines[2] === "now=2024-01-02 03:04:07", "adjust() sets it; it keeps time", lines[2]);
}

console.log("Sensors: photoresistor, NTC, joystick, PIR, rotary encoder");
{
  const t = start("sensors", [
    ["ldr1", "wokwi-photoresistor-sensor"], ["ntc1", "wokwi-ntc-temperature-sensor"], ["joy1", "wokwi-analog-joystick"],
    ["pir1", "wokwi-pir-motion-sensor", { delayTime: "1" }], ["enc1", "wokwi-ky-040"],
  ], [
    ["ldr1:AO", "uno:A0"], ["ldr1:DO", "uno:5"], ["ldr1:VCC", "uno:5V"], ["ldr1:GND", "uno:GND.1"],
    ["ntc1:OUT", "uno:A1"], ["ntc1:VCC", "uno:5V"], ["ntc1:GND", "uno:GND.1"],
    ["joy1:HORZ", "uno:A2"], ["joy1:VERT", "uno:A3"], ["joy1:SEL", "uno:6"], ["joy1:VCC", "uno:5V"], ["joy1:GND", "uno:GND.2"],
    ["pir1:OUT", "uno:7"], ["pir1:VCC", "uno:5V"], ["pir1:GND", "uno:GND.2"],
    ["enc1:CLK", "uno:2"], ["enc1:DT", "uno:3"], ["enc1:SW", "uno:4"], ["enc1:VCC", "uno:5V"], ["enc1:GND", "uno:GND.3"],
  ]);
  t.run(300);
  let l = lastLine(t, "lux=");
  check(near(field(l, "lux"), 500, 5), "500 lux reads back as ~500 with Wokwi's formula", l);
  check(near(field(l, "temp"), 24, 0.15), "24 °C reads back with the NTC formula");
  check(near(field(l, "x"), 512, 2) && near(field(l, "y"), 512, 2), "joystick centred: 512, 512");
  check(field(l, "pir") === 0 && field(l, "sel") === 1 && field(l, "do") === 0 && field(l, "enc") === 0 && field(l, "sw") === 1, "idle: no motion, not pressed, bright");
  t.sim.input("ldr1", "lux", 1);
  t.sim.input("ntc1", "temperature", 80);
  t.sim.input("joy1", "x", 1);
  t.sim.input("joy1", "y", -1);
  t.sim.input("joy1", "press", true);
  t.sim.input("pir1", "motion", true);
  t.sim.input("enc1", "rotate", 1);
  t.sim.input("enc1", "rotate", 1);
  t.sim.input("enc1", "press", true);
  t.run(300);
  l = lastLine(t, "lux=");
  check(near(field(l, "lux"), 1, 0.2) && field(l, "do") === 1, "dark: ~1 lux, DO goes HIGH", l);
  check(near(field(l, "temp"), 80, 0.5), "80 °C");
  check(field(l, "x") >= 1021 && field(l, "y") <= 2 && field(l, "sel") === 0, "joystick left and down, pressed");
  check(field(l, "pir") === 1, "motion: PIR OUT HIGH");
  check(field(l, "enc") === 2 && field(l, "sw") === 0, "two clockwise steps, knob pressed");
  t.sim.input("enc1", "rotate", -1);
  t.run(1200);
  l = lastLine(t, "lux=");
  check(field(l, "enc") === 1, "one step back");
  check(field(l, "pir") === 0, "PIR OUT LOW again after its delay time");
}

console.log("7-segment displays: one digit (common anode), four multiplexed (common cathode)");
{
  const seg = ["A", "B", "C", "D", "E", "F", "G"];
  const t = start("seg7", [["sg1", "wokwi-7segment"], ["sg4", "wokwi-7segment", { digits: "4", common: "cathode" }]], [
    ["sg1:COM.1", "uno:5V"], ...seg.map((s, i) => [`sg1:${s}`, `uno:${2 + i}`]),
    ...["A0", "A1", "A2", "A3", "A4", "A5", "13"].map((p, i) => [`sg4:${seg[i]}`, `uno:${p}`]),
    ...[1, 2, 3, 4].map((d) => [`sg4:DIG${d}`, `uno:${8 + d}`]),
  ]);
  t.run(200);
  check(t.model("sg1").state.values.join("") === "01100000", "single digit shows 1", t.model("sg1").state.values.join(""));
  const v = t.model("sg4").state.values;
  const digits = [0, 1, 2, 3].map((d) => v.slice(d * 8, d * 8 + 7).join(""));
  check(digits.join(" ") === "0110000 1101101 1111001 0110011", "four digits show 1 2 3 4", digits.join(" "));
}

console.log("Mega: LCD 20×4 on SDA/SCL (pins 20, 21), NeoPixel matrix, button, analog A8");
{
  const t = start("mega_mix", [
    ["lcd1", "wokwi-lcd2004", { pins: "i2c" }], ["mx1", "wokwi-neopixel-matrix", { rows: "8", cols: "8" }],
    ["btn1", "wokwi-pushbutton"], ["pot1", "wokwi-potentiometer", { value: "300" }],
  ], [
    ["lcd1:SDA", "mega:20"], ["lcd1:SCL", "mega:21"], ["lcd1:VCC", "mega:5V"], ["lcd1:GND", "mega:GND.1"],
    ["mx1:DIN", "mega:6"], ["mx1:VCC", "mega:5V"], ["mx1:GND", "mega:GND.2"],
    ["btn1:1.l", "mega:22"], ["btn1:2.l", "mega:GND.4"],
    ["pot1:SIG", "mega:A8"], ["pot1:VCC", "mega:5V"], ["pot1:GND", "mega:GND.5"],
  ], { id: "mega", type: "wokwi-arduino-mega" });
  t.run(1800);
  check(t.serial().includes("mega ready"), "the program runs and prints");
  check(near(field(lastLine(t, "b22="), "a8"), 300, 2) && field(lastLine(t, "b22="), "b22") === 1, "A8 reads the potentiometer; pin 22 HIGH", lastLine(t, "b22="));
  const text = t.model("lcd1").lcd.text().map((r) => r.trimEnd());
  check(text.join("|") === "Row zero|Row one|Row two|Row three", "all four rows", JSON.stringify(text));
  const p = t.model("mx1").state.pixels;
  check(p.slice(0, 3).join(",") === "255,0,0" && p.slice(63 * 3, 64 * 3).join(",") === "0,0,255", "first pixel red, last blue");
  t.sim.input("btn1", "press", true);
  t.run(100);
  check(field(lastLine(t, "b22="), "b22") === 0, "button on pin 22");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll simulator checks passed");
process.exit(bad ? 1 : 0);
