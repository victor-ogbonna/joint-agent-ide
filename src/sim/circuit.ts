/**
 * A running circuit: the board's chip running the compiled program, the
 * parts, and the wires between them.
 *
 * Wires join pins into nets. A net's voltage comes from what drives it: the
 * board's power pins, the chip's output pins, or a part's own output. A net
 * nothing drives takes its voltage through resistors (a pull-up, a
 * pull-down, a potentiometer, a divider), worked out as the real resistor
 * network would. Buttons, switches and keypads join nets while they're
 * closed.
 *
 * When anything changes, only the nets it touches are worked out again; the
 * chip's input pins and analog inputs read the result, and the parts are
 * told, at the CPU cycle it changed, so they can time things (PWM, servo
 * pulses, NeoPixel bits, a DHT22 reply).
 */
import { PinState } from "avr8js";
import type { TWIEventHandler } from "avr8js";
import { boardPin, own, type BoardDef } from "./boards";
import { boardOf, splitPin, type Diagram, type DiagramPart } from "./diagram";
import { parseIntelHex } from "./hex";
import { createMcu, CLOCK_HZ, type Mcu } from "./mcu";

/** A net's state: volts (null when nothing drives it) and how strongly: 0 none, 1 through a resistor, 2 directly. */
export interface NetValue {
  v: number | null;
  s: 0 | 1 | 2;
}
export const FLOATING: NetValue = { v: null, s: 0 };
export const isHigh = (n: NetValue) => n.v !== null && n.v >= 2.5;
export const isLow = (n: NetValue) => n.v !== null && n.v < 2.5;

/** The chip's own pull-up, in ohms. */
const PULLUP_OHMS = 35_000;
/** A part's weak output (a module's own pull-up), in ohms. */
const WEAK_OHMS = 10_000;

/** What a part model can do in the running circuit. */
export interface PartApi {
  readonly id: string;
  readonly attrs: Record<string, string>;
  readonly hz: number;
  /** The CPU's cycle count now. */
  now(): number;
  /** The net a pin of this part is on. */
  value(pin: string): NetValue;
  /** Drives a pin: volts, or null to let go of it. Weak (1) drives through 10 kΩ. */
  drive(pin: string, volts: number | null, strength?: 1 | 2): void;
  /** Runs fn after `cycles` CPU cycles; returns a cancel function. */
  schedule(cycles: number, fn: () => void): () => void;
  /** A switch opened or closed, or a resistance changed: the nets are joined differently now. */
  rewire(): void;
  /** Whether two pins ("part:pin") are on the same net. */
  joined(a: string, b: string): boolean;
  /** Whether a pin of this part is wired to anything. */
  wired(pin: string): boolean;
  /** The other parts' pins on the same net as this part's pin. */
  connected(pin: string): { model: PartModel; pin: string }[];
  /** Registers an I2C device at `address` on the board's bus, answered while its SDA and SCL pins are wired to the board's. */
  i2c(address: number, sdaPin: string, sclPin: string, device: I2CDevice): void;
}

export interface I2CDevice {
  /** Answers its address (ack), for a write or a read. */
  connect(write: boolean): boolean;
  write(byte: number): boolean;
  read(ack: boolean): number;
  stop(): void;
}

export abstract class PartModel {
  /** What the workspace shows; changed, then `version` bumped. */
  state: object = {};
  version = 0;
  constructor(protected api: PartApi) {}
  /** Pins that are one node inside the part ("1.l" and "1.r" of a button). */
  node(pin: string): string { return pin; }
  /** Pin pairs joined right now (a pressed button, a closed switch). */
  switches(): [string, string][] { return []; }
  /** Pin pairs joined through a resistor, with its ohms. */
  resistors(): [string, string, number][] { return []; }
  /** A pin's net changed. */
  pinChanged(_pin: string, _value: NetValue): void {}
  /** Something done to the part in the workspace (pressed, turned, set). */
  input(_name: string, _value: unknown): void {}
  /** About 60 times a second: settles what it shows, `cycles` being how long since the last frame. */
  frame(_cycles: number): void {}
  /** Called once the wiring is known, before the program runs. */
  start(): void {}
  protected changed() { this.version++; }
}

export type PartFactory = (api: PartApi) => PartModel;

interface Net {
  nodes: string[];
  /** Board power on this net: its volts (two different ones are a short). */
  rails: number[];
  /** Arduino digital pins on this net. */
  pins: number[];
  /** ADC channels of analog-only pins (a Nano's A6, A7). */
  adc: number[];
  /** Resistors to other nets: which, and the conductance. */
  links: { to: number; g: number }[];
  /** Part pins to tell when it changes. */
  listeners: { model: PartModel; pin: string; key: string }[];
}

/** What drives a net directly, before resistors are counted. */
interface Direct {
  strong: number | null;
  /** Weak sources, as conductance and conductance × volts. */
  g: number;
  gv: number;
  conflict: boolean;
}

const UNKNOWN: NetValue = { v: NaN, s: 0 };

class UnionFind {
  private parent = new Map<string, string>();
  find(a: string): string {
    let p = this.parent.get(a);
    if (p === undefined) { this.parent.set(a, a); return a; }
    if (p === a) return a;
    p = this.find(p);
    this.parent.set(a, p);
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Solves A·x = b (A square, n small) by Gaussian elimination; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-15) return null;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

const sameValue = (a: NetValue, b: NetValue) =>
  a.s === b.s && (a.v === b.v || (a.v !== null && b.v !== null && Math.abs(a.v - b.v) < 1e-6));

export interface SimulationOptions {
  /** Text the program prints on Serial. */
  onSerial?: (text: string) => void;
  /** Builds a model for a part type; parts with none are only wiring. */
  models: Record<string, PartFactory>;
}

export class Simulation {
  readonly board: BoardDef;
  readonly boardPart: DiagramPart;
  readonly mcu: Mcu;
  readonly hz = CLOCK_HZ;
  readonly models = new Map<string, PartModel>();
  /** The board's own LEDs: pin 13's brightness, and serial activity. */
  boardLeds = { led13: 0, tx: false, rx: false, version: 0 };
  /** A power pin wired straight to GND, or an output pin fighting another. */
  shorted = false;

  private diagram: Diagram;
  private wires: [string, string][] = [];
  private nets: Net[] = [];
  private nodeNet = new Map<string, number>();
  private values: NetValue[] = [];
  private direct: Direct[] = [];
  private conflicts = new Set<number>();
  private drives = new Map<string, NetValue>();
  private notified = new Map<string, NetValue>();
  private pinStates: number[];
  private i2cDevices: { address: number; sda: string; scl: string; device: I2CDevice }[] = [];
  private dirty = new Set<number>();
  private evaluating = false;
  private rewireNeeded = false;
  private led13 = { on: false, since: 0, onCycles: 0 };
  private lastTx = -Infinity;
  private lastRx = -Infinity;
  private rxQueue: number[] = [];
  private onSerial?: (text: string) => void;
  private decoder = new TextDecoder();

  constructor(diagram: Diagram, hex: string, options: SimulationOptions) {
    const found = boardOf(diagram);
    if (!found) throw new Error("Add an Arduino board to the circuit first.");
    if (found.board.chip === "esp32") throw new Error("An ESP32 runs on the simulation server, not in the page.");
    this.diagram = diagram;
    this.board = found.board;
    this.boardPart = found.part;
    this.onSerial = options.onSerial;
    this.mcu = createMcu(this.board, parseIntelHex(hex, this.board.flashBytes));
    this.pinStates = this.board.digital.map(() => -1);

    for (const part of diagram.parts) {
      if (part === this.boardPart) continue;
      const factory = own(options.models, part.type) ? options.models[part.type] : undefined;
      if (factory) this.models.set(part.id, factory(this.apiFor(part)));
    }
    for (const [from, to] of diagram.connections) this.wires.push([from, to]);
    this.rewireNeeded = true;

    // The chip's pins: a change on a port re-solves the nets of the pins that changed.
    for (const [letter, port] of Object.entries(this.mcu.ports)) {
      const pins = this.board.digital.map((p, pin) => (p.port === letter ? pin : -1)).filter((pin) => pin >= 0);
      if (!pins.length) continue;
      port.addListener(() => {
        let any = false;
        for (const pin of pins) {
          const state = port.pinState(this.board.digital[pin].bit);
          if (state === this.pinStates[pin]) continue;
          this.pinStates[pin] = state;
          if (pin === 13) this.watchLed13(state);
          const net = this.nodeNet.get(`#D${pin}`);
          if (net !== undefined) { this.dirty.add(net); any = true; }
        }
        if (any) this.evaluate();
      });
    }
    const usart = this.mcu.usarts[0];
    usart.onByteTransmit = (b) => {
      this.lastTx = this.mcu.cpu.cycles;
      const text = this.decoder.decode(new Uint8Array([b]), { stream: true });
      if (text) this.onSerial?.(text);
    };
    usart.onRxComplete = () => this.feedSerial();
    this.mcu.twi.eventHandler = this.i2cBus();

    for (const model of this.models.values()) model.start();
    this.evaluate();
  }

  // ---- Wiring ----

  /** The node a pin is: the board's pins by what they are, a part's by part and pin. */
  private nodeOf(ref: string): string {
    const split = splitPin(ref);
    if (!split) return ref;
    const [partId, pin] = split;
    if (partId === this.boardPart.id) {
      const bp = boardPin(this.board, pin);
      switch (bp.kind) {
        case "digital": return `#D${bp.pin}`;
        case "analog-only": return `#A${bp.channel}`;
        case "power": return bp.volts === 5 ? "#5V" : "#3V3";
        case "ground": return "#GND";
        default: return `${partId}:${pin}`;
      }
    }
    const model = this.models.get(partId);
    return `${partId}:${model ? model.node(pin) : pin}`;
  }

  /** Joins pins into nets again: wires, the parts' own joins, and every switch closed now. */
  private rewire() {
    const uf = new UnionFind();
    const nodes = new Set<string>(["#GND", "#5V", "#3V3"]);
    for (let i = 0; i < this.board.digital.length; i++) nodes.add(`#D${i}`);
    for (const [name, ch] of Object.entries(this.board.analog)) if (!(name in this.board.analogDigital)) nodes.add(`#A${ch}`);
    const touch = (n: string) => { nodes.add(n); uf.find(n); return n; };
    for (const [a, b] of this.wires) uf.union(touch(this.nodeOf(a)), touch(this.nodeOf(b)));
    const resistors: [string, string, number][] = [];
    for (const [id, model] of this.models) {
      for (const [a, b] of model.switches()) uf.union(touch(`${id}:${model.node(a)}`), touch(`${id}:${model.node(b)}`));
      for (const [a, b, ohms] of model.resistors()) resistors.push([touch(`${id}:${model.node(a)}`), touch(`${id}:${model.node(b)}`), ohms]);
    }

    const byRoot = new Map<string, number>();
    const nets: Net[] = [];
    this.nodeNet.clear();
    for (const n of nodes) {
      const root = uf.find(n);
      let i = byRoot.get(root);
      if (i === undefined) {
        i = nets.length;
        byRoot.set(root, i);
        nets.push({ nodes: [], rails: [], pins: [], adc: [], links: [], listeners: [] });
      }
      const net = nets[i];
      net.nodes.push(n);
      this.nodeNet.set(n, i);
      if (n === "#GND") net.rails.push(0);
      else if (n === "#5V") net.rails.push(5);
      else if (n === "#3V3") net.rails.push(3.3);
      else if (n.startsWith("#D")) net.pins.push(Number(n.slice(2)));
      else if (n.startsWith("#A")) net.adc.push(Number(n.slice(2)));
    }
    for (const [a, b, ohms] of resistors) {
      const na = this.nodeNet.get(a)!;
      const nb = this.nodeNet.get(b)!;
      if (na === nb) continue;
      const g = 1 / Math.max(1, ohms);
      nets[na].links.push({ to: nb, g });
      nets[nb].links.push({ to: na, g });
    }
    for (const [id, model] of this.models) {
      const part = this.diagram.parts.find((p) => p.id === id);
      for (const pin of this.pinsOf(part, model)) {
        const net = this.nodeNet.get(`${id}:${model.node(pin)}`);
        if (net !== undefined) nets[net].listeners.push({ model, pin, key: `${id}:${pin}` });
      }
    }
    this.nets = nets;
    this.values = nets.map(() => UNKNOWN);
    this.direct = [];
    this.conflicts.clear();
  }

  /** The pins of a part a model listens on: every pin it was wired by, and every pin it names. */
  private pinsOf(part: DiagramPart | undefined, model: PartModel): string[] {
    const pins = new Set<string>((model.constructor as { pins?: string[] }).pins ?? []);
    if (part) for (const [a, b] of this.wires) {
      for (const ref of [a, b]) {
        const s = splitPin(ref);
        if (s && s[0] === part.id) pins.add(s[1]);
      }
    }
    return [...pins];
  }

  // ---- Working out the nets ----

  private evaluate() {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      // Parts answering a change can change things again; settle, but never spin forever.
      for (let round = 0; round < 50 && (this.rewireNeeded || this.dirty.size); round++) {
        if (this.rewireNeeded) {
          this.rewireNeeded = false;
          this.dirty = new Set();
          this.rewire();
          this.solve(null);
        } else {
          const dirty = this.dirty;
          this.dirty = new Set();
          this.solve(dirty);
        }
      }
    } finally {
      this.evaluating = false;
    }
  }

  private directOf(i: number): Direct {
    const net = this.nets[i];
    const d: Direct = { strong: null, g: 0, gv: 0, conflict: false };
    // Two different strong drives fight: board power wins over a pin, and LOW wins otherwise.
    const rail = net.rails.length ? Math.min(...net.rails) : null;
    const strong = (v: number) => {
      if (d.strong === null) d.strong = v;
      else if (Math.abs(d.strong - v) > 0.5) { d.conflict = true; d.strong = rail ?? Math.min(d.strong, v); }
    };
    const weak = (v: number, ohms: number) => { d.g += 1 / ohms; d.gv += v / ohms; };
    for (const r of net.rails) strong(r);
    for (const pin of net.pins) {
      const { port, bit } = this.board.digital[pin];
      const state = this.mcu.ports[port]?.pinState(bit);
      if (state === PinState.High) strong(5);
      else if (state === PinState.Low) strong(0);
      else if (state === PinState.InputPullUp) weak(5, PULLUP_OHMS);
    }
    for (const n of net.nodes) {
      const drive = this.drives.get(n);
      if (!drive || drive.v === null) continue;
      if (drive.s === 2) strong(drive.v);
      else if (drive.s === 1) weak(drive.v, WEAK_OHMS);
    }
    return d;
  }

  /** Works out the nets in `dirty` (all when null) and every net they reach through resistors. */
  private solve(dirty: Set<number> | null) {
    const { nets } = this;
    const seeds = dirty ? [...dirty] : nets.map((_, i) => i);
    for (const i of seeds) {
      this.direct[i] = this.directOf(i);
      if (this.direct[i].conflict) this.conflicts.add(i); else this.conflicts.delete(i);
    }
    this.shorted = this.conflicts.size > 0;

    // The nets a change reaches: through resistors, stopping at nets driven directly.
    const seedSet = new Set(seeds);
    const region = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const i = queue.pop()!;
      if (!seedSet.has(i) && this.direct[i].strong !== null) continue;
      for (const { to } of nets[i].links) if (!region.has(to)) { region.add(to); queue.push(to); }
    }

    const next = new Map<number, NetValue>();
    const free: number[] = [];
    for (const i of region) {
      const d = this.direct[i] ?? (this.direct[i] = this.directOf(i));
      if (d.strong !== null) next.set(i, { v: d.strong, s: 2 });
      else free.push(i);
    }
    // Nets with no direct drive: each group joined by resistors is one small resistor network.
    const done = new Set<number>();
    for (const start of free) {
      if (done.has(start)) continue;
      const group: number[] = [];
      const stack = [start];
      done.add(start);
      while (stack.length) {
        const i = stack.pop()!;
        group.push(i);
        for (const { to } of nets[i].links) if (!done.has(to) && this.direct[to].strong === null) { done.add(to); stack.push(to); }
      }
      const index = new Map(group.map((n, k) => [n, k]));
      const A = group.map(() => new Array<number>(group.length).fill(0));
      const b = new Array<number>(group.length).fill(0);
      let driven = false;
      group.forEach((i, k) => {
        const d = this.direct[i];
        A[k][k] += d.g;
        b[k] += d.gv;
        if (d.g > 0) driven = true;
        for (const { to, g } of nets[i].links) {
          A[k][k] += g;
          const other = this.direct[to];
          if (other.strong !== null) { b[k] += g * other.strong; driven = true; }
          else A[k][index.get(to)!] -= g;
        }
      });
      const x = driven ? solveLinear(A, b) : null;
      group.forEach((i, k) => next.set(i, x ? { v: Math.round(x[k] * 1e4) / 1e4, s: 1 } : FLOATING));
    }

    // Tell the chip and the parts what changed.
    const changed: number[] = [];
    for (const [i, now] of next) {
      const before = this.values[i];
      if (before !== UNKNOWN && sameValue(before, now)) continue;
      this.values[i] = now;
      changed.push(i);
      const net = nets[i];
      const high = isHigh(now);
      for (const pin of net.pins) {
        const { port, bit } = this.board.digital[pin];
        this.mcu.ports[port]?.setPin(bit, high);
        const ch = this.analogChannel(pin);
        if (ch !== null) this.mcu.adc.channelValues[ch] = now.v ?? 0;
      }
      for (const ch of net.adc) this.mcu.adc.channelValues[ch] = now.v ?? 0;
    }
    for (const i of changed) {
      for (const { model, pin, key } of nets[i].listeners) {
        const value = this.values[i];
        const last = this.notified.get(key);
        if (last && sameValue(last, value)) continue;
        this.notified.set(key, value);
        model.pinChanged(pin, value);
      }
    }
  }

  private analogCache = new Map<number, number | null>();
  private analogChannel(pin: number): number | null {
    let ch = this.analogCache.get(pin);
    if (ch === undefined) {
      ch = null;
      for (const [name, d] of Object.entries(this.board.analogDigital)) if (d === pin) ch = this.board.analog[name];
      this.analogCache.set(pin, ch);
    }
    return ch;
  }

  // ---- The parts' side ----

  private apiFor(part: DiagramPart): PartApi {
    const sim = this;
    const attrs = { ...(part.attrs ?? {}) };
    const nodeFor = (pin: string) => {
      const model = sim.models.get(part.id);
      return `${part.id}:${model ? model.node(pin) : pin}`;
    };
    return {
      id: part.id,
      attrs,
      hz: CLOCK_HZ,
      now: () => sim.mcu.cpu.cycles,
      value(pin) {
        const net = sim.nodeNet.get(nodeFor(pin));
        const v = net === undefined ? undefined : sim.values[net];
        return !v || v === UNKNOWN ? FLOATING : v;
      },
      drive(pin, volts, strength = 2) {
        const node = nodeFor(pin);
        const before = sim.drives.get(node) ?? FLOATING;
        const next: NetValue = volts === null ? FLOATING : { v: volts, s: strength };
        if (sameValue(before, next)) return;
        sim.drives.set(node, next);
        const net = sim.nodeNet.get(node);
        if (net === undefined) return;
        sim.dirty.add(net);
        sim.evaluate();
      },
      schedule(cycles, fn) {
        const cb = () => fn();
        sim.mcu.cpu.addClockEvent(cb, Math.max(1, Math.round(cycles)));
        return () => { sim.mcu.cpu.clearClockEvent(cb); };
      },
      rewire() {
        sim.rewireNeeded = true;
        sim.evaluate();
      },
      joined(a, b) {
        const na = sim.nodeNet.get(sim.nodeOf(a));
        return na !== undefined && na === sim.nodeNet.get(sim.nodeOf(b));
      },
      wired(pin) {
        const net = sim.nodeNet.get(nodeFor(pin));
        return net !== undefined && sim.nets[net].nodes.length > 1;
      },
      connected(pin) {
        const net = sim.nodeNet.get(nodeFor(pin));
        if (net === undefined) return [];
        const self = sim.models.get(part.id);
        return sim.nets[net].listeners.filter((l) => l.model !== self).map(({ model, pin: p }) => ({ model, pin: p }));
      },
      i2c(address, sdaPin, sclPin, device) {
        sim.i2cDevices.push({ address, sda: `${part.id}:${sdaPin}`, scl: `${part.id}:${sclPin}`, device });
      },
    };
  }

  private i2cBus(): TWIEventHandler {
    const twi = this.mcu.twi;
    let current: I2CDevice | null = null;
    const sda = `#D${(boardPin(this.board, this.board.sda) as { pin: number }).pin}`;
    const scl = `#D${(boardPin(this.board, this.board.scl) as { pin: number }).pin}`;
    const onBus = (d: { sda: string; scl: string }) => {
      const a = this.nodeNet.get(this.nodeOf(d.sda));
      const b = this.nodeNet.get(this.nodeOf(d.scl));
      return a !== undefined && b !== undefined && a === this.nodeNet.get(sda) && b === this.nodeNet.get(scl);
    };
    return {
      start: () => twi.completeStart(),
      stop: () => { current?.stop(); current = null; twi.completeStop(); },
      connectToSlave: (addr, write) => {
        current?.stop();
        const found = this.i2cDevices.find((d) => d.address === addr && onBus(d));
        current = found ? found.device : null;
        const ack = !!current && current.connect(write);
        if (!ack) current = null;
        twi.completeConnect(ack);
      },
      writeByte: (value) => twi.completeWrite(!!current && current.write(value)),
      readByte: (ack) => twi.completeRead(current ? current.read(ack) & 0xff : 0xff),
    };
  }

  // ---- The board ----

  private watchLed13(state: number) {
    const on = state === PinState.High;
    if (on === this.led13.on) return;
    const now = this.mcu.cpu.cycles;
    if (this.led13.on) this.led13.onCycles += now - this.led13.since;
    this.led13.on = on;
    this.led13.since = now;
  }

  // ---- Running ----

  /** Runs the program for `cycles` more CPU cycles, then lets every part settle what it shows. */
  run(cycles: number) {
    this.advance(cycles);
    this.settle();
  }

  /** Runs the program for `cycles` more CPU cycles. */
  advance(cycles: number) {
    if (this.rxQueue.length) this.feedSerial();
    this.mcu.runUntil(this.mcu.cpu.cycles + cycles);
  }

  private lastSettle = 0;

  /** Works out what everything shows over the time since it was last asked (once per screen frame). */
  settle() {
    const now = this.mcu.cpu.cycles;
    const start = this.lastSettle;
    const span = now - start;
    this.lastSettle = now;
    if (this.led13.on) this.led13.onCycles += now - Math.max(this.led13.since, start);
    this.led13.since = now;
    const led13 = span > 0 ? Math.min(1, this.led13.onCycles / span) : (this.led13.on ? 1 : 0);
    this.led13.onCycles = 0;
    const tx = now - this.lastTx < this.hz / 20;
    const rx = now - this.lastRx < this.hz / 20;
    if (Math.abs(led13 - this.boardLeds.led13) > 0.01 || tx !== this.boardLeds.tx || rx !== this.boardLeds.rx) {
      this.boardLeds = { led13, tx, rx, version: this.boardLeds.version + 1 };
    }
    for (const model of this.models.values()) model.frame(span);
  }

  /** Simulated time, in milliseconds. */
  get timeMs() {
    return (this.mcu.cpu.cycles / this.hz) * 1000;
  }

  /** Something done to a part in the workspace. */
  input(partId: string, name: string, value: unknown) {
    this.models.get(partId)?.input(name, value);
    this.evaluate();
  }

  /** Text typed into the serial monitor, for the program's Serial. */
  serialWrite(text: string) {
    for (const b of new TextEncoder().encode(text)) this.rxQueue.push(b);
    this.feedSerial();
  }

  /** Hands the next waiting byte to Serial, once it can take one. */
  private feedSerial() {
    if (!this.rxQueue.length) return;
    if (!this.mcu.usarts[0].writeByte(this.rxQueue[0])) return;
    this.rxQueue.shift();
    this.lastRx = this.mcu.cpu.cycles;
  }

  /** A pin's net, for the workspace: "uno:13" → its value. */
  pinValue(ref: string): NetValue {
    const net = this.nodeNet.get(this.nodeOf(ref));
    const v = net === undefined ? undefined : this.values[net];
    return !v || v === UNKNOWN ? FLOATING : v;
  }
}
