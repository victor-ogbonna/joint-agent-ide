/**
 * The parts the agent builds circuits from: a short key, the drawing it is,
 * its pins exactly as the drawing names them, and the settings it may give.
 * Shared by the server (the agent's instructions) and the app (turning the
 * agent's circuit into a diagram), so the two never disagree. Pure data: no
 * DOM, so the server can read it.
 */
import type { BoardId } from "./boards";

export interface AgentPart {
  /** What the agent writes as a part's type. */
  key: string;
  /** The drawing (diagram part type). */
  type: string;
  name: string;
  /** Every pin, as the drawing names it. */
  pins: string[];
  /** What some pins are, for the agent. */
  pinNotes?: string;
  /** Settings every new one starts with. */
  attrs?: Record<string, string>;
  /** Settings the agent may give: name → what values. */
  settings?: Record<string, string>;
  /** For a new id: "led" → led1, led2... */
  prefix: string;
}

const COLOURS = "red, green, blue, yellow, orange, white or purple";

export const AGENT_PARTS: AgentPart[] = [
  { key: "led", type: "wokwi-led", name: "LED", prefix: "led", pins: ["A", "C"], pinNotes: "A = anode (+, the long leg), C = cathode (−)", attrs: { color: "red" }, settings: { color: COLOURS } },
  { key: "rgb-led", type: "wokwi-rgb-led", name: "RGB LED", prefix: "rgb", pins: ["R", "G", "B", "COM"], pinNotes: "COM is the common pin: to GND when common is cathode, to 5V/3V3 when anode", attrs: { common: "cathode" }, settings: { common: "cathode or anode" } },
  { key: "resistor", type: "wokwi-resistor", name: "Resistor", prefix: "r", pins: ["1", "2"], attrs: { value: "220" }, settings: { value: "ohms, e.g. 220, 1000, 10000" } },
  { key: "led-bar-graph", type: "wokwi-led-bar-graph", name: "LED bar graph (10)", prefix: "bargraph", pins: [...Array.from({ length: 10 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `C${i + 1}`)], pinNotes: "A1-A10 anodes, C1-C10 cathodes", attrs: { color: "red" } },
  { key: "pushbutton", type: "wokwi-pushbutton", name: "Pushbutton", prefix: "btn", pins: ["1.l", "2.l", "1.r", "2.r"], pinNotes: "1.l and 1.r are one side, 2.l and 2.r the other; pressing joins 1 to 2. Wire 1.l to the board pin and 2.l to GND (use INPUT_PULLUP)", attrs: { color: "green" }, settings: { color: "red, green, blue, yellow, black, white or grey" } },
  { key: "slide-switch", type: "wokwi-slide-switch", name: "Slide switch", prefix: "sw", pins: ["1", "2", "3"], pinNotes: "2 is the common pin; it joins 1 or 3" },
  { key: "dip-switch-8", type: "wokwi-dip-switch-8", name: "DIP switch (8)", prefix: "dip", pins: [...Array.from({ length: 8 }, (_, i) => `${i + 1}a`), ...Array.from({ length: 8 }, (_, i) => `${i + 1}b`)], pinNotes: "switch n joins na to nb" },
  { key: "potentiometer", type: "wokwi-potentiometer", name: "Potentiometer", prefix: "pot", pins: ["GND", "SIG", "VCC"], pinNotes: "SIG to an analog pin" },
  { key: "slide-potentiometer", type: "wokwi-slide-potentiometer", name: "Slide potentiometer", prefix: "pot", pins: ["VCC", "SIG", "GND"], attrs: { travelLength: "30" } },
  { key: "joystick", type: "wokwi-analog-joystick", name: "Analog joystick", prefix: "joystick", pins: ["VCC", "VERT", "HORZ", "SEL", "GND"], pinNotes: "VERT and HORZ to analog pins; SEL is the push button (to GND when pressed: INPUT_PULLUP)" },
  { key: "keypad", type: "wokwi-membrane-keypad", name: "Membrane keypad 4×4", prefix: "keypad", pins: ["R1", "R2", "R3", "R4", "C1", "C2", "C3", "C4"], attrs: { columns: "4" } },
  { key: "rotary-encoder", type: "wokwi-ky-040", name: "Rotary encoder (KY-040)", prefix: "encoder", pins: ["CLK", "DT", "SW", "VCC", "GND"] },
  { key: "tilt-switch", type: "wokwi-tilt-switch", name: "Tilt switch", prefix: "tilt", pins: ["GND", "VCC", "OUT"] },
  { key: "buzzer", type: "wokwi-buzzer", name: "Buzzer", prefix: "bz", pins: ["1", "2"], pinNotes: "2 is + (to the board pin), 1 is − (to GND)" },
  { key: "servo", type: "wokwi-servo", name: "Servo motor", prefix: "servo", pins: ["GND", "V+", "PWM"], attrs: { horn: "single" } },
  { key: "neopixel", type: "wokwi-neopixel", name: "NeoPixel (WS2812, one)", prefix: "pixel", pins: ["VDD", "DOUT", "VSS", "DIN"], pinNotes: "VSS is GND; DOUT feeds the next one's DIN" },
  { key: "neopixel-ring", type: "wokwi-led-ring", name: "NeoPixel ring", prefix: "ring", pins: ["GND", "VCC", "DIN", "DOUT"], attrs: { pixels: "16" }, settings: { pixels: "8, 12, 16, 24 or 32" } },
  { key: "neopixel-strip", type: "wokwi-neopixel-matrix", name: "NeoPixel strip", prefix: "strip", pins: ["GND", "VCC", "DIN", "DOUT"], attrs: { rows: "1", cols: "8" }, settings: { cols: "pixels, 1-64" } },
  { key: "neopixel-matrix", type: "wokwi-neopixel-matrix", name: "NeoPixel matrix", prefix: "matrix", pins: ["GND", "VCC", "DIN", "DOUT"], attrs: { rows: "8", cols: "8" }, settings: { rows: "1-32", cols: "1-32" } },
  { key: "7segment", type: "wokwi-7segment", name: "7-segment display (one digit)", prefix: "sevseg", pins: ["A", "B", "C", "D", "E", "F", "G", "DP", "COM.1", "COM.2"], pinNotes: "COM.1 and COM.2 are the same common pin", attrs: { digits: "1", common: "anode", color: "red" }, settings: { common: "anode (COM to 5V) or cathode (COM to GND)" } },
  { key: "7segment-4", type: "wokwi-7segment", name: "7-segment display (four digits)", prefix: "sevseg", pins: ["A", "B", "C", "D", "E", "F", "G", "DP", "DIG1", "DIG2", "DIG3", "DIG4", "CLN"], pinNotes: "DIG1-DIG4 are each digit's common pin; CLN the colon", attrs: { digits: "4", common: "anode", color: "red" }, settings: { common: "anode or cathode" } },
  { key: "lcd1602-i2c", type: "wokwi-lcd1602", name: "LCD 16×2 with I2C backpack (LiquidCrystal_I2C, address 0x27)", prefix: "lcd", pins: ["GND", "VCC", "SDA", "SCL"], attrs: { pins: "i2c" } },
  { key: "lcd1602", type: "wokwi-lcd1602", name: "LCD 16×2 on its own pins (LiquidCrystal)", prefix: "lcd", pins: ["VSS", "VDD", "V0", "RS", "RW", "E", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "A", "K"], pinNotes: "VSS GND, VDD 5V, RW to GND; in 4-bit mode wire D4-D7 only; A/K the backlight", attrs: { pins: "full" } },
  { key: "lcd2004-i2c", type: "wokwi-lcd2004", name: "LCD 20×4 with I2C backpack (address 0x27)", prefix: "lcd", pins: ["GND", "VCC", "SDA", "SCL"], attrs: { pins: "i2c" } },
  { key: "oled", type: "wokwi-ssd1306", name: "OLED 128×64 SSD1306 (I2C, address 0x3C)", prefix: "oled", pins: ["DATA", "CLK", "DC", "RST", "CS", "3V3", "VIN", "GND"], pinNotes: "I2C: DATA is SDA and CLK is SCL; power VIN and GND; leave DC, RST, CS unwired" },
  { key: "dht22", type: "wokwi-dht22", name: "DHT22 temperature & humidity", prefix: "dht", pins: ["VCC", "SDA", "NC", "GND"], pinNotes: "SDA is the data pin", attrs: { temperature: "24", humidity: "40" } },
  { key: "dht11", type: "wokwi-dht22", name: "DHT11 temperature & humidity", prefix: "dht", pins: ["VCC", "SDA", "NC", "GND"], pinNotes: "SDA is the data pin", attrs: { sensor: "dht11", temperature: "24", humidity: "40" } },
  { key: "ultrasonic", type: "wokwi-hc-sr04", name: "HC-SR04 ultrasonic distance", prefix: "ultrasonic", pins: ["VCC", "TRIG", "ECHO", "GND"], attrs: { distance: "100" } },
  { key: "pir", type: "wokwi-pir-motion-sensor", name: "PIR motion sensor", prefix: "pir", pins: ["VCC", "OUT", "GND"] },
  { key: "ldr", type: "wokwi-photoresistor-sensor", name: "Photoresistor (LDR) module", prefix: "ldr", pins: ["VCC", "GND", "DO", "AO"], pinNotes: "AO to an analog pin; DO is high in the dark" },
  { key: "ntc", type: "wokwi-ntc-temperature-sensor", name: "NTC thermistor module", prefix: "ntc", pins: ["GND", "VCC", "OUT"], pinNotes: "OUT to an analog pin" },
  { key: "rtc", type: "wokwi-ds1307", name: "Real-time clock DS1307 (I2C)", prefix: "rtc", pins: ["GND", "5V", "SDA", "SCL", "SQW"] },
];

/** A part the agent named, by its key. */
export function agentPartFor(key: string): AgentPart | undefined {
  return AGENT_PARTS.find((p) => p.key === key);
}

/** The board's pins the agent may wire to, by board. Names as the drawing has them. */
export const BOARD_PIN_NAMES: Record<BoardId, string[]> = {
  uno: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "A0", "A1", "A2", "A3", "A4", "A5", "A4.2", "A5.2", "AREF", "IOREF", "RESET", "3.3V", "5V", "VIN", "GND.1", "GND.2", "GND.3"],
  nano: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "12.2", "13.2", "11.2", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "AREF", "RESET", "RESET.2", "RESET.3", "3.3V", "5V", "5V.2", "VIN", "GND.1", "GND.2", "GND.3"],
  mega: [...Array.from({ length: 54 }, (_, i) => String(i)), ...Array.from({ length: 16 }, (_, i) => `A${i}`), "SDA", "SCL", "AREF", "IOREF", "RESET", "3.3V", "5V", "5V.1", "5V.2", "VIN", "GND.1", "GND.2", "GND.3", "GND.4", "GND.5"],
  esp32: ["VIN", "GND.1", "GND.2", "3V3", "EN", "VP", "VN", "D34", "D35", "D32", "D33", "D25", "D26", "D27", "D14", "D12", "D13", "D23", "D22", "TX0", "RX0", "D21", "D19", "D18", "D5", "TX2", "RX2", "D4", "D2", "D15"],
};

/**
 * A board pin as the agent (or an old schematic) may name it → the drawing's
 * own name, or null when the board has no such pin. Takes "D13", "13",
 * "GPIO13", "GND", "3V3"/"3.3V", "5V", "SDA"/"SCL" and the like.
 */
export function boardPinName(board: BoardId, raw: string): string | null {
  const names = BOARD_PIN_NAMES[board];
  const has = (n: string) => names.includes(n);
  let name = String(raw ?? "").trim();
  if (!name) return null;
  if (has(name)) return name;
  const up = name.toUpperCase().replace(/\s+/g, "");
  if (up === "GND" || up === "VSS" || up === "GROUND") return has("GND.1") ? "GND.1" : null;
  const esp = board === "esp32";
  if (up === "3V3" || up === "3.3V" || up === "3.3" || up === "VCC3V3") return esp ? "3V3" : "3.3V";
  if (up === "5V" || up === "VCC" || up === "+5V") return esp ? "VIN" : "5V";
  if (up === "VIN") return "VIN";
  if (up === "SDA" || up === "SCL") {
    if (board === "mega") return up;
    if (esp) return up === "SDA" ? "D21" : "D22";
    return up === "SDA" ? "A4" : "A5";
  }
  if (esp) {
    for (const n of ["TX0", "RX0", "TX2", "RX2", "VP", "VN", "EN"]) if (up === n) return n;
    if (up === "TX" || up === "TXD") return "TX0";
    if (up === "RX" || up === "RXD") return "RX0";
    const m = /^(?:D|GPIO|IO|G)?(\d{1,2})$/.exec(up);
    if (!m) return null;
    const gpio = Number(m[1]);
    const named: Record<number, string> = { 1: "TX0", 3: "RX0", 17: "TX2", 16: "RX2", 36: "VP", 39: "VN" };
    const n = named[gpio] ?? `D${gpio}`;
    return has(n) ? n : null;
  }
  if (up === "TX" || up === "TXD") return "1";
  if (up === "RX" || up === "RXD") return "0";
  const a = /^A(\d{1,2})$/.exec(up);
  if (a) return has(`A${Number(a[1])}`) ? `A${Number(a[1])}` : null;
  const d = /^(?:D|PIN|GPIO)?(\d{1,2})$/.exec(up);
  if (d) return has(String(Number(d[1]))) ? String(Number(d[1])) : null;
  return null;
}
