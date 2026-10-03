/**
 * A circuit, in the same shape as Wokwi's diagram.json, so a Wokwi
 * project's diagram can be pasted in: the parts (type, position, rotation,
 * settings) and the wires between their pins.
 */
import { BOARDS, own, type BoardId, type BoardDef } from "./boards";

export interface DiagramPart {
  /** Unique within the diagram: "led1", "uno". */
  id: string;
  /** The part's drawing: "wokwi-led", "wokwi-arduino-uno". */
  type: string;
  left: number;
  top: number;
  /** Degrees: 0, 90, 180 or 270. */
  rotate?: number;
  attrs?: Record<string, string>;
}

/** [from "part:pin", to "part:pin", colour, route]. */
export type DiagramConnection = [string, string, string, string[]?];

export interface Diagram {
  version: 1;
  author?: string;
  editor?: string;
  parts: DiagramPart[];
  connections: DiagramConnection[];
}

const BOARD_TYPES: Record<string, BoardId> = {
  "wokwi-arduino-uno": "uno",
  "wokwi-arduino-nano": "nano",
  "wokwi-arduino-mega": "mega",
  "wokwi-esp32-devkit-v1": "esp32",
};

/** The board in a diagram: its part and which board it is. */
export function boardOf(d: Diagram): { part: DiagramPart; board: BoardDef } | null {
  for (const part of d.parts) {
    if (own(BOARD_TYPES, part.type)) return { part, board: BOARDS[BOARD_TYPES[part.type]] };
  }
  return null;
}

export const isBoardType = (type: string) => own(BOARD_TYPES, type);

/** "led1:A" → ["led1", "A"]. */
export function splitPin(ref: string): [string, string] | null {
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return null;
  return [ref.slice(0, at), ref.slice(at + 1)];
}

/**
 * A diagram read from text someone pasted or saved: checked for its shape,
 * never trusted. Unknown fields are dropped.
 */
export function parseDiagram(text: string): Diagram {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("That isn't a valid diagram (not JSON)."); }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.parts)) throw new Error("That isn't a valid diagram (no parts).");
  const ids = new Set<string>();
  const parts: DiagramPart[] = [];
  for (const p of raw.parts.slice(0, 300)) {
    if (!p || typeof p.id !== "string" || typeof p.type !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(p.id) || ids.has(p.id)) continue;
    if (!/^[a-z0-9-]{1,60}$/.test(p.type)) continue;
    ids.add(p.id);
    const attrs: Record<string, string> = {};
    if (p.attrs && typeof p.attrs === "object") {
      for (const [k, v] of Object.entries(p.attrs)) if (/^[A-Za-z0-9_]{1,40}$/.test(k) && (typeof v === "string" || typeof v === "number")) attrs[k] = String(v).slice(0, 200);
    }
    parts.push({
      id: p.id, type: p.type,
      left: Number.isFinite(p.left) ? Number(p.left) : 0,
      top: Number.isFinite(p.top) ? Number(p.top) : 0,
      rotate: [0, 90, 180, 270].includes(Number(p.rotate)) ? Number(p.rotate) : 0,
      attrs,
    });
  }
  const connections: DiagramConnection[] = [];
  for (const c of Array.isArray(raw.connections) ? raw.connections.slice(0, 2000) : []) {
    if (!Array.isArray(c) || typeof c[0] !== "string" || typeof c[1] !== "string") continue;
    const a = splitPin(c[0]);
    const b = splitPin(c[1]);
    if (!a || !b || !ids.has(a[0]) || !ids.has(b[0])) continue;
    const color = typeof c[2] === "string" && /^[A-Za-z0-9#]{1,20}$/.test(c[2]) ? c[2] : "green";
    const route = Array.isArray(c[3]) ? c[3].filter((s: unknown) => typeof s === "string").slice(0, 100) as string[] : [];
    connections.push([c[0], c[1], color, route]);
  }
  return { version: 1, author: typeof raw.author === "string" ? raw.author.slice(0, 100) : undefined, editor: "joint-agent", parts, connections };
}
