import React from "react";
import { X, Check, Minus, Rocket, Loader2 } from "lucide-react";
import {
  WINDOW_HOURS, FREE_WINDOW_TOKENS, FREE_DAILY_TOKENS, PRO_WINDOW_TOKENS, PAID_TOKEN_CAP,
  FREE_MAX_REPLY_TOKENS, PRO_MAX_REPLY_TOKENS, FREE_WINDOW_COMPILES, FREE_DAILY_COMPILES, PRO_PRICE,
} from "../lib/plans";

/**
 * Free vs PRO, side by side. Every row is something the server actually
 * enforces (server/quota.ts, server/deepseek.ts), with the figures taken from
 * src/lib/plans.ts, which a test keeps equal to the server's. Both plans run
 * on the same model with the same context window, so neither "a better
 * model" nor "more memory" is claimed.
 */
const k = (n: number) => `${n / 1000}K`;
const ROWS: Array<{ feature: string; free: boolean | string; pro: boolean | string }> = [
  { feature: "Access to Joint-Agent", free: true, pro: true },
  { feature: `AI tokens every ${WINDOW_HOURS} hours`, free: k(FREE_WINDOW_TOKENS), pro: k(PRO_WINDOW_TOKENS) },
  { feature: "Longest reply", free: k(FREE_MAX_REPLY_TOKENS), pro: k(PRO_MAX_REPLY_TOKENS) },
  { feature: `Compiles every ${WINDOW_HOURS} hours`, free: String(FREE_WINDOW_COMPILES), pro: "Unlimited" },
  { feature: "Smart Flash auto-debug", free: false, pro: true },
  { feature: "Plan Mode", free: false, pro: true },
];

function Cell({ value, pro }: { value: boolean | string; pro: boolean }) {
  if (typeof value === "string") {
    return (
      <span className={`text-[11px] font-semibold tabular-nums ${pro ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"}`}>
        {value}
      </span>
    );
  }
  return value
    ? <Check size={22} strokeWidth={2.4} className={pro ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"} aria-label="Included" />
    : <Minus size={22} strokeWidth={2.4} className="text-[var(--text-subtle)]" aria-label="Not included" />;
}

export default function PlansModal({ onClose, onUpgrade, upgrading }: {
  onClose: () => void;
  onUpgrade: () => void;
  upgrading: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-end sm:items-center justify-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="plans-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full sm:max-w-md bg-[var(--bg-root)] border border-[var(--border-main)] sm:rounded-2xl rounded-t-2xl shadow-2xl px-5 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] animate-slide-up"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold tracking-wider text-white mb-3"
                style={{ background: "var(--gradient-hero)" }}
              >
                <Rocket size={12} className="rocket-blaze" /> PRO
              </div>
              <h2 id="plans-title" className="font-display font-bold text-lg text-[var(--text-main)] leading-snug">
                Build more with the full agent
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                10× more AI every {WINDOW_HOURS} hours, full-size replies, auto-debug, Plan Mode and unlimited compiles.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-10 h-10 -mr-2 -mt-1 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-5 rounded-2xl bg-[var(--bg-panel)] border border-[var(--border-main)] px-4 py-2">
            <div className="grid grid-cols-[1fr_4.5rem_5rem] items-center py-3 text-xs font-semibold">
              <span className="text-[var(--text-muted)]">Features</span>
              <span className="text-center text-[var(--text-muted)]">Free</span>
              <span className="text-center text-[var(--accent-primary)]">PRO</span>
            </div>
            {ROWS.map((row) => (
              <div key={row.feature} className="grid grid-cols-[1fr_4.5rem_5rem] items-center py-3.5 border-t border-[var(--border-main)]">
                <span className="text-[13px] text-[var(--text-main)] leading-snug pr-2">{row.feature}</span>
                <span className="flex justify-center"><Cell value={row.free} pro={false} /></span>
                <span className="flex justify-center"><Cell value={row.pro} pro /></span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] text-[var(--text-subtle)] leading-relaxed">
            Both plans use the same AI model. Free refills every {WINDOW_HOURS} hours, up to{" "}
            {FREE_DAILY_TOKENS.toLocaleString()} tokens and {FREE_DAILY_COMPILES} successful compiles a day. PRO includes up to{" "}
            {PAID_TOKEN_CAP.toLocaleString()} tokens a month.
          </p>

          <button
            onClick={onUpgrade}
            disabled={upgrading}
            className="mt-5 w-full flex items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold text-white shadow-lg btn-lift disabled:opacity-60"
            style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
          >
            {upgrading ? <Loader2 size={17} className="animate-spin" /> : <Rocket size={17} />}
            {upgrading ? "Opening checkout…" : `Upgrade to PRO — ${PRO_PRICE}`}
          </button>
          <p className="mt-3 text-center text-[11px] text-[var(--text-muted)]">Renews monthly. Cancel anytime.</p>
        </div>
      </div>
    </div>
  );
}
