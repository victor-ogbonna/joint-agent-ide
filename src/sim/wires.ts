/**
 * Where a wire runs. A connection stores its bends as Wokwi does: moves
 * from the first pin ("h12.5" right, "v-10" up), then optionally "*" and
 * the last moves into the second pin. The rest is an L between the two.
 */
export interface Point {
  x: number;
  y: number;
}

const MOVE = /^([hv])(-?\d+(?:\.\d+)?)$/;

/** The corners of a wire from pin `a` to pin `b`. `firstAxis`: which way the first L leaves a pin when nothing says. */
export function wirePoints(a: Point, b: Point, route: string[] = [], firstAxis: "h" | "v" = "v"): Point[] {
  const star = route.indexOf("*");
  const head = star < 0 ? route : route.slice(0, star);
  const tail = star < 0 ? [] : route.slice(star + 1);
  const start: Point[] = [a];
  let p = a;
  let lastAxis: "h" | "v" | null = null;
  for (const step of head) {
    const m = MOVE.exec(step);
    if (!m) continue;
    const d = Number(m[2]);
    p = m[1] === "h" ? { x: p.x + d, y: p.y } : { x: p.x, y: p.y + d };
    lastAxis = m[1] as "h" | "v";
    start.push(p);
  }
  const end: Point[] = [b];
  let q = b;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = MOVE.exec(tail[i]);
    if (!m) continue;
    const d = Number(m[2]);
    q = m[1] === "h" ? { x: q.x - d, y: q.y } : { x: q.x, y: q.y - d };
    end.unshift(q);
  }
  const j = end[0];
  if (Math.abs(p.x - j.x) > 0.01 && Math.abs(p.y - j.y) > 0.01) {
    // Turn once: carry on across from the last bend, or leave the pin the way it faces.
    const axis = lastAxis ? (lastAxis === "h" ? "v" : "h") : firstAxis;
    start.push(axis === "h" ? { x: j.x, y: p.y } : { x: p.x, y: j.y });
  }
  return tidy([...start, ...end]);
}

/** Drops repeated points and corners that don't turn. */
function tidy(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const pt of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - pt.x) < 0.01 && Math.abs(last.y - pt.y) < 0.01) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - pt.x) < 0.01) || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - pt.y) < 0.01))) {
      out[out.length - 1] = pt;
      continue;
    }
    out.push(pt);
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Bends clicked while drawing a wire from `a` → route moves (each bend: across, then down). */
export function routeFrom(a: Point, bends: Point[]): string[] {
  const out: string[] = [];
  let p = a;
  for (const q of bends) {
    const dx = r1(q.x - p.x);
    const dy = r1(q.y - p.y);
    if (dx) out.push(`h${dx}`);
    if (dy) out.push(`v${dy}`);
    p = q;
  }
  return out;
}

/** An SVG path through the points. */
export function pathOf(points: Point[]): string {
  return points.map((pt, i) => `${i ? "L" : "M"}${r1(pt.x)} ${r1(pt.y)}`).join(" ");
}

/** Where a horizontal run from `a` to `b` (same y) crosses another wire's vertical run, strictly between ends. */
function crossings(a: Point, b: Point, others: Point[][], keepClear: number): number[] {
  const y = a.y;
  const lo = Math.min(a.x, b.x) + keepClear;
  const hi = Math.max(a.x, b.x) - keepClear;
  const xs: number[] = [];
  for (const other of others) {
    for (let i = 1; i < other.length; i++) {
      const p = other[i - 1];
      const q = other[i];
      if (Math.abs(p.x - q.x) > 0.01) continue; // only vertical runs
      const top = Math.min(p.y, q.y);
      const bottom = Math.max(p.y, q.y);
      // Strictly inside the vertical run: a wire ending on this one is a joint, not a crossing.
      if (y <= top + 0.5 || y >= bottom - 0.5) continue;
      if (p.x > lo && p.x < hi) xs.push(p.x);
    }
  }
  return xs;
}

/**
 * An SVG path through the points that hops over other wires: where one of
 * its horizontal runs crosses another wire's vertical run, it bridges it
 * with a small semicircle, so crossing wires never look joined.
 */
export function bridgedPath(points: Point[], others: Point[][], r = 4): string {
  if (points.length < 2) return pathOf(points);
  let d = `M${r1(points[0].x)} ${r1(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.x - b.x) > 2 * r + 2) {
      const dir = b.x > a.x ? 1 : -1;
      const xs = crossings(a, b, others, r + 1).sort((p, q) => (p - q) * dir);
      let last = -Infinity;
      for (const x of xs) {
        // Two crossings too close together share one bridge.
        if (Math.abs(x - last) < 2 * r + 1) continue;
        last = x;
        d += ` L${r1(x - dir * r)} ${r1(a.y)} A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${r1(x + dir * r)} ${r1(a.y)}`;
      }
    }
    d += ` L${r1(b.x)} ${r1(b.y)}`;
  }
  return d;
}
