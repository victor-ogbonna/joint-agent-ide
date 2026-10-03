/**
 * Manual-Mode's Circuit Simulator tab, before it opens to everyone: what's
 * coming, nothing to use yet.
 */
import React from "react";
import { CircuitBoard, Cpu, Play, Gauge } from "lucide-react";

export default function SimulatorComingSoon() {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-[var(--bg-root)] p-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-6 text-center shadow-[var(--shadow-panel)]">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: "var(--gradient-hero)" }}>
          <CircuitBoard size={22} aria-hidden="true" />
        </div>
        <span className="inline-block rounded-full bg-[var(--accent-primary-soft)] px-2.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)]">
          Coming soon
        </span>
        <h2 className="mt-3 font-display text-lg font-bold text-[var(--text-main)]">Circuit Simulator</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
          Wire up a circuit and run your code on a virtual board, right here, with no hardware needed.
        </p>
        <ul className="mt-5 space-y-2.5 text-left text-[12px] text-[var(--text-main)]">
          <li className="flex items-start gap-2.5"><Cpu size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" /> Arduino Uno, Nano and Mega, with LEDs, buttons, displays, sensors and motors</li>
          <li className="flex items-start gap-2.5"><Play size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" /> Press buttons, turn knobs and watch the Serial Monitor as it runs</li>
          <li className="flex items-start gap-2.5"><Gauge size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" /> Runs in real time, in your browser</li>
        </ul>
      </div>
    </div>
  );
}
