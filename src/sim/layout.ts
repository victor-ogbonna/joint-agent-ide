/**
 * Where the parts of a circuit nobody has arranged go (one the agent built,
 * or an old schematic opened for the first time): the board on the left,
 * and to its right one row for each board pin a part hangs off, in the
 * board's pin order, with the parts wired on from it (a resistor, then its
 * LED) further along the same row. Power and ground don't count as where a
 * part hangs off: everything shares them.
 */
import { boardOf, splitPin, type Diagram, type DiagramPart } from "./diagram";
import { BOARD_PIN_NAMES } from "./agentParts";

/** About how big each drawing is (px), for spacing. Measured from the drawings. */
const SIZES: Record<string, [number, number]> = {
  "wokwi-arduino-uno": [274, 202], "wokwi-arduino-nano": [170, 67], "wokwi-arduino-mega": [388, 192], "wokwi-esp32-devkit-v1": [107, 204],
  "wokwi-led": [40, 50], "wokwi-rgb-led": [42, 73], "wokwi-resistor": [59, 11], "wokwi-led-bar-graph": [38, 96],
  "wokwi-pushbutton": [67, 48], "wokwi-pushbutton-6mm": [28, 26], "wokwi-slide-switch": [32, 35], "wokwi-dip-switch-8": [83, 55],
  "wokwi-potentiometer": [76, 76], "wokwi-slide-potentiometer": [208, 110], "wokwi-analog-joystick": [103, 120],
  "wokwi-membrane-keypad": [266, 287], "wokwi-ky-040": [117, 70], "wokwi-tilt-switch": [88, 56], "wokwi-buzzer": [75, 84],
  "wokwi-servo": [170, 120], "wokwi-neopixel": [21, 19], "wokwi-led-ring": [142, 153], "wokwi-neopixel-matrix": [198, 178],
  "wokwi-7segment": [47, 83], "wokwi-lcd1602": [302, 136], "wokwi-lcd2004": [356, 180], "wokwi-ssd1306": [150, 123],
  "wokwi-dht22": [57, 117], "wokwi-hc-sr04": [170, 95], "wokwi-pir-motion-sensor": [91, 92], "wokwi-photoresistor-sensor": [174, 62],
  "wokwi-ntc-temperature-sensor": [135, 72], "wokwi-ds1307": [98, 84], "wokwi-mpu6050": [82, 61], "wokwi-stepper-motor": [220, 236],
  "wokwi-ir-receiver": [61, 89], "wokwi-ir-remote": [151, 316], "wokwi-hx711": [219, 163], "wokwi-gas-sensor": [137, 63],
  "wokwi-flame-sensor": [200, 62], "wokwi-small-sound-sensor": [133, 50], "wokwi-big-sound-sensor": [140, 50],
  "wokwi-heart-beat-sensor": [88, 79], "wokwi-ili9341": [176, 300], "wokwi-ks2e-m-dc5": [79, 38], "wokwi-rotary-dialer": [266, 286],
  "wokwi-microsd-card": [82, 77], "wokwi-biaxial-stepper": [212, 255],
};

export function sizeOf(part: Pick<DiagramPart, "type" | "attrs">): [number, number] {
  const a = part.attrs ?? {};
  if (part.type === "wokwi-7segment") return [Math.max(1, Number(a.digits) || 1) * 47, 83];
  if (part.type === "wokwi-neopixel-matrix") {
    const rows = Math.max(1, Number(a.rows) || 8);
    const cols = Math.max(1, Number(a.cols) || 8);
    return [cols * 24 + 6, rows * 22 + 6];
  }
  return SIZES[part.type] ?? [120, 90];
}

const isRail = (pin: string) => /^(GND|VSS|5V|3V3|3\.3V|VIN|IOREF|AREF|RESET|EN)(\.\d+)?$/i.test(pin);

/** The circuit with every part but the board placed, the board at the origin. */
export function autoLayout(d: Diagram): Diagram {
  const found = boardOf(d);
  if (!found) return d;
  const board = found.part;
  const order = BOARD_PIN_NAMES[found.board.id];
  const [bw] = sizeOf(board);
  const others = d.parts.filter((p) => p !== board);

  // Who is wired to whom.
  const links = new Map<string, Set<string>>(others.map((p) => [p.id, new Set<string>()]));
  const anchor = new Map<string, number>();
  for (const [a, b] of d.connections) {
    const sa = splitPin(a);
    const sb = splitPin(b);
    if (!sa || !sb) continue;
    for (const [mine, theirs] of [[sa, sb], [sb, sa]] as const) {
      if (mine[0] === board.id) continue;
      if (theirs[0] === board.id) {
        if (isRail(theirs[1])) continue;
        const i = order.indexOf(theirs[1]);
        const at = i < 0 ? order.length : i;
        anchor.set(mine[0], Math.min(anchor.get(mine[0]) ?? Infinity, at));
      } else if (theirs[0] !== mine[0]) {
        links.get(mine[0])?.add(theirs[0]);
      }
    }
  }

  // Rows: each part on a board pin starts one; the parts wired on from it follow along it.
  const rows: DiagramPart[][] = [];
  const placed = new Set<string>();
  const starts = others
    .filter((p) => anchor.has(p.id))
    .sort((p, q) => anchor.get(p.id)! - anchor.get(q.id)!);
  const grow = (row: DiagramPart[], from: DiagramPart) => {
    for (const id of links.get(from.id) ?? []) {
      if (placed.has(id)) continue;
      const next = others.find((p) => p.id === id);
      if (!next || anchor.has(id)) continue;
      placed.add(id);
      row.push(next);
      grow(row, next);
      return; // one chain per row; branches start rows of their own below
    }
  };
  for (const p of starts) {
    if (placed.has(p.id)) continue;
    placed.add(p.id);
    const row = [p];
    grow(row, p);
    rows.push(row);
  }
  // Parts wired only to other parts, or to nothing: rows of their own, chained where they can be.
  for (const p of others) {
    if (placed.has(p.id)) continue;
    placed.add(p.id);
    const row = [p];
    grow(row, p);
    rows.push(row);
  }

  // Columns line up across rows: each column as wide as its widest part.
  const colWidths: number[] = [];
  for (const row of rows) row.forEach((p, i) => { colWidths[i] = Math.max(colWidths[i] ?? 0, sizeOf(p)[0]); });
  const gapX = 70;
  const gapY = 46;
  const band = Math.max(600, sizeOf(board)[1] * 2.5);
  const at = new Map<string, { left: number; top: number }>();
  let x0 = bw + 110;
  let y = 0;
  let bandWidth = 0;
  for (const row of rows) {
    const h = Math.max(...row.map((p) => sizeOf(p)[1]));
    if (y > 0 && y + h > band) {
      x0 += bandWidth + gapX * 2;
      y = 0;
      bandWidth = 0;
    }
    let x = x0;
    row.forEach((p, i) => {
      const [w, ph] = sizeOf(p);
      at.set(p.id, { left: Math.round(x), top: Math.round(y + (h - ph) / 2) });
      x += colWidths[i] + gapX;
    });
    bandWidth = Math.max(bandWidth, x - gapX - x0);
    y += h + gapY;
  }

  return {
    ...d,
    parts: d.parts.map((p) => (p === board ? { ...p, left: 0, top: 0, rotate: 0 } : { ...p, ...(at.get(p.id) ?? {}), rotate: 0 })),
  };
}
