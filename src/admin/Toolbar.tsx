import React from "react";
import { RefreshCw, AlertCircle } from "lucide-react";

export const RANGES = [7, 30, 90, 365] as const;
export type Range = (typeof RANGES)[number];
const RANGE_LABEL: Record<Range, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

/** The one row of controls above a tab: the date range first, then refresh. */
export function Toolbar({ range, onRange, onRefresh, loading, updatedAt, children }: {
  range?: Range;
  onRange?: (r: Range) => void;
  onRefresh: () => void;
  loading: boolean;
  updatedAt?: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {range !== undefined && onRange && (
        <div className="flex overflow-hidden rounded-lg border border-[var(--border-main)]" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRange(r)}
              aria-pressed={range === r}
              className={`px-2.5 py-1.5 text-[12px] font-medium transition ${range === r ? "bg-[var(--bg-hover)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      {children}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-[var(--border-main)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-60"
      >
        <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        Refresh
      </button>
      {updatedAt && (
        <span className="w-full text-right text-[10px] text-[var(--text-subtle)] sm:w-auto">
          Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return (
    <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-[var(--viz-alert-text)]">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export function Loading() {
  return <p className="py-16 text-center text-[12px] text-[var(--text-muted)]">Loading…</p>;
}
