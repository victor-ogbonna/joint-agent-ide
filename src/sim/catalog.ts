/**
 * The parts the workspace offers: names, where they sit in the library,
 * the settings a new one starts with, the settings the side panel edits,
 * and the controls a sensor shows while the simulation runs.
 */

export type Category = "Basic" | "Input" | "Output" | "Displays" | "Sensors";
export const CATEGORIES: Category[] = ["Basic", "Input", "Output", "Displays", "Sensors"];

export interface PropSpec {
  key: string;
  label: string;
  kind: "select" | "number" | "text";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** Shown next to the value: "Ω", "s". */
  unit?: string;
  /** Changing it changes the part's pins (so wires may need checking). */
  pins?: boolean;
}

export interface LiveSpec {
  /** The input the part's model takes. */
  input: string;
  label: string;
  kind: "slider" | "log-slider" | "button" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** The setting the starting value comes from. */
  attr?: string;
  fallback?: number;
}

export interface PartSpec {
  /** A library entry's own key (several can share a type: LCD and LCD over I2C). */
  key: string;
  type: string;
  name: string;
  category: Category;
  /** For new ids: "led" → led1, led2... */
  prefix: string;
  attrs?: Record<string, string>;
  props?: PropSpec[];
  live?: LiveSpec[];
  keywords?: string;
}

const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const COLOURS = opts("red", "green", "blue", "yellow", "orange", "white", "purple");
const BUTTON_COLOURS = opts("red", "green", "blue", "yellow", "black", "white", "grey");

export const PARTS: PartSpec[] = [
  { key: "led", type: "wokwi-led", name: "LED", category: "Basic", prefix: "led", attrs: { color: "red" }, props: [{ key: "color", label: "Colour", kind: "select", options: COLOURS }], keywords: "light diode" },
  { key: "rgb-led", type: "wokwi-rgb-led", name: "RGB LED", category: "Basic", prefix: "rgb", attrs: { common: "cathode" }, props: [{ key: "common", label: "Common pin", kind: "select", options: [{ value: "cathode", label: "Cathode (−)" }, { value: "anode", label: "Anode (+)" }] }], keywords: "colour light" },
  { key: "resistor", type: "wokwi-resistor", name: "Resistor", category: "Basic", prefix: "r", attrs: { value: "220" }, props: [{ key: "value", label: "Resistance", kind: "text", unit: "Ω" }], keywords: "ohm pull-up pull-down" },
  { key: "led-bar-graph", type: "wokwi-led-bar-graph", name: "LED bar graph", category: "Basic", prefix: "bargraph", attrs: { color: "red" }, props: [{ key: "color", label: "Colour", kind: "select", options: opts("red", "green", "blue", "yellow", "lime", "purple") }], keywords: "level meter" },

  { key: "pushbutton", type: "wokwi-pushbutton", name: "Pushbutton", category: "Input", prefix: "btn", attrs: { color: "green" }, props: [{ key: "color", label: "Colour", kind: "select", options: BUTTON_COLOURS }, { key: "key", label: "Keyboard key", kind: "text" }], keywords: "switch tactile press" },
  { key: "pushbutton-6mm", type: "wokwi-pushbutton-6mm", name: "Pushbutton (6 mm)", category: "Input", prefix: "btn", attrs: { color: "red" }, props: [{ key: "color", label: "Colour", kind: "select", options: BUTTON_COLOURS }, { key: "key", label: "Keyboard key", kind: "text" }], keywords: "switch tactile small" },
  { key: "slide-switch", type: "wokwi-slide-switch", name: "Slide switch", category: "Input", prefix: "sw", keywords: "toggle spdt" },
  { key: "dip-switch-8", type: "wokwi-dip-switch-8", name: "DIP switch (8)", category: "Input", prefix: "dip", keywords: "switches" },
  { key: "potentiometer", type: "wokwi-potentiometer", name: "Potentiometer", category: "Input", prefix: "pot", attrs: { value: "0" }, props: [{ key: "value", label: "Start position", kind: "number", min: 0, max: 1023, step: 1 }], keywords: "knob variable resistor analog" },
  { key: "slide-potentiometer", type: "wokwi-slide-potentiometer", name: "Slide potentiometer", category: "Input", prefix: "pot", attrs: { travelLength: "30" }, props: [{ key: "travelLength", label: "Length", kind: "select", options: [{ value: "15", label: "15 mm" }, { value: "30", label: "30 mm" }, { value: "45", label: "45 mm" }, { value: "60", label: "60 mm" }] }], keywords: "fader slider analog" },
  { key: "analog-joystick", type: "wokwi-analog-joystick", name: "Analog joystick", category: "Input", prefix: "joystick", keywords: "thumb stick xy" },
  { key: "membrane-keypad", type: "wokwi-membrane-keypad", name: "Membrane keypad", category: "Input", prefix: "keypad", attrs: { columns: "4" }, props: [{ key: "columns", label: "Columns", kind: "select", options: [{ value: "4", label: "4 × 4" }, { value: "3", label: "4 × 3" }], pins: true }], keywords: "keys matrix 4x4 4x3" },
  { key: "ky-040", type: "wokwi-ky-040", name: "Rotary encoder (KY-040)", category: "Input", prefix: "encoder", keywords: "knob rotary" },
  { key: "tilt-switch", type: "wokwi-tilt-switch", name: "Tilt switch", category: "Input", prefix: "tilt", live: [{ input: "tilt", label: "Tilted", kind: "toggle" }], keywords: "ball sw-520d" },

  { key: "buzzer", type: "wokwi-buzzer", name: "Buzzer", category: "Output", prefix: "bz", keywords: "piezo sound tone speaker" },
  { key: "servo", type: "wokwi-servo", name: "Servo motor", category: "Output", prefix: "servo", attrs: { horn: "single" }, props: [{ key: "horn", label: "Horn", kind: "select", options: opts("single", "double", "cross") }], keywords: "sg90 motor angle" },
  { key: "neopixel", type: "wokwi-neopixel", name: "NeoPixel (WS2812)", category: "Output", prefix: "pixel", keywords: "rgb addressable ws2812b" },
  { key: "led-ring", type: "wokwi-led-ring", name: "NeoPixel ring", category: "Output", prefix: "ring", attrs: { pixels: "16" }, props: [{ key: "pixels", label: "Pixels", kind: "select", options: ["8", "12", "16", "24", "32"].map((v) => ({ value: v, label: v })), pins: true }], keywords: "ws2812 circle" },
  { key: "neopixel-strip", type: "wokwi-neopixel-matrix", name: "NeoPixel strip", category: "Output", prefix: "strip", attrs: { rows: "1", cols: "8" }, props: [{ key: "cols", label: "Pixels", kind: "number", min: 1, max: 64, step: 1, pins: true }], keywords: "ws2812 strip line" },
  { key: "neopixel-matrix", type: "wokwi-neopixel-matrix", name: "NeoPixel matrix", category: "Output", prefix: "matrix", attrs: { rows: "8", cols: "8" }, props: [{ key: "rows", label: "Rows", kind: "number", min: 1, max: 32, step: 1, pins: true }, { key: "cols", label: "Columns", kind: "number", min: 1, max: 32, step: 1, pins: true }], keywords: "ws2812 grid panel" },

  { key: "7segment", type: "wokwi-7segment", name: "7-segment display", category: "Displays", prefix: "sevseg", attrs: { digits: "1", common: "anode", color: "red" }, props: [
    { key: "digits", label: "Digits", kind: "select", options: ["1", "2", "3", "4"].map((v) => ({ value: v, label: v })), pins: true },
    { key: "common", label: "Common pin", kind: "select", options: [{ value: "anode", label: "Anode (+)" }, { value: "cathode", label: "Cathode (−)" }] },
    { key: "color", label: "Colour", kind: "select", options: opts("red", "green", "blue", "yellow", "white") },
  ], keywords: "seven segment digit number" },
  { key: "lcd1602", type: "wokwi-lcd1602", name: "LCD 16×2", category: "Displays", prefix: "lcd", attrs: { pins: "full" }, props: [
    { key: "pins", label: "Connection", kind: "select", options: [{ value: "full", label: "Own pins (LiquidCrystal)" }, { value: "i2c", label: "I2C backpack" }], pins: true },
    { key: "i2cAddress", label: "I2C address", kind: "select", options: ["0x27", "0x3F"].map((v) => ({ value: v, label: v })) },
    { key: "background", label: "Backlight", kind: "select", options: opts("green", "blue") },
  ], keywords: "hd44780 character liquidcrystal" },
  { key: "lcd1602-i2c", type: "wokwi-lcd1602", name: "LCD 16×2 (I2C)", category: "Displays", prefix: "lcd", attrs: { pins: "i2c" }, props: [
    { key: "pins", label: "Connection", kind: "select", options: [{ value: "full", label: "Own pins (LiquidCrystal)" }, { value: "i2c", label: "I2C backpack" }], pins: true },
    { key: "i2cAddress", label: "I2C address", kind: "select", options: ["0x27", "0x3F"].map((v) => ({ value: v, label: v })) },
    { key: "background", label: "Backlight", kind: "select", options: opts("green", "blue") },
  ], keywords: "pcf8574 liquidcrystal_i2c character" },
  { key: "lcd2004", type: "wokwi-lcd2004", name: "LCD 20×4 (I2C)", category: "Displays", prefix: "lcd", attrs: { pins: "i2c" }, props: [
    { key: "pins", label: "Connection", kind: "select", options: [{ value: "full", label: "Own pins (LiquidCrystal)" }, { value: "i2c", label: "I2C backpack" }], pins: true },
    { key: "i2cAddress", label: "I2C address", kind: "select", options: ["0x27", "0x3F"].map((v) => ({ value: v, label: v })) },
    { key: "background", label: "Backlight", kind: "select", options: opts("green", "blue") },
  ], keywords: "hd44780 character 2004" },
  { key: "ssd1306", type: "wokwi-ssd1306", name: "OLED 128×64 (SSD1306)", category: "Displays", prefix: "oled", props: [{ key: "i2cAddress", label: "I2C address", kind: "select", options: ["0x3c", "0x3d"].map((v) => ({ value: v, label: v.toUpperCase().replace("0X", "0x") })) }], keywords: "screen i2c graphics" },

  { key: "dht22", type: "wokwi-dht22", name: "DHT22 temperature & humidity", category: "Sensors", prefix: "dht", attrs: { temperature: "24", humidity: "40" }, live: [
    { input: "temperature", label: "Temperature", kind: "slider", min: -40, max: 80, step: 0.1, unit: "°C", attr: "temperature", fallback: 24 },
    { input: "humidity", label: "Humidity", kind: "slider", min: 0, max: 100, step: 0.1, unit: "%", attr: "humidity", fallback: 40 },
  ], keywords: "am2302 weather" },
  { key: "hc-sr04", type: "wokwi-hc-sr04", name: "HC-SR04 ultrasonic distance", category: "Sensors", prefix: "ultrasonic", attrs: { distance: "100" }, live: [{ input: "distance", label: "Distance", kind: "slider", min: 2, max: 400, step: 1, unit: "cm", attr: "distance", fallback: 400 }], keywords: "sonar range echo" },
  { key: "pir", type: "wokwi-pir-motion-sensor", name: "PIR motion sensor", category: "Sensors", prefix: "pir", attrs: { delayTime: "5" }, props: [{ key: "delayTime", label: "Stays on for", kind: "number", min: 1, max: 300, step: 1, unit: "s" }], live: [{ input: "motion", label: "Simulate motion", kind: "button" }], keywords: "hc-sr501 movement" },
  { key: "photoresistor", type: "wokwi-photoresistor-sensor", name: "Photoresistor (LDR) module", category: "Sensors", prefix: "ldr", attrs: { lux: "500" }, live: [{ input: "lux", label: "Light", kind: "log-slider", min: 0.1, max: 100000, unit: "lux", attr: "lux", fallback: 500 }], keywords: "light sensor ldr" },
  { key: "ntc", type: "wokwi-ntc-temperature-sensor", name: "NTC temperature sensor", category: "Sensors", prefix: "ntc", attrs: { temperature: "24" }, live: [{ input: "temperature", label: "Temperature", kind: "slider", min: -24, max: 80, step: 0.1, unit: "°C", attr: "temperature", fallback: 24 }], keywords: "thermistor analog" },
  { key: "ds1307", type: "wokwi-ds1307", name: "Real-time clock (DS1307)", category: "Sensors", prefix: "rtc", keywords: "rtc time date i2c" },
];

/** The library entry for a part already placed (its type and connection). */
export function specFor(type: string, attrs: Record<string, string> = {}): PartSpec | undefined {
  if (type === "wokwi-lcd1602") return PARTS.find((p) => p.key === (attrs.pins === "i2c" ? "lcd1602-i2c" : "lcd1602"));
  if (type === "wokwi-neopixel-matrix") return PARTS.find((p) => p.key === (attrs.rows === "1" ? "neopixel-strip" : "neopixel-matrix"));
  return PARTS.find((p) => p.type === type);
}

export const BOARD_PARTS = [
  { id: "uno", type: "wokwi-arduino-uno", name: "Arduino Uno" },
  { id: "nano", type: "wokwi-arduino-nano", name: "Arduino Nano" },
  { id: "mega", type: "wokwi-arduino-mega", name: "Arduino Mega 2560" },
] as const;

/** Wire colours, as Wokwi names them. */
export const WIRE_COLOURS = ["green", "red", "black", "blue", "yellow", "orange", "purple", "white", "gray", "brown", "cyan", "magenta"];

/** A fresh id for a new part: "led" → the first free of led1, led2... */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
