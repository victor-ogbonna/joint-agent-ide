/**
 * The messages between the page and an ESP32 running on the server
 * (server/esp32Sim.ts), over one WebSocket at /ws/esp32. JSON, with a part's
 * byte arrays (pixels, a display's memory) as base64.
 *
 * Page → server:
 *   { type: "start", token, diagram, firmware: { app, bootloader?, partitions?, bootApp0? } }  (base64)
 *   { type: "input", part, name, value }    a button pressed, a knob turned, a sensor set
 *   { type: "serial", text }                typed into the Serial Monitor
 *   { type: "pause" } / { type: "resume" }
 * Server → page:
 *   { type: "ready" }                       the chip is running
 *   { type: "frame", ms, speed, shorted, views: [[part, version, state]], leds }
 *   { type: "serial", text }                what the program printed
 *   { type: "error", message }              it stopped, and why
 */

/** A byte array in a part's state, as text. */
interface Bytes { $u8: string }

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A part's state, ready for JSON. */
export function encodeState(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $u8: toBase64(value) } satisfies Bytes;
  if (Array.isArray(value)) return value.map(encodeState);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeState(v);
    return out;
  }
  return value;
}

/** A part's state as it was before encodeState. */
export function decodeState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeState);
  if (value && typeof value === "object") {
    const b = value as Partial<Bytes>;
    if (typeof b.$u8 === "string" && Object.keys(value).length === 1) return fromBase64(b.$u8);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = decodeState(v);
    }
    return out;
  }
  return value;
}
