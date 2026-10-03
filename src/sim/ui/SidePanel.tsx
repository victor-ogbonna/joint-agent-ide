/**
 * The panel for what's selected: a part's settings (or, while running, a
 * sensor's controls), or a wire's colour.
 */
import React from "react";
import { RotateCw, Copy, Trash2, X, Hand } from "lucide-react";
import type { DiagramConnection, DiagramPart } from "../diagram";
import { BOARD_PARTS, WIRE_COLOURS, specFor, type LiveSpec } from "../catalog";
import { INTERACTIVE } from "../view";

const fieldClass = "w-full rounded-md border border-[var(--border-main)] bg-[var(--bg-surface)] px-2 py-1.5 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent-primary)]";

function LiveControl({ spec, value, onChange }: { spec: LiveSpec; value: number | boolean | undefined; onChange: (v: number | boolean) => void }) {
  if (spec.kind === "button") {
    return (
      <button type="button" onClick={() => onChange(true)} className="w-full rounded-md bg-[var(--accent-primary)] px-3 py-2 text-[12px] font-semibold text-white transition hover:opacity-90">
        {spec.label}
      </button>
    );
  }
  if (spec.kind === "toggle") {
    const on = value === true;
    return (
      <label className="flex items-center justify-between text-[12px] text-[var(--text-main)]">
        {spec.label}
        <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-5 w-9 rounded-full transition ${on ? "bg-[var(--accent-primary)]" : "border border-[var(--border-main)] bg-[var(--bg-surface)]"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-4" : "left-0.5"}`} />
        </button>
      </label>
    );
  }
  const num = typeof value === "number" ? value : spec.fallback ?? 0;
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const log = spec.kind === "log-slider";
  const pos = log ? Math.round((Math.log(num / min) / Math.log(max / min)) * 1000) : num;
  const shown = log ? (num >= 100 ? Math.round(num) : Math.round(num * 10) / 10) : num;
  return (
    <label className="block text-[12px] text-[var(--text-main)]">
      <span className="flex items-baseline justify-between">
        {spec.label}
        <span className="font-mono text-[var(--accent-primary)]">{shown}{spec.unit ? ` ${spec.unit}` : ""}</span>
      </span>
      <input
        type="range"
        className="mt-1.5 w-full accent-[var(--accent-primary)]"
        min={log ? 0 : min}
        max={log ? 1000 : max}
        step={log ? 1 : spec.step ?? 1}
        value={pos}
        onChange={(e) => {
          const p = Number(e.target.value);
          onChange(log ? Math.round(min * Math.pow(max / min, p / 1000) * 10) / 10 : p);
        }}
      />
    </label>
  );
}

export interface SidePanelProps {
  part: DiagramPart | null;
  wire: DiagramConnection | null;
  /** The simulation is running or paused: settings are locked, sensors have controls. */
  running: boolean;
  isBoard: boolean;
  liveValues: Record<string, number | boolean>;
  onLive: (input: string, value: number | boolean) => void;
  onAttr: (key: string, value: string) => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onWireColour: (colour: string) => void;
  onClose: () => void;
}

export default function SidePanel(p: SidePanelProps) {
  const { part, wire, running } = p;
  if (!part && !wire) return null;
  const spec = part ? specFor(part.type, part.attrs) : undefined;
  const title = part ? (p.isBoard ? BOARD_PARTS.find((b) => b.type === part.type)?.name : spec?.name) ?? part.type.replace(/^wokwi-/, "") : "Wire";

  return (
    <div className="w-full rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)]/95 shadow-xl backdrop-blur sm:w-60" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 border-b border-[var(--border-main)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-[var(--text-main)]">{title}</div>
          {part && <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">{part.id}</div>}
          {wire && <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">{wire[0]} → {wire[1]}</div>}
        </div>
        <button type="button" onClick={p.onClose} className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]" aria-label="Close panel">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-3 p-3">
        {part && running && (
          <>
            {spec?.live?.map((l) => (
              <LiveControl key={l.input} spec={l} value={p.liveValues[l.input]} onChange={(v) => p.onLive(l.input, v)} />
            ))}
            {!spec?.live?.length && (
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {INTERACTIVE.has(part.type) ? <><Hand size={13} className="mt-0.5 shrink-0" /> Press, turn or slide the part itself.</> : "Stop the simulation to change this part."}
              </p>
            )}
          </>
        )}

        {part && !running && (
          <>
            {spec?.props?.map((prop) => {
              const value = part.attrs?.[prop.key] ?? spec.attrs?.[prop.key] ?? "";
              return (
                <label key={prop.key} className="block text-[11px] text-[var(--text-muted)]">
                  {prop.label}{prop.unit ? ` (${prop.unit})` : ""}
                  {prop.kind === "select" ? (
                    <select className={`${fieldClass} mt-1`} value={value} onChange={(e) => p.onAttr(prop.key, e.target.value)}>
                      {!prop.options?.some((o) => o.value === value) && value !== "" && <option value={value}>{value}</option>}
                      {prop.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      className={`${fieldClass} mt-1 font-mono`}
                      type={prop.kind === "number" ? "number" : "text"}
                      min={prop.min}
                      max={prop.max}
                      step={prop.step}
                      defaultValue={value}
                      key={`${part.id}:${prop.key}:${value}`}
                      onBlur={(e) => { if (e.target.value !== value) p.onAttr(prop.key, e.target.value); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                  )}
                </label>
              );
            })}
            {spec?.live?.filter((l) => l.attr).map((l) => (
              <label key={l.input} className="block text-[11px] text-[var(--text-muted)]">
                Start {l.label.toLowerCase()}{l.unit ? ` (${l.unit})` : ""}
                <input
                  className={`${fieldClass} mt-1 font-mono`}
                  type="number"
                  min={l.min}
                  max={l.max}
                  step={l.step ?? "any"}
                  defaultValue={part.attrs?.[l.attr!] ?? spec.attrs?.[l.attr!] ?? String(l.fallback ?? "")}
                  key={`${part.id}:${l.attr}:${part.attrs?.[l.attr!] ?? ""}`}
                  onBlur={(e) => p.onAttr(l.attr!, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            ))}
            <div className="flex gap-1.5">
              <button type="button" onClick={p.onRotate} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border-main)] px-2 py-1.5 text-[11px] text-[var(--text-main)] hover:bg-[var(--bg-hover)]" title="Rotate (R)">
                <RotateCw size={12} /> Rotate
              </button>
              {!p.isBoard && (
                <>
                  <button type="button" onClick={p.onDuplicate} className="flex items-center justify-center rounded-md border border-[var(--border-main)] px-2 py-1.5 text-[var(--text-main)] hover:bg-[var(--bg-hover)]" title="Duplicate (Ctrl+D)" aria-label="Duplicate">
                    <Copy size={12} />
                  </button>
                  <button type="button" onClick={p.onDelete} className="flex items-center justify-center rounded-md border border-[var(--border-main)] px-2 py-1.5 text-[var(--term-error)] hover:bg-[var(--bg-hover)]" title="Delete (Del)" aria-label="Delete">
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {wire && (
          <>
            <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Wire colour">
              {WIRE_COLOURS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={wire[2] === c}
                  aria-label={c}
                  title={c}
                  disabled={running}
                  onClick={() => p.onWireColour(c)}
                  className={`h-6 rounded-md border transition disabled:opacity-50 ${wire[2] === c ? "border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/40" : "border-[var(--border-main)]"}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            {!running && (
              <button type="button" onClick={p.onDelete} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--border-main)] px-2 py-1.5 text-[11px] text-[var(--term-error)] hover:bg-[var(--bg-hover)]">
                <Trash2 size={12} /> Delete wire
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
