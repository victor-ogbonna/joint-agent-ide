import React, { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, OctagonAlert, Table2, BarChart3 } from "lucide-react";
import { full } from "./format";

/**
 * The dashboard's building blocks: cards, stat tiles, a column chart, a bar
 * list and meters, drawn in plain SVG so they follow the app's theme.
 * Marks are thin (bars at most 24px, 4px rounded ends, square on the
 * baseline), grid and axes recede, text keeps the text colours, and every
 * chart has a hover readout and a table view, so no value is reachable only
 * by hovering.
 */

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** A clean top for the axis: 1, 2, 5, 10, 20, 50… */
function niceMax(max: number): number {
  if (max <= 0) return 4;
  if (max <= 4) return Math.ceil(max);
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

function ticksFor(top: number): number[] {
  if (top <= 4) return Array.from({ length: top + 1 }, (_, i) => i);
  return [0, top / 2, top];
}

export function Card({ title, subtitle, action, children, className = "" }: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-[13px] font-semibold text-[var(--text-main)]">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * One figure with a label. `alert` marks the figure itself as a problem;
 * `warning` adds a problem about something next to it, with an icon, and
 * leaves the figure as it is.
 */
export function StatTile({ label, value, detail, alert = false, warning }: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  alert?: boolean;
  warning?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3.5">
      <p className="truncate text-[11px] text-[var(--text-muted)]">{label}</p>
      <p className={`mt-1 break-words text-2xl font-semibold leading-tight ${alert ? "text-[var(--viz-alert-text)]" : "text-[var(--text-main)]"}`}>{value}</p>
      {detail && <div className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{detail}</div>}
      {warning && (
        <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-[var(--viz-alert-text)]">
          <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

export type Level = "ok" | "busy" | "overloaded";

export function StatusBadge({ level, large = false }: { level: Level; large?: boolean }) {
  const map = {
    ok: { Icon: CheckCircle2, text: "OK", color: "var(--viz-good)" },
    busy: { Icon: AlertTriangle, text: "Busy", color: "var(--viz-warning)" },
    overloaded: { Icon: OctagonAlert, text: "Overloaded", color: "var(--viz-critical)" },
  }[level];
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold text-[var(--text-main)] ${large ? "text-lg" : "text-[13px]"}`}>
      <map.Icon size={large ? 20 : 15} style={{ color: map.color }} aria-hidden="true" />
      {map.text}
    </span>
  );
}

/** A proportion with a severity: blue while comfortable, then amber, then red, with a word, never colour alone. */
export function Meter({ label, used, total, detail, high = 70, critical = 90 }: {
  label: string;
  used: number;
  total: number;
  detail?: React.ReactNode;
  high?: number;
  critical?: number;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
  const level = pct >= critical ? "critical" : pct >= high ? "high" : "ok";
  const fill = level === "critical" ? "var(--viz-critical)" : level === "high" ? "var(--viz-warning)" : "var(--viz-series-1)";
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] text-[var(--text-muted)]">{label}</span>
        <span className="ml-auto text-[13px] font-semibold text-[var(--text-main)]">
          {pct}%{level !== "ok" && <span className="ml-1 text-[11px] font-medium text-[var(--text-muted)]">{level === "critical" ? "very high" : "high"}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--viz-track)" }}
        role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: fill }} />
      </div>
      {detail && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{detail}</p>}
    </div>
  );
}

/** Horizontal bars for comparing a few amounts, each labelled with its value. */
export function BarList({ items, formatValue = full, emptyText = "Nothing yet." }: {
  items: { label: string; value: number; note?: string }[];
  formatValue?: (v: number) => string;
  emptyText?: string;
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length || max === 0) return <p className="py-4 text-center text-[12px] text-[var(--text-muted)]">{emptyText}</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((it) => (
        <li key={it.label}>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="min-w-0 truncate text-[var(--text-main)]">{it.label}</span>
            {it.note && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{it.note}</span>}
            <span className="ml-auto shrink-0 font-semibold tabular-nums text-[var(--text-main)]">{formatValue(it.value)}</span>
          </div>
          <div className="mt-1 h-2 w-full">
            <div className="h-full rounded-r" style={{ width: `${Math.max(1, (it.value / max) * 100)}%`, background: "var(--viz-series-1)", minWidth: 2 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

/**
 * Columns over time, one series or two stacked. Hover (or touch, or the
 * arrow keys) shows every series' value for that day; the axis carries
 * clean round numbers.
 */
export function ColumnChart({ rows, xKey, series, height = 170, formatX, formatTooltipX, formatValue = full, formatTick, label }: {
  rows: Record<string, any>[];
  xKey: string;
  series: ColumnSeries[];
  height?: number;
  formatX: (x: any) => string;
  formatTooltipX?: (x: any) => string;
  formatValue?: (v: number) => string;
  /** The axis numbers, when they need to be shorter than the tooltip's. */
  formatTick?: (v: number) => string;
  /** What the chart shows, for screen readers. */
  label: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useWidth(boxRef);
  const [hover, setHover] = useState<number | null>(null);
  const tipId = useId();
  const n = rows.length;
  const sums = rows.map((r) => series.reduce((a, s) => a + (Number(r[s.key]) || 0), 0));
  const max = Math.max(0, ...sums);
  const top = niceMax(max);
  const ticks = ticksFor(top);
  const tickText = (v: number) => (formatTick ?? formatValue)(v);
  // Room for the axis numbers on the left, and for half of the first and
  // last date labels, which sit centred under their columns.
  const labelHalf = (i: number) => (n ? formatX(rows[i][xKey]).length * 3.1 : 0);
  const roughBand = n ? Math.max(0, width - 60) / n : 0;
  const left = Math.max(8 + Math.max(...ticks.map((t) => tickText(t).length)) * 6.2, labelHalf(0) - roughBand / 2 + 2);
  const right = Math.max(4, labelHalf(n - 1) - roughBand / 2 + 2);
  const padTop = 8;
  const bottom = 22;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - padTop - bottom;
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const y = (v: number) => padTop + plotH - (v / top) * plotH;

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
  const shown = new Set<number>();
  for (let i = 0; i < n; i += labelEvery) shown.add(i);
  if (n) {
    const lastShown = Math.max(...shown);
    if (n - 1 - lastShown < labelEvery * 0.6 && lastShown !== n - 1) shown.delete(lastShown);
    shown.add(n - 1);
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, (h ?? n) - 1)); }
    else if (e.key === "Escape") setHover(null);
  };

  const hovered = hover !== null ? rows[hover] : null;
  const tipLeft = hover !== null ? Math.max(70, Math.min(width - 70, left + hover * band + band / 2)) : 0;

  return (
    <div className="min-w-0">
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div
        ref={boxRef}
        className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] rounded"
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={hovered ? tipId : undefined}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible" onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-muted)" style={{ fontVariantNumeric: "tabular-nums" }}>{tickText(t)}</text>
              </g>
            ))}
            {rows.map((row, i) => {
              const x = left + i * band + (band - barW) / 2;
              let acc = 0;
              const drawn = series.map((s) => ({ s, v: Number(row[s.key]) || 0 })).filter((d) => d.v > 0);
              return (
                <g key={i}>
                  {hover === i && <rect x={left + i * band} y={padTop} width={band} height={plotH} fill="var(--viz-hover)" />}
                  {drawn.map((d, j) => {
                    const y1 = y(acc + d.v);
                    let y0 = y(acc);
                    acc += d.v;
                    if (j > 0) y0 -= 2; // the surface gap between stacked segments
                    const h = y0 - y1;
                    if (h <= 0) return null;
                    const isTop = j === drawn.length - 1;
                    const r = isTop ? Math.min(4, barW / 2, h) : 0;
                    const path = `M${x},${y0} L${x},${y1 + r} Q${x},${y1} ${x + r},${y1} L${x + barW - r},${y1} Q${x + barW},${y1} ${x + barW},${y1 + r} L${x + barW},${y0} Z`;
                    return <path key={d.s.key} d={path} fill={d.s.color} />;
                  })}
                  {shown.has(i) && (
                    <text x={left + i * band + band / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{formatX(row[xKey])}</text>
                  )}
                  <rect
                    x={left + i * band}
                    y={padTop}
                    width={Math.max(band, 1)}
                    height={plotH}
                    fill="transparent"
                    onPointerEnter={() => setHover(i)}
                    onPointerMove={() => setHover(i)}
                    onPointerDown={() => setHover(i)}
                  />
                </g>
              );
            })}
            {max === 0 && (
              <text x={left + plotW / 2} y={padTop + plotH * 0.375} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="var(--text-muted)">Nothing yet</text>
            )}
          </svg>
        )}
        {hovered && (
          <div
            id={tipId}
            role="status"
            className="pointer-events-none absolute top-0 z-10 min-w-[8rem] -translate-x-1/2 rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-2.5 py-2 text-[11px] shadow-xl"
            style={{ left: tipLeft }}
          >
            <p className="text-[var(--text-muted)]">{(formatTooltipX ?? formatX)(hovered[xKey])}</p>
            {series.map((s) => (
              <p key={s.key} className="mt-1 flex items-center gap-2">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <span className="font-semibold text-[var(--text-main)] tabular-nums">{formatValue(Number(hovered[s.key]) || 0)}</span>
                <span className="text-[var(--text-muted)]">{s.label}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A chart card that can switch to a plain table of the same numbers. */
export function ChartCard({ title, subtitle, table, children, className = "" }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  table: { columns: { key: string; label: string; format?: (v: any) => string }[]; rows: Record<string, any>[] };
  children: React.ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      title={title}
      subtitle={subtitle}
      className={className}
      action={
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-main)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
          aria-pressed={asTable}
        >
          {asTable ? <BarChart3 size={12} /> : <Table2 size={12} />}
          {asTable ? "Chart" : "Table"}
        </button>
      }
    >
      {asTable ? <DataTable {...table} /> : children}
    </Card>
  );
}

export function DataTable({ columns, rows }: { columns: { key: string; label: string; format?: (v: any) => string }[]; rows: Record<string, any>[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border-main)]">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-[var(--bg-root)]">
          <tr>
            {columns.map((c, i) => (
              <th key={c.key} className={`px-2.5 py-1.5 font-medium text-[var(--text-muted)] ${i === 0 ? "text-left" : "text-right"}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-[var(--border-main)]">
              {columns.map((c, i) => (
                <td key={c.key} className={`px-2.5 py-1.5 text-[var(--text-main)] ${i === 0 ? "text-left" : "text-right tabular-nums"}`}>
                  {c.format ? c.format(r[c.key]) : String(r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
