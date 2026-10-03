/**
 * A project's circuit, between the forms it comes in: the project's board
 * (a build target), an old schematic (components and connections from
 * before), the circuit the agent builds, and the parts and wiring list the
 * share page and team views show.
 */
import { boardOf, splitPin, type Diagram, type DiagramConnection, type DiagramPart } from "./diagram";
import { BOARDS, type BoardId } from "./boards";
import { AGENT_PARTS, agentPartFor, boardPinName, BOARD_PIN_NAMES, type AgentPart } from "./agentParts";
import { BOARD_PARTS, nextId } from "./catalog";
import { autoLayout } from "./layout";

// ---- Which board ----

/**
 * The simulator's board for a project's board: its build target, and what
 * the board catalog says its chip and clock are when known. Null when the
 * simulator has no board like it (a Leonardo, an 8 MHz Pro Mini, an ESP32-S3).
 */
export function simBoardFor(boardId: string, chip?: string | null, fcpu?: number | null): BoardId | null {
  const id = String(boardId || "");
  const mcu = String(chip || "").toUpperCase();
  if (mcu) {
    const avrClockOk = !fcpu || fcpu === 16_000_000;
    if (mcu === "ATMEGA328P" && avrClockOk) return /^nano/i.test(id) ? "nano" : "uno";
    if (mcu === "ATMEGA2560" && avrClockOk) return "mega";
    if (mcu === "ESP32") return "esp32";
    return null;
  }
  if (id === "uno") return "uno";
  if (id === "nanoatmega328" || id === "nanoatmega328new") return "nano";
  if (id === "megaatmega2560") return "mega";
  if (id === "esp32dev") return "esp32";
  return null;
}

const boardPartType = (board: BoardId) => BOARD_PARTS.find((b) => b.id === board)!.type;

// ---- Wire colours ----

const SIGNAL_COLOURS = ["green", "blue", "orange", "purple", "yellow", "cyan", "magenta", "brown"];
const isGround = (pin: string) => /^(GND|VSS)(\.\d+)?$/i.test(pin);
const isPower = (pin: string) => /^(5V|3\.3V|3V3|VCC|VIN|VDD|V\+|IOREF)(\.\d+)?$/i.test(pin);

/** Black to ground, red to power, and each signal its own colour. */
export function colourFor(a: string, b: string, signal: number): string {
  const pins = [a, b].map((r) => splitPin(r)?.[1] ?? "");
  if (pins.some(isGround)) return "black";
  if (pins.some(isPower)) return "red";
  return SIGNAL_COLOURS[signal % SIGNAL_COLOURS.length];
}

// ---- A circuit with the project's board ----

/** A circuit with only the board in it. */
export function emptyCircuit(board: BoardId): Diagram {
  return { version: 1, editor: "joint-agent", parts: [{ id: board, type: boardPartType(board), left: 0, top: 0, rotate: 0, attrs: {} }], connections: [] };
}

/**
 * The circuit on the project's board: the board swapped for it if another,
 * each wire to the old board moved to the pin of the same name (or meaning:
 * "13" on an Uno is "D13" on an ESP32), and the wires to pins it hasn't
 * dropped, counted.
 */
export function withBoard(d: Diagram, board: BoardId): { diagram: Diagram; dropped: number } {
  const current = boardOf(d);
  const type = boardPartType(board);
  if (!current) {
    const id = d.parts.some((p) => p.id === board) ? nextId(board, d.parts.map((p) => p.id)) : board;
    return { diagram: { ...d, parts: [{ id, type, left: 0, top: 0, rotate: 0, attrs: {} }, ...d.parts] }, dropped: 0 };
  }
  if (current.part.type === type) return { diagram: d, dropped: 0 };
  const oldId = current.part.id;
  const taken = d.parts.filter((p) => p !== current.part).map((p) => p.id);
  const newId = taken.includes(board) ? nextId(board, taken) : board;
  const names = BOARD_PIN_NAMES[board];
  const mapPin = (pin: string): string | null => {
    if (names.includes(pin)) return pin;
    const bare = pin.replace(/\.\d+$/, "");
    if (names.includes(bare)) return bare;
    if (names.includes(`${bare}.1`)) return `${bare}.1`;
    return boardPinName(board, bare);
  };
  let dropped = 0;
  const connections: DiagramConnection[] = [];
  for (const c of d.connections) {
    const ends = [c[0], c[1]].map((ref) => {
      const s = splitPin(ref);
      if (!s || s[0] !== oldId) return ref;
      const pin = mapPin(s[1]);
      return pin ? `${newId}:${pin}` : null;
    });
    if (ends[0] && ends[1]) connections.push([ends[0], ends[1], c[2], c[3] ?? []]);
    else dropped++;
  }
  return {
    diagram: { ...d, parts: d.parts.map((p) => (p === current.part ? { ...p, id: newId, type, attrs: {} } : p)), connections },
    dropped,
  };
}

// ---- Parts by key, for the agent's circuits and old schematics ----

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

/** A new part of a kind, with the settings it may take (the rest ignored). */
function partOf(spec: AgentPart, id: string, settings: Record<string, unknown> = {}): DiagramPart {
  const attrs: Record<string, string> = { ...(spec.attrs ?? {}) };
  for (const key of Object.keys(spec.settings ?? {})) {
    const v = settings[key];
    if ((typeof v === "string" || typeof v === "number") && String(v).length <= 40 && /^[A-Za-z0-9 ._#-]*$/.test(String(v))) attrs[key] = String(v).trim();
  }
  return { id, type: spec.type, left: 0, top: 0, rotate: 0, attrs };
}

/** "mcu", "board", "arduino", "esp32": the board, however a circuit names it. */
const BOARD_NAMES = new Set(["mcu", "board", "arduino", "esp32", "uno", "nano", "mega", "microcontroller"]);

// ---- The agent's circuit ----

export interface AgentCircuitResult {
  diagram: Diagram;
  /** What was left out, and why, for the terminal. */
  skipped: string[];
}

/**
 * The circuit the agent built ({ parts: [{ id, type, settings }], connections:
 * [{ from: "led1:A", to: "mcu:13" }] }) as a laid-out diagram on the project's
 * board. Never trusted: parts of no known kind, pins a part hasn't and wires to
 * nothing are left out and listed.
 */
export function agentCircuitToDiagram(raw: unknown, board: BoardId): AgentCircuitResult {
  const skipped: string[] = [];
  const base = emptyCircuit(board);
  const boardId = base.parts[0].id;
  const parts: DiagramPart[] = [base.parts[0]];
  const specs = new Map<string, AgentPart>();
  const input = (raw && typeof raw === "object" ? raw : {}) as { parts?: unknown; connections?: unknown };
  for (const p of Array.isArray(input.parts) ? input.parts.slice(0, 80) : []) {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    const key = typeof p?.type === "string" ? p.type.trim() : "";
    const spec = agentPartFor(key);
    if (!SAFE_ID.test(id) || BOARD_NAMES.has(id.toLowerCase()) || specs.has(id)) { skipped.push(`a part named "${String(p?.id ?? "").slice(0, 30)}" (needs a unique plain id)`); continue; }
    if (!spec) { skipped.push(`${id}: no part called "${key.slice(0, 30)}"`); continue; }
    specs.set(id, spec);
    parts.push(partOf(spec, id, p?.settings && typeof p.settings === "object" ? p.settings : p?.attrs && typeof p.attrs === "object" ? p.attrs : {}));
  }
  const end = (ref: unknown): string | null => {
    if (typeof ref !== "string") return null;
    const s = splitPin(ref.trim());
    if (!s) return null;
    const [who, pin] = [s[0].trim(), s[1].trim()];
    if (BOARD_NAMES.has(who.toLowerCase()) || who === boardId) {
      const name = boardPinName(board, pin);
      return name ? `${boardId}:${name}` : null;
    }
    const spec = specs.get(who);
    if (!spec) return null;
    const exact = spec.pins.find((n) => n === pin) ?? spec.pins.find((n) => n.toLowerCase() === pin.toLowerCase());
    return exact ? `${who}:${exact}` : null;
  };
  const connections: DiagramConnection[] = [];
  const seen = new Set<string>();
  let signal = 0;
  for (const c of Array.isArray(input.connections) ? input.connections.slice(0, 300) : []) {
    const a = end(c?.from);
    const b = end(c?.to);
    if (!a || !b) { skipped.push(`wire ${String(c?.from ?? "?").slice(0, 30)} → ${String(c?.to ?? "?").slice(0, 30)}`); continue; }
    if (a === b) continue;
    const key = [a, b].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const colour = colourFor(a, b, signal);
    if (colour !== "black" && colour !== "red") signal++;
    connections.push([a, b, colour, []]);
  }
  return { diagram: autoLayout({ version: 1, editor: "joint-agent", parts, connections }), skipped };
}

// ---- Old schematics ----

interface LegacyComponent { id: string; type: string; label?: string; value?: string }
interface LegacyConnection { fromComponentId: string; fromPin: string; toComponentId: string; toPin: string; color?: string }

/** The old schematic's kinds of part → today's, with how their pins were named. */
const LEGACY: Record<string, { key: string; pins: Record<string, string> }> = {
  led: { key: "led", pins: { anode: "A", cathode: "C" } },
  resistor: { key: "resistor", pins: { pin1: "1", pin2: "2" } },
  dht11: { key: "dht11", pins: { vcc: "VCC", data: "SDA", gnd: "GND" } },
  servo: { key: "servo", pins: { gnd: "GND", vcc: "V+", pwm: "PWM" } },
  lcd: { key: "lcd1602-i2c", pins: { vcc: "VCC", gnd: "GND", sda: "SDA", scl: "SCL" } },
  button: { key: "pushbutton", pins: { pin1: "1.l", pin2: "2.l" } },
  relay: { key: "relay-module", pins: { vcc: "VCC", gnd: "GND", in: "IN", no: "NO", com: "COM", nc: "NC" } },
  buzzer: { key: "buzzer", pins: { vcc: "2", gnd: "1" } },
  potentiometer: { key: "potentiometer", pins: { gnd: "GND", sig: "SIG", vcc: "VCC" } },
  pir: { key: "pir", pins: { vcc: "VCC", out: "OUT", gnd: "GND" } },
  neopixel: { key: "neopixel", pins: { vdd: "VDD", din: "DIN", dout: "DOUT", gnd: "VSS" } },
  ultrasonic: { key: "ultrasonic", pins: { vcc: "VCC", trig: "TRIG", echo: "ECHO", gnd: "GND" } },
  keypad: { key: "keypad", pins: { r1: "R1", r2: "R2", r3: "R3", r4: "R4", c1: "C1", c2: "C2", c3: "C3", c4: "C4" } },
  oled: { key: "oled", pins: { vcc: "VIN", gnd: "GND", scl: "CLK", sda: "DATA" } },
  rgb: { key: "rgb-led", pins: { r: "R", g: "G", b: "B", com: "COM" } },
  switch: { key: "slide-switch", pins: { pin1: "1", common: "2", pin2: "3" } },
  "7segment": { key: "7segment", pins: { a: "A", b: "B", c: "C", d: "D", e: "E", f: "F", g: "G", dp: "DP", com1: "COM.1", com2: "COM.2" } },
  joystick: { key: "joystick", pins: { vcc: "VCC", gnd: "GND", vrx: "HORZ", vry: "VERT", sw: "SEL" } },
};

const COLOUR_WORD = /\b(red|green|blue|yellow|orange|white|purple)\b/i;

/** "220R", "4.7k Ohm", "10 kΩ" → "220", "4700", "10000"; null when it isn't a value. */
export function ohmsText(text: string | undefined): string | null {
  const m = /([\d.]+)\s*([kKmM]?)/.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2] === "M" ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : null;
}

/**
 * An old schematic as a laid-out circuit on the project's board. Parts of a
 * kind the simulator hasn't, and wires to pins it can't find, are left out
 * and counted.
 */
export function legacyToDiagram(components: unknown, connections: unknown, board: BoardId): { diagram: Diagram; dropped: number } {
  const base = emptyCircuit(board);
  const boardId = base.parts[0].id;
  const parts: DiagramPart[] = [base.parts[0]];
  const kinds = new Map<string, { spec: AgentPart; pins: Record<string, string> }>();
  let dropped = 0;
  for (const c of (Array.isArray(components) ? components : []).slice(0, 200) as LegacyComponent[]) {
    const id = typeof c?.id === "string" ? c.id : "";
    if (!SAFE_ID.test(id) || BOARD_NAMES.has(id.toLowerCase()) || kinds.has(id)) { dropped++; continue; }
    // A part saved from this simulator keeps its own drawing's type.
    const direct = AGENT_PARTS.find((p) => p.type === c.type);
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY, c.type) ? LEGACY[c.type] : null;
    const spec = direct ?? (legacy ? agentPartFor(legacy.key) : undefined);
    if (!spec) { dropped++; continue; }
    const settings: Record<string, string> = {};
    if (spec.key === "led") { const m = COLOUR_WORD.exec(`${c.label ?? ""} ${c.value ?? ""}`); if (m) settings.color = m[1].toLowerCase(); }
    if (spec.key === "resistor") { const v = ohmsText(c.value) ?? ohmsText(c.label); if (v) settings.value = v; }
    kinds.set(id, { spec, pins: legacy && !direct ? legacy.pins : Object.fromEntries(spec.pins.map((p) => [p.toLowerCase(), p])) });
    parts.push(partOf(spec, id, settings));
  }
  const end = (who: unknown, pin: unknown): string | null => {
    if (typeof who !== "string" || typeof pin !== "string") return null;
    if (BOARD_NAMES.has(who.toLowerCase()) || who === boardId) {
      const name = boardPinName(board, pin);
      return name ? `${boardId}:${name}` : null;
    }
    const k = kinds.get(who);
    if (!k) return null;
    const mapped = k.pins[pin.toLowerCase()] ?? k.spec.pins.find((p) => p.toLowerCase() === pin.toLowerCase());
    return mapped ? `${who}:${mapped}` : null;
  };
  const wires: DiagramConnection[] = [];
  const seen = new Set<string>();
  let signal = 0;
  for (const w of (Array.isArray(connections) ? connections : []).slice(0, 500) as LegacyConnection[]) {
    const a = end(w?.fromComponentId, w?.fromPin);
    const b = end(w?.toComponentId, w?.toPin);
    if (!a || !b) { dropped++; continue; }
    const key = [a, b].sort().join("|");
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    const colour = colourFor(a, b, signal);
    if (colour !== "black" && colour !== "red") signal++;
    wires.push([a, b, colour, []]);
  }
  return { diagram: autoLayout({ version: 1, editor: "joint-agent", parts, connections: wires }), dropped };
}

// ---- For the share page and team views ----

/** Settings that are a look or a starting value, not what kind of part it is. */
const STARTING_VALUES = new Set(["temperature", "humidity", "distance", "lux", "color", "horn", "travelLength"]);

/**
 * Which kind a placed part is: of the kinds with its drawing, the one whose
 * defining settings (an LCD's "i2c", a DHT11's sensor) it has, the most
 * specific first.
 */
export function specOfPart(p: Pick<DiagramPart, "type" | "attrs">): AgentPart | undefined {
  let best: AgentPart | undefined;
  let bestScore = -1;
  for (const spec of AGENT_PARTS) {
    if (spec.type !== p.type) continue;
    const defining = Object.entries(spec.attrs ?? {}).filter(([k]) => !(spec.settings && k in spec.settings) && !STARTING_VALUES.has(k));
    if (!defining.every(([k, v]) => (p.attrs ?? {})[k] === v)) continue;
    if (defining.length > bestScore) { best = spec; bestScore = defining.length; }
  }
  return best ?? AGENT_PARTS.find((s) => s.type === p.type);
}

const COLOUR_HEX: Record<string, string> = {
  green: "#22c55e", red: "#ef4444", black: "#000000", blue: "#3b82f6", yellow: "#eab308", orange: "#f97316", purple: "#a855f7",
  white: "#ffffff", gray: "#9ca3af", grey: "#9ca3af", brown: "#92400e", cyan: "#06b6d4", magenta: "#d946ef",
};

/** The circuit as the parts list and wiring list the share page and team views show. */
export function diagramToLegacy(d: Diagram): {
  components: { id: string; type: string; label: string; value?: string; x: number; y: number; rotation: number }[];
  connections: { id: string; fromComponentId: string; fromPin: string; toComponentId: string; toPin: string; color: string }[];
} {
  const board = boardOf(d);
  const legacyKey = (spec: AgentPart | undefined) => (spec ? Object.entries(LEGACY).find(([, v]) => v.key === spec.key)?.[0] : undefined);
  const components = d.parts
    .filter((p) => p !== board?.part)
    .map((p) => {
      const spec = specOfPart(p);
      const value = p.type === "wokwi-resistor" ? `${p.attrs?.value ?? "1000"} Ω` : p.attrs?.color;
      return {
        id: p.id,
        type: legacyKey(spec) ?? p.type.replace(/^wokwi-/, ""),
        label: spec?.name ?? p.type.replace(/^wokwi-/, ""),
        ...(value ? { value } : {}),
        x: p.left,
        y: p.top,
        rotation: p.rotate ?? 0,
      };
    });
  const side = (ref: string): [string, string] => {
    const s = splitPin(ref) ?? [ref, ""];
    return [s[0] === board?.part.id ? "mcu" : s[0], s[1]];
  };
  const connections = d.connections.map((c, i) => {
    const [fromComponentId, fromPin] = side(c[0]);
    const [toComponentId, toPin] = side(c[1]);
    return { id: `w${i + 1}`, fromComponentId, fromPin, toComponentId, toPin, color: COLOUR_HEX[c[2]] ?? (/^#[0-9a-f]{3,8}$/i.test(c[2]) ? c[2] : "#22c55e") };
  });
  return { components, connections };
}

/** The board names the simulator offers, for messages. */
export const SIM_BOARD_NAMES = Object.values(BOARDS).map((b) => b.name);
