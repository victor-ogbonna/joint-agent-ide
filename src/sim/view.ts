/**
 * Between the running circuit and the part drawings (@wokwi/elements):
 * settings onto a drawing, what a part's model shows onto its drawing, and
 * what's done to a drawing (a press, a turn) back to the model.
 */
import { fontA00 } from "@wokwi/elements";

type El = HTMLElement & Record<string, any>;

/**
 * A part's settings onto its drawing. Only the settings the drawing itself
 * declares are set: a pasted diagram's attrs are someone else's text, and a
 * name like "innerHTML" must never reach the element.
 */
export function applyAttrs(el: El, attrs: Record<string, string>) {
  const declared = (el.constructor as { elementProperties?: Map<string, unknown> }).elementProperties;
  if (!declared) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (!declared.has(key)) continue;
    const current = el[key];
    if (typeof current === "number") { const n = Number(value); if (Number.isFinite(n)) el[key] = n; }
    else if (typeof current === "boolean") el[key] = value !== "" && value !== "0" && value !== "false";
    else if (typeof current === "string" || current === null || current === undefined) el[key] = value;
  }
}

/** The LCD font with the program's own characters (createChar) in codes 0-7 and their copies 8-15. */
function fontWith(cgram: Uint8Array): Uint8Array {
  const font = fontA00.slice();
  for (let code = 0; code < 16; code++) {
    for (let row = 0; row < 8; row++) {
      const bits = cgram[(code & 7) * 8 + row] & 0x1f;
      // The controller's leftmost dot is bit 4; the drawing's is bit 0.
      let mirrored = 0;
      for (let b = 0; b < 5; b++) if (bits & (1 << (4 - b))) mirrored |= 1 << b;
      font[code * 8 + row] = mirrored;
    }
  }
  return font;
}

const cgramKey = new WeakMap<El, string>();

/** What a part's model shows, onto its drawing. */
export function applyState(type: string, el: El, state: any, attrs: Record<string, string>) {
  switch (type) {
    case "wokwi-led":
      el.value = state.brightness > 0;
      el.brightness = state.brightness;
      break;
    case "wokwi-rgb-led":
      el.ledRed = state.r;
      el.ledGreen = state.g;
      el.ledBlue = state.b;
      break;
    case "wokwi-led-bar-graph":
      el.values = state.values.map((v: number) => (v > 0 ? 1 : 0));
      break;
    case "wokwi-7segment":
      el.values = state.values;
      el.colonValue = state.colon;
      break;
    case "wokwi-neopixel": {
      const p: Uint8Array = state.pixels;
      el.r = p[0] / 255;
      el.g = p[1] / 255;
      el.b = p[2] / 255;
      break;
    }
    case "wokwi-led-ring": {
      const p: Uint8Array = state.pixels;
      for (let i = 0; i * 3 < p.length; i++) el.setPixel?.(i, { r: p[i * 3] / 255, g: p[i * 3 + 1] / 255, b: p[i * 3 + 2] / 255 });
      break;
    }
    case "wokwi-neopixel-matrix": {
      const p: Uint8Array = state.pixels;
      const cols = Math.max(1, Number(attrs.cols) || 8);
      const serpentine = attrs.layout === "serpentine";
      for (let i = 0; i * 3 < p.length; i++) {
        const row = Math.floor(i / cols);
        let col = i % cols;
        if (serpentine && row % 2 === 1) col = cols - 1 - col;
        el.setPixel?.(row, col, { r: p[i * 3] / 255, g: p[i * 3 + 1] / 255, b: p[i * 3 + 2] / 255 });
      }
      break;
    }
    case "wokwi-servo":
      el.angle = state.angle;
      break;
    case "wokwi-buzzer":
      el.hasSignal = state.frequency > 0;
      break;
    case "wokwi-pushbutton":
    case "wokwi-pushbutton-6mm":
      el.pressed = state.pressed;
      break;
    case "wokwi-lcd1602":
    case "wokwi-lcd2004": {
      el.characters = state.characters;
      el.cursor = state.cursor;
      el.blink = state.blink;
      el.cursorX = state.cursorX;
      el.cursorY = state.cursorY;
      el.backlight = state.backlight;
      const key = Array.from(state.cgram as Uint8Array).join(",");
      if (cgramKey.get(el) !== key) {
        cgramKey.set(el, key);
        el.font = fontWith(state.cgram);
      }
      break;
    }
    case "wokwi-ssd1306": {
      const img: ImageData | undefined = el.imageData;
      if (!img) break;
      const px: Uint8Array = state.pixels;
      const d = img.data;
      for (let i = 0; i < px.length; i++) {
        const o = i * 4;
        if (px[i]) { d[o] = 214; d[o + 1] = 236; d[o + 2] = 255; } else { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; }
        d[o + 3] = 255;
      }
      el.redraw?.();
      break;
    }
    case "wokwi-photoresistor-sensor":
      el.ledPower = true;
      el.ledDO = !state.dark;
      break;
  }
}

/** The board's own LEDs. */
export function applyBoard(el: El, leds: { led13: number; tx: boolean; rx: boolean }, running: boolean) {
  el.led13 = leds.led13 > 0.05;
  el.ledTX = leds.tx;
  el.ledRX = leds.rx;
  el.ledPower = running;
}

/** What's done to a drawing, as inputs to its model. Returns a function that stops listening. */
export function bindInputs(type: string, el: El, send: (name: string, value: unknown) => void): () => void {
  const on: [string, (e: any) => void][] = [];
  switch (type) {
    case "wokwi-pushbutton":
    case "wokwi-pushbutton-6mm":
      on.push(["button-press", () => send("press", true)], ["button-release", () => send("press", false)]);
      break;
    case "wokwi-slide-switch":
      on.push(["input", () => send("value", el.value)]);
      break;
    case "wokwi-potentiometer":
    case "wokwi-slide-potentiometer":
      on.push(["input", () => send("value", el.value)]);
      break;
    case "wokwi-dip-switch-8":
      on.push(["switch-change", (e) => send("toggle", e.detail)]);
      break;
    case "wokwi-analog-joystick":
      on.push(
        ["input", () => { send("x", el.xValue); send("y", el.yValue); }],
        ["button-press", () => send("press", true)],
        ["button-release", () => send("press", false)],
      );
      break;
    case "wokwi-membrane-keypad":
      on.push(
        ["button-press", (e) => send("key", { row: e.detail.row, column: e.detail.column, pressed: true })],
        ["button-release", (e) => send("key", { row: e.detail.row, column: e.detail.column, pressed: false })],
      );
      break;
    case "wokwi-ky-040":
      on.push(
        ["rotate-cw", () => send("rotate", 1)],
        ["rotate-ccw", () => send("rotate", -1)],
        ["button-press", () => send("press", true)],
        ["button-release", () => send("press", false)],
      );
      break;
  }
  for (const [name, fn] of on) el.addEventListener(name, fn);
  return () => { for (const [name, fn] of on) el.removeEventListener(name, fn); };
}

/** Parts whose drawing is something to press or turn while running. */
export const INTERACTIVE = new Set([
  "wokwi-pushbutton", "wokwi-pushbutton-6mm", "wokwi-slide-switch", "wokwi-potentiometer", "wokwi-slide-potentiometer",
  "wokwi-dip-switch-8", "wokwi-analog-joystick", "wokwi-membrane-keypad", "wokwi-ky-040",
]);
