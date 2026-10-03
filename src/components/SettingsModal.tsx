import React, { useEffect, useRef } from "react";
import { X, CircuitBoard, Loader2 } from "lucide-react";

/**
 * Settings, from the profile menu. For now one: whether the agent builds
 * the circuit along with the code (saved in the account, server/circuits.ts).
 * Accounts without circuits see it as "Coming soon".
 */
export interface SettingsModalProps {
  /** Circuits are open to this account. */
  circuitAccess: boolean;
  buildCircuit: boolean;
  saving: boolean;
  error: string | null;
  onBuildCircuit: (on: boolean) => void;
  onClose: () => void;
}

export default function SettingsModal({ circuitAccess, buildCircuit, saving, error, onBuildCircuit, onClose }: SettingsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus moves in once, as it opens; Escape closes it.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const on = circuitAccess && buildCircuit;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-end justify-center sm:items-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded-t-2xl border border-[var(--border-main)] bg-[var(--bg-root)] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5 shadow-2xl animate-slide-up sm:max-w-md sm:rounded-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="settings-title" className="font-display text-base font-bold text-[var(--text-main)]">Settings</h2>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close settings"
              className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-[var(--accent-primary-soft)] p-1.5 text-[var(--accent-primary)]">
                <CircuitBoard size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span id="build-circuit-label" className="text-[13px] font-semibold text-[var(--text-main)]">Build the circuit automatically</span>
                  {!circuitAccess && (
                    <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Coming soon</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                  {circuitAccess
                    ? "When the agent builds a project, it also builds its circuit: the parts and the wiring, ready to simulate in schematic.view with Simulate. Turned off, the agent writes only the code."
                    : "The agent will build each project's circuit with its code, ready to simulate. It isn't open to every account yet."}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-labelledby="build-circuit-label"
                disabled={!circuitAccess || saving}
                onClick={() => onBuildCircuit(!buildCircuit)}
                className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-[var(--accent-primary)]" : "border border-[var(--border-main)] bg-[var(--bg-surface)]"}`}
              >
                <span className={`absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`}>
                  {saving && <Loader2 size={11} className="animate-spin text-[var(--text-muted)]" />}
                </span>
              </button>
            </div>
            {error && <p className="mt-3 text-[11px] text-[var(--term-error)]">{error}</p>}
          </div>
          <p className="mt-3 text-[10px] text-[var(--text-subtle)]">Saved in your account, on every device you sign in on.</p>
        </div>
      </div>
    </div>
  );
}
