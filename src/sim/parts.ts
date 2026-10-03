/**
 * How each part behaves in a running circuit: what it does with the
 * voltages on its pins, and what it drives back. Each model keeps what the
 * workspace shows in `state`; the drawing itself is @wokwi/elements.
 *
 * Behaviour and settings (attrs) follow Wokwi's parts, so a Wokwi diagram
 * and sketch behave the same here.
 */
import { PartModel, isHigh, type NetValue, type PartApi, type PartFactory } from "./circuit";
import { Hd44780, Pcf8574, Ssd1306, Ds1307 } from "./displays";

const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "220", "4.7k", "10K", "1M", "330Ω" → ohms. */
export function parseOhms(text: string | undefined, fallback = 1000): number {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*(Ω|ohms?)?\s*$/.exec(text ?? "");
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return n * (m[2] === "k" || m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "m" ? 1e6 : 1);
}

/** Volts across two pins, or null when either floats. */
function across(api: PartApi, plus: string, minus: string): number | null {
  const a = api.value(plus);
  const b = api.value(minus);
  return a.v === null || b.v === null ? null : a.v - b.v;
}

/** A part's supply: fine unless its VCC or GND is wired somewhere it shouldn't be. */
function powered(api: PartApi, vcc = "VCC", gnd = "GND"): boolean {
  if (api.wired(vcc) && !isHigh(api.value(vcc))) return false;
  if (api.wired(gnd) && api.value(gnd).v !== null && (api.value(gnd).v as number) > 1) return false;
  return true;
}

/** How long something has been on, between frames. */
class Duty {
  private on = false;
  private since = 0;
  private onCycles = 0;
  private last = 0;
  set(on: boolean, now: number) {
    if (on === this.on) return;
    if (this.on) this.onCycles += now - this.since;
    this.on = on;
    this.since = now;
  }
  /** The fraction of time on since the last read. */
  read(now: number): number {
    if (this.on) { this.onCycles += now - this.since; this.since = now; }
    const span = now - this.last;
    this.last = now;
    const f = span > 0 ? Math.min(1, this.onCycles / span) : (this.on ? 1 : 0);
    this.onCycles = 0;
    return f;
  }
}

/** Like Duty, smoothed over about 20 ms, as an eye sees a multiplexed display. */
class Persistence {
  private duty = new Duty();
  private avg = 0;
  set(on: boolean, now: number) { this.duty.set(on, now); }
  read(now: number, spanCycles: number, hz: number): number {
    const f = this.duty.read(now);
    const k = Math.exp(-spanCycles / (0.02 * hz));
    this.avg = this.avg * k + f * (1 - k);
    return this.avg;
  }
}

// ---- Lights ----

class Led extends PartModel {
  static pins = ["A", "C"];
  state = { brightness: 0 };
  private duty = new Duty();
  start() { this.update(); }
  pinChanged() { this.update(); }
  private update() {
    const v = across(this.api, "A", "C");
    this.duty.set(v !== null && v > 1.5, this.api.now());
  }
  frame() {
    const b = this.duty.read(this.api.now());
    if (Math.abs(b - this.state.brightness) > 0.01 || (b === 0) !== (this.state.brightness === 0)) {
      this.state = { brightness: b };
      this.changed();
    }
  }
}

class RgbLed extends PartModel {
  static pins = ["R", "G", "B", "COM"];
  state = { r: 0, g: 0, b: 0 };
  private duty = [new Duty(), new Duty(), new Duty()];
  private anode = (this.api.attrs.common ?? "cathode") === "anode";
  start() { this.update(); }
  pinChanged() { this.update(); }
  private update() {
    const now = this.api.now();
    ["R", "G", "B"].forEach((pin, i) => {
      const v = this.anode ? across(this.api, "COM", pin) : across(this.api, pin, "COM");
      this.duty[i].set(v !== null && v > 1.5, now);
    });
  }
  frame() {
    const now = this.api.now();
    const [r, g, b] = this.duty.map((d) => d.read(now));
    const s = this.state;
    if (Math.abs(r - s.r) > 0.01 || Math.abs(g - s.g) > 0.01 || Math.abs(b - s.b) > 0.01) {
      this.state = { r, g, b };
      this.changed();
    }
  }
}

class LedBarGraph extends PartModel {
  static pins = Array.from({ length: 10 }, (_, i) => [`A${i + 1}`, `C${i + 1}`]).flat();
  state = { values: new Array<number>(10).fill(0) };
  private duty = Array.from({ length: 10 }, () => new Duty());
  start() { this.update(); }
  pinChanged() { this.update(); }
  private update() {
    const now = this.api.now();
    this.duty.forEach((d, i) => {
      const v = across(this.api, `A${i + 1}`, `C${i + 1}`);
      d.set(v !== null && v > 1.5, now);
    });
  }
  frame() {
    const now = this.api.now();
    const values = this.duty.map((d) => d.read(now));
    if (values.some((v, i) => Math.abs(v - this.state.values[i]) > 0.01 || (v === 0) !== (this.state.values[i] === 0))) {
      this.state = { values };
      this.changed();
    }
  }
}

const SEGMENTS = ["A", "B", "C", "D", "E", "F", "G", "DP"];

class SevenSegment extends PartModel {
  private digits = clamp(Math.round(num(this.api.attrs.digits, 1)), 1, 4);
  private anode = (this.api.attrs.common ?? "anode") !== "cathode";
  private seg = Array.from({ length: this.digits * 8 }, () => new Persistence());
  private colon = new Persistence();
  state = { values: new Array<number>(this.digits * 8).fill(0), colon: false };
  static pins = [...SEGMENTS, "COM", "CLN", "DIG1", "DIG2", "DIG3", "DIG4"];
  node(pin: string) { return pin === "COM.1" || pin === "COM.2" ? "COM" : pin; }
  start() { this.update(); }
  pinChanged() { this.update(); }
  private lit(common: string, segment: string) {
    const v = this.anode ? across(this.api, common, segment) : across(this.api, segment, common);
    return v !== null && v > 1.5;
  }
  private update() {
    const now = this.api.now();
    for (let d = 0; d < this.digits; d++) {
      const common = this.digits === 1 ? "COM" : `DIG${d + 1}`;
      SEGMENTS.forEach((s, i) => this.seg[d * 8 + i].set(this.lit(common, s), now));
    }
    if (this.digits > 1) this.colon.set(this.lit("COM", "CLN"), now);
  }
  frame(span: number) {
    const now = this.api.now();
    const values = this.seg.map((p) => (p.read(now, span, this.api.hz) > 0.05 ? 1 : 0));
    const colon = this.colon.read(now, span, this.api.hz) > 0.05;
    if (colon !== this.state.colon || values.some((v, i) => v !== this.state.values[i])) {
      this.state = { values, colon };
      this.changed();
    }
  }
}

// ---- NeoPixels (WS2812): bits by pulse width, GRB order, chained DOUT → DIN ----

abstract class NeoPixels extends PartModel {
  static pins = ["DIN", "DOUT"];
  /** Red, green, blue for each pixel, 0-255. */
  pixels: Uint8Array;
  private bitIndex = 0;
  private byte = 0;
  private bitCount = 0;
  private high = false;
  private riseAt = 0;
  private fallAt = -1e12;
  private dirty = true;
  state: { pixels: Uint8Array } = { pixels: new Uint8Array(0) };
  constructor(api: PartApi, readonly count: number) {
    super(api);
    this.pixels = new Uint8Array(count * 3);
  }
  pinChanged(pin: string, value: NetValue) {
    if (pin !== "DIN") return;
    const high = isHigh(value);
    if (high === this.high) return;
    this.high = high;
    const now = this.api.now();
    const us = this.api.hz / 1e6;
    if (high) {
      if (now - this.fallAt > 50 * us) this.reset();
      this.riseAt = now;
    } else {
      this.fallAt = now;
      this.bit(now - this.riseAt > 0.55 * us ? 1 : 0);
    }
  }
  /** The start of a new frame of colours. */
  reset() {
    this.bitIndex = 0;
    this.byte = 0;
    this.bitCount = 0;
    for (const next of this.next()) next.reset();
  }
  bit(b: number) {
    if (this.bitIndex >= this.count * 24) {
      for (const next of this.next()) next.bit(b);
      return;
    }
    this.byte = (this.byte << 1) | b;
    this.bitIndex++;
    if (++this.bitCount === 8) {
      const byteIndex = (this.bitIndex >> 3) - 1;
      const pixel = Math.floor(byteIndex / 3);
      // On the wire: green, red, blue.
      const channel = [1, 0, 2][byteIndex % 3];
      this.pixels[pixel * 3 + channel] = this.byte & 0xff;
      this.byte = 0;
      this.bitCount = 0;
      this.dirty = true;
    }
  }
  private next(): NeoPixels[] {
    return this.api.connected("DOUT").filter((c) => c.pin === "DIN" && c.model instanceof NeoPixels).map((c) => c.model as NeoPixels);
  }
  frame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.state = { pixels: this.pixels.slice() };
    this.changed();
  }
}

class NeoPixel extends NeoPixels {
  constructor(api: PartApi) { super(api, 1); }
}
class LedRing extends NeoPixels {
  constructor(api: PartApi) { super(api, clamp(Math.round(num(api.attrs.pixels, 16)), 1, 256)); }
}
class NeoPixelMatrix extends NeoPixels {
  constructor(api: PartApi) { super(api, clamp(Math.round(num(api.attrs.rows, 8)), 1, 64) * clamp(Math.round(num(api.attrs.cols, 8)), 1, 64)); }
}

// ---- Switches and inputs ----

class Resistor extends PartModel {
  resistors(): [string, string, number][] { return [["1", "2", parseOhms(this.api.attrs.value, 1000)]]; }
}

class Pushbutton extends PartModel {
  state = { pressed: false };
  node(pin: string) { return pin.replace(/\.[lr]$/, ""); }
  switches(): [string, string][] { return this.state.pressed ? [["1", "2"]] : []; }
  input(name: string, value: unknown) {
    if (name !== "press") return;
    const pressed = !!value;
    if (pressed === this.state.pressed) return;
    this.state = { pressed };
    this.changed();
    this.api.rewire();
  }
}

class SlideSwitch extends PartModel {
  state = { value: num(this.api.attrs.value, 0) ? 1 : 0 };
  switches(): [string, string][] { return [this.state.value ? ["2", "3"] : ["1", "2"]]; }
  input(name: string, value: unknown) {
    if (name !== "value") return;
    this.state = { value: value ? 1 : 0 };
    this.changed();
    this.api.rewire();
  }
}

class TiltSwitch extends PartModel {
  static pins = ["OUT"];
  state = { tilted: false };
  switches(): [string, string][] { return [this.state.tilted ? ["OUT", "VCC"] : ["OUT", "GND"]]; }
  input(name: string, value: unknown) {
    if (name !== "tilt") return;
    this.state = { tilted: !!value };
    this.changed();
    this.api.rewire();
  }
}

class DipSwitch8 extends PartModel {
  state = { values: new Array<number>(8).fill(0) };
  switches(): [string, string][] {
    return this.state.values.flatMap((v, i) => (v ? [[`${i + 1}a`, `${i + 1}b`] as [string, string]] : []));
  }
  input(name: string, value: unknown) {
    if (name !== "toggle") return;
    const i = Number(value);
    if (!(i >= 0 && i < 8)) return;
    const values = this.state.values.slice();
    values[i] = values[i] ? 0 : 1;
    this.state = { values };
    this.changed();
    this.api.rewire();
  }
}

/** A potentiometer's track: VCC to SIG and SIG to GND, split where the wiper is. */
function track(vcc: string, sig: string, gnd: string, x: number, ohms = 10_000): [string, string, number][] {
  return [[vcc, sig, ohms * (1 - x)], [sig, gnd, ohms * x]];
}

class Potentiometer extends PartModel {
  static pins = ["SIG"];
  state = { value: clamp(num(this.api.attrs.value, 0), 0, 1023) };
  resistors() { return track("VCC", "SIG", "GND", this.state.value / 1023); }
  input(name: string, value: unknown) {
    if (name !== "value") return;
    this.state = { value: clamp(Number(value) || 0, 0, 1023) };
    this.changed();
    this.api.rewire();
  }
}

class SlidePotentiometer extends PartModel {
  static pins = ["SIG"];
  private min = num(this.api.attrs.min, 0);
  private max = num(this.api.attrs.max, 100);
  state = { value: clamp(num(this.api.attrs.value, this.min), this.min, this.max) };
  resistors() { return track("VCC", "SIG", "GND", this.max > this.min ? (this.state.value - this.min) / (this.max - this.min) : 0); }
  input(name: string, value: unknown) {
    if (name !== "value") return;
    this.state = { value: clamp(Number(value) || 0, this.min, this.max) };
    this.changed();
    this.api.rewire();
  }
}

class AnalogJoystick extends PartModel {
  static pins = ["HORZ", "VERT", "SEL"];
  state = { x: 0, y: 0, pressed: false };
  // Left and up read 1023, right and down 0, the middle 512.
  resistors() { return [...track("VCC", "HORZ", "GND", (this.state.x + 1) / 2), ...track("VCC", "VERT", "GND", (this.state.y + 1) / 2)]; }
  switches(): [string, string][] { return this.state.pressed ? [["SEL", "GND"]] : []; }
  input(name: string, value: unknown) {
    if (name === "x") this.state = { ...this.state, x: clamp(Number(value) || 0, -1, 1) };
    else if (name === "y") this.state = { ...this.state, y: clamp(Number(value) || 0, -1, 1) };
    else if (name === "press") this.state = { ...this.state, pressed: !!value };
    else return;
    this.changed();
    this.api.rewire();
  }
}

class MembraneKeypad extends PartModel {
  state = { pressed: [] as string[] };
  private down = new Set<string>();
  switches(): [string, string][] {
    return [...this.down].map((k) => { const [r, c] = k.split(","); return [`R${Number(r) + 1}`, `C${Number(c) + 1}`]; });
  }
  input(name: string, value: unknown) {
    if (name !== "key") return;
    const { row, column, pressed } = (value ?? {}) as { row?: number; column?: number; pressed?: boolean };
    if (!(Number.isInteger(row) && Number.isInteger(column))) return;
    const k = `${row},${column}`;
    if (pressed) this.down.add(k); else this.down.delete(k);
    this.state = { pressed: [...this.down] };
    this.changed();
    this.api.rewire();
  }
}

/** KY-040: CLK and DT pulled up on the module, pulled low by the contacts; one detent is one CLK pulse. */
class RotaryEncoder extends PartModel {
  static pins = ["CLK", "DT", "SW"];
  state = { angle: 0, pressed: false };
  private busy: (() => void)[] = [];
  private queue: number[] = [];
  start() {
    this.api.drive("CLK", 5, 1);
    this.api.drive("DT", 5, 1);
  }
  private set(pin: "CLK" | "DT", low: boolean) {
    if (low) this.api.drive(pin, 0, 2); else this.api.drive(pin, 5, 1);
  }
  private step(dir: number) {
    const ms = this.api.hz / 1000;
    const [first, second] = dir > 0 ? ["CLK", "DT"] as const : ["DT", "CLK"] as const;
    this.set(first, true);
    this.busy = [
      this.api.schedule(ms, () => this.set(second, true)),
      this.api.schedule(2 * ms, () => this.set(first, false)),
      this.api.schedule(3 * ms, () => {
        this.set(second, false);
        this.busy = [];
        const next = this.queue.shift();
        if (next !== undefined) this.step(next);
      }),
    ];
  }
  input(name: string, value: unknown) {
    if (name === "rotate") {
      const dir = Number(value) > 0 ? 1 : -1;
      this.state = { ...this.state, angle: this.state.angle + dir * 18 };
      this.changed();
      if (this.busy.length) this.queue.push(dir); else this.step(dir);
    } else if (name === "press") {
      this.state = { ...this.state, pressed: !!value };
      this.changed();
      this.api.drive("SW", value ? 0 : null);
    }
  }
}

// ---- Sound and motion ----

class Buzzer extends PartModel {
  static pins = ["1", "2"];
  state = { frequency: 0 };
  private high = false;
  private rises: number[] = [];
  pinChanged() {
    const v = across(this.api, "2", "1");
    const high = v !== null && Math.abs(v) > 2.5;
    if (high === this.high) return;
    this.high = high;
    if (!high) return;
    this.rises.push(this.api.now());
    if (this.rises.length > 256) this.rises.shift();
  }
  frame() {
    const now = this.api.now();
    const hz = this.api.hz;
    // The pitch over the last 100 ms; silent 50 ms after the last edge.
    this.rises = this.rises.filter((t) => now - t < hz / 10);
    const n = this.rises.length;
    let frequency = 0;
    if (n >= 2 && now - this.rises[n - 1] < hz / 20) frequency = Math.round(((n - 1) * hz) / (this.rises[n - 1] - this.rises[0]));
    if (frequency !== this.state.frequency) {
      this.state = { frequency };
      this.changed();
    }
  }
}

class Servo extends PartModel {
  static pins = ["PWM"];
  state = { angle: 0 };
  private riseAt = 0;
  private high = false;
  pinChanged(pin: string, value: NetValue) {
    if (pin !== "PWM") return;
    const high = isHigh(value);
    if (high === this.high) return;
    this.high = high;
    const now = this.api.now();
    if (high) { this.riseAt = now; return; }
    const us = ((now - this.riseAt) * 1e6) / this.api.hz;
    // The Servo library's range: 544 µs is 0°, 2400 µs is 180°.
    if (us < 400 || us > 3000) return;
    const angle = Math.round(clamp(((us - 544) / (2400 - 544)) * 180, 0, 180) * 10) / 10;
    if (Math.abs(angle - this.state.angle) >= 0.1) {
      this.state = { angle };
      this.changed();
    }
  }
}

// ---- Sensors ----

/** DHT22: answers the program's start signal with 40 bits: humidity, temperature, checksum. */
class Dht22 extends PartModel {
  static pins = ["SDA"];
  state = { temperature: num(this.api.attrs.temperature, 24), humidity: num(this.api.attrs.humidity, 40) };
  private lowAt: number | null = null;
  private answering = false;
  pinChanged(pin: string, value: NetValue) {
    if (pin !== "SDA" || this.answering) return;
    const now = this.api.now();
    if (!isHigh(value)) {
      // Driven low (not just floating, as at power-up) may be the start signal.
      if (value.v !== null && this.lowAt === null) this.lowAt = now;
      return;
    }
    const lowFor = this.lowAt === null ? 0 : now - this.lowAt;
    this.lowAt = null;
    // The start signal: low for at least ~1 ms, then let go.
    if (lowFor >= this.api.hz * 0.0008 && powered(this.api)) this.answer();
  }
  private answer() {
    const { temperature, humidity } = this.state;
    const h = Math.round(clamp(humidity, 0, 100) * 10);
    const t = Math.round(Math.abs(clamp(temperature, -40, 80)) * 10) | (temperature < 0 ? 0x8000 : 0);
    const bytes = [h >> 8, h & 0xff, t >> 8, t & 0xff];
    bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff);
    // [level, microseconds]: the response, then each bit as 50 µs low and 26 or 70 µs high.
    const steps: [number, number][] = [[1, 30], [0, 80], [1, 80]];
    for (const byte of bytes) for (let i = 7; i >= 0; i--) steps.push([0, 50], [1, (byte >> i) & 1 ? 70 : 26]);
    steps.push([0, 50]);
    this.answering = true;
    const us = this.api.hz / 1e6;
    let at = 0;
    for (const [level, dur] of steps) {
      this.api.schedule(Math.max(1, at * us), () => (level ? this.api.drive("SDA", 5, 1) : this.api.drive("SDA", 0, 2)));
      at += dur;
    }
    this.api.schedule(at * us, () => {
      this.api.drive("SDA", null);
      this.answering = false;
      this.lowAt = null;
    });
  }
  input(name: string, value: unknown) {
    if (name === "temperature") this.state = { ...this.state, temperature: clamp(Number(value) || 0, -40, 80) };
    else if (name === "humidity") this.state = { ...this.state, humidity: clamp(Number(value) || 0, 0, 100) };
    else return;
    this.changed();
  }
}

/** HC-SR04: a 10 µs pulse on TRIG, then ECHO high for 58 µs per centimetre. */
class Ultrasonic extends PartModel {
  static pins = ["TRIG", "ECHO"];
  state = { distance: clamp(num(this.api.attrs.distance, 400), 2, 400) };
  private riseAt = 0;
  private high = false;
  private busy = false;
  start() { this.api.drive("ECHO", 0); }
  pinChanged(pin: string, value: NetValue) {
    if (pin !== "TRIG") return;
    const high = isHigh(value);
    if (high === this.high) return;
    this.high = high;
    const now = this.api.now();
    if (high) { this.riseAt = now; return; }
    const us = this.api.hz / 1e6;
    if (now - this.riseAt < 8 * us || this.busy || !powered(this.api)) return;
    this.busy = true;
    const width = this.state.distance * 58;
    this.api.schedule(250 * us, () => {
      this.api.drive("ECHO", 5);
      this.api.schedule(width * us, () => { this.api.drive("ECHO", 0); this.busy = false; });
    });
  }
  input(name: string, value: unknown) {
    if (name !== "distance") return;
    this.state = { distance: clamp(Number(value) || 0, 2, 400) };
    this.changed();
  }
}

/** PIR: OUT goes high on motion and stays high for `delayTime` seconds. */
class PirSensor extends PartModel {
  static pins = ["OUT"];
  state = { motion: false };
  private cancel: (() => void) | null = null;
  start() { this.api.drive("OUT", 0); }
  input(name: string) {
    if (name !== "motion") return;
    this.cancel?.();
    this.state = { motion: true };
    this.changed();
    this.api.drive("OUT", 5);
    this.cancel = this.api.schedule(num(this.api.attrs.delayTime, 5) * this.api.hz, () => {
      this.cancel = null;
      this.state = { motion: false };
      this.changed();
      this.api.drive("OUT", 0);
    });
  }
}

/** Photoresistor module: the LDR from AO to GND, 10 kΩ from VCC; DO high when dark (AO above threshold). */
class PhotoresistorSensor extends PartModel {
  static pins = ["AO", "DO"];
  state = { lux: clamp(num(this.api.attrs.lux, 500), 0.1, 100_000), dark: false };
  private ldrOhms() {
    const rl10 = num(this.api.attrs.rl10, 50) * 1000;
    const gamma = num(this.api.attrs.gamma, 0.7);
    return rl10 * Math.pow(10 / this.state.lux, gamma);
  }
  resistors(): [string, string, number][] { return [["VCC", "AO", 10_000], ["AO", "GND", this.ldrOhms()]]; }
  start() { this.updateDo(); }
  pinChanged(pin: string) { if (pin === "AO") this.updateDo(); }
  private updateDo() {
    const ao = this.api.value("AO").v;
    if (ao === null) { this.api.drive("DO", null); return; }
    const dark = ao > num(this.api.attrs.threshold, 2.5);
    this.api.drive("DO", dark ? 5 : 0);
    if (dark !== this.state.dark) { this.state = { ...this.state, dark }; this.changed(); }
  }
  input(name: string, value: unknown) {
    if (name !== "lux") return;
    this.state = { ...this.state, lux: clamp(Number(value) || 0, 0.1, 100_000) };
    this.changed();
    this.api.rewire();
  }
}

/** NTC thermistor module: 10 kΩ from VCC to OUT, the thermistor (10 kΩ at 25 °C, β 3950) from OUT to GND. */
class NtcSensor extends PartModel {
  static pins = ["OUT"];
  state = { temperature: clamp(num(this.api.attrs.temperature, 24), -40, 125) };
  resistors(): [string, string, number][] {
    const beta = num(this.api.attrs.beta, 3950);
    const t = this.state.temperature + 273.15;
    return [["VCC", "OUT", 10_000], ["OUT", "GND", 10_000 * Math.exp(beta * (1 / t - 1 / 298.15))]];
  }
  input(name: string, value: unknown) {
    if (name !== "temperature") return;
    this.state = { temperature: clamp(Number(value) || 0, -40, 125) };
    this.changed();
    this.api.rewire();
  }
}

// ---- Displays ----

const LCD_PINS = ["RS", "RW", "E", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "A", "K"];

/** A character LCD (HD44780), wired by its own pins or through an I2C backpack (PCF8574). */
class CharacterLcd extends PartModel {
  static pins = LCD_PINS;
  readonly lcd: Hd44780;
  private i2c = this.api.attrs.pins === "i2c";
  private eHigh = false;
  private backpackLight = true;
  state: ReturnType<Hd44780["snapshot"]> & { backlight: boolean };
  constructor(api: PartApi, cols: number, rows: number) {
    super(api);
    this.lcd = new Hd44780(cols, rows);
    this.state = { ...this.lcd.snapshot(), backlight: true };
    if (this.i2c) {
      const backpack = new Pcf8574((value, old) => {
        this.backpackLight = !!(value & 0x08);
        // E is P2: data is taken as it falls. RS is P0, RW P1, D4-D7 are P4-P7.
        if (old & 0x04 && !(value & 0x04) && !(value & 0x02)) this.lcd.write(!!(value & 0x01), value & 0xf0);
      });
      api.i2c(Number.parseInt(api.attrs.i2cAddress ?? "0x27") || 0x27, "SDA", "SCL", backpack);
    }
  }
  pinChanged(pin: string, value: NetValue) {
    if (this.i2c || pin !== "E") return;
    const high = isHigh(value);
    if (high === this.eHigh) return;
    this.eHigh = high;
    if (high || isHigh(this.api.value("RW"))) return;
    let data = 0;
    for (let i = 0; i < 8; i++) if (isHigh(this.api.value(`D${i}`))) data |= 1 << i;
    this.lcd.write(isHigh(this.api.value("RS")), data);
  }
  frame() {
    let backlight = this.backpackLight;
    if (!this.i2c) {
      const wired = this.api.wired("A") || this.api.wired("K");
      const v = across(this.api, "A", "K");
      backlight = !wired || (v !== null && v > 1.5);
    }
    if (this.lcd.version !== this.state.version || backlight !== this.state.backlight) {
      this.state = { ...this.lcd.snapshot(), backlight };
      this.changed();
    }
  }
}

class Oled extends PartModel {
  readonly oled = new Ssd1306();
  state = { version: -1, pixels: new Uint8Array(128 * 64) };
  constructor(api: PartApi) {
    super(api);
    api.i2c(Number.parseInt(api.attrs.i2cAddress ?? "0x3c") || 0x3c, "DATA", "CLK", this.oled);
  }
  frame() {
    if (this.oled.version === this.state.version) return;
    this.state = { version: this.oled.version, pixels: this.oled.render() };
    this.changed();
  }
}

class RealTimeClock extends PartModel {
  readonly rtc: Ds1307;
  constructor(api: PartApi) {
    super(api);
    this.rtc = new Ds1307(() => api.now() / api.hz);
    api.i2c(0x68, "SDA", "SCL", this.rtc);
  }
}

export const PART_MODELS: Record<string, PartFactory> = {
  "wokwi-led": (api) => new Led(api),
  "wokwi-rgb-led": (api) => new RgbLed(api),
  "wokwi-led-bar-graph": (api) => new LedBarGraph(api),
  "wokwi-7segment": (api) => new SevenSegment(api),
  "wokwi-neopixel": (api) => new NeoPixel(api),
  "wokwi-led-ring": (api) => new LedRing(api),
  "wokwi-neopixel-matrix": (api) => new NeoPixelMatrix(api),
  "wokwi-resistor": (api) => new Resistor(api),
  "wokwi-pushbutton": (api) => new Pushbutton(api),
  "wokwi-pushbutton-6mm": (api) => new Pushbutton(api),
  "wokwi-slide-switch": (api) => new SlideSwitch(api),
  "wokwi-tilt-switch": (api) => new TiltSwitch(api),
  "wokwi-dip-switch-8": (api) => new DipSwitch8(api),
  "wokwi-potentiometer": (api) => new Potentiometer(api),
  "wokwi-slide-potentiometer": (api) => new SlidePotentiometer(api),
  "wokwi-analog-joystick": (api) => new AnalogJoystick(api),
  "wokwi-membrane-keypad": (api) => new MembraneKeypad(api),
  "wokwi-ky-040": (api) => new RotaryEncoder(api),
  "wokwi-buzzer": (api) => new Buzzer(api),
  "wokwi-servo": (api) => new Servo(api),
  "wokwi-dht22": (api) => new Dht22(api),
  "wokwi-hc-sr04": (api) => new Ultrasonic(api),
  "wokwi-pir-motion-sensor": (api) => new PirSensor(api),
  "wokwi-photoresistor-sensor": (api) => new PhotoresistorSensor(api),
  "wokwi-ntc-temperature-sensor": (api) => new NtcSensor(api),
  "wokwi-lcd1602": (api) => new CharacterLcd(api, 16, 2),
  "wokwi-lcd2004": (api) => new CharacterLcd(api, 20, 4),
  "wokwi-ssd1306": (api) => new Oled(api),
  "wokwi-ds1307": (api) => new RealTimeClock(api),
};
