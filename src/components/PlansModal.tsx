import React, { useState } from "react";
import { X, Check, Minus, Rocket, Loader2, Gift, Clock } from "lucide-react";
import {
  WINDOW_HOURS, FREE_WINDOW_TOKENS, PRO_WINDOW_TOKENS, FREE_MAX_REPLY_TOKENS, PRO_MAX_REPLY_TOKENS,
  FREE_WINDOW_COMPILES, FREE_DAILY_COMPILES, FREE_PROJECT_LIMIT, PRO_PRICE, formatDay, formatMoney, showPrice, nairaNote,
} from "../lib/plans";

/** The first month at a discount, for an account that came by a creator code (server/paystack.ts). */
export interface FirstMonthOffer {
  /** In the currency's smallest unit. */
  amount: number;
  fullAmount: number;
  currency: string;
  discountPct: number;
  until: number;
  publicKey: string;
  kind: string;
}

/**
 * Free vs PRO, side by side. Every row is something the server actually
 * enforces (server/quota.ts, server/deepseek.ts). Like ChatGPT, Claude and
 * Gemini, AI usage is shown as a multiple, never as token counts: the counts
 * are how the server meters, not something to compare. Compiles keep their
 * number, because a compile is something people count. Both plans run on the
 * same model with the same context window, so neither "a better model" nor
 * "more memory" is claimed.
 */
const ROWS: Array<{ feature: string; free: boolean | string; pro: boolean | string }> = [
  { feature: "Access to Joint-Agent", free: true, pro: true },
  { feature: `AI usage every ${WINDOW_HOURS} hours`, free: "Standard", pro: `${PRO_WINDOW_TOKENS / FREE_WINDOW_TOKENS}× more` },
  { feature: "Replies", free: "Short", pro: PRO_MAX_REPLY_TOKENS > FREE_MAX_REPLY_TOKENS ? "Full-size" : "Short" },
  { feature: `Compiles every ${WINDOW_HOURS} hours`, free: String(FREE_WINDOW_COMPILES), pro: "Unlimited" },
  { feature: "Saved projects", free: String(FREE_PROJECT_LIMIT), pro: "Unlimited" },
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

/** The naira Paystack charges, under a button that shows dollars. */
function NairaNote({ text }: { text: string | null }) {
  return text ? <p className="mt-1 text-center text-[11px] text-[var(--text-subtle)]" data-naira-note="">{text}</p> : null;
}

export interface PlanPriceView {
  /** In the currency's smallest unit. */
  amount: number;
  currency: string;
}

export type BillingPeriod = "monthly" | "yearly";

export default function PlansModal({ onClose, onUpgrade, upgrading, prices = null, trialEndsAt = null, offerOpensAt = null, offerExpected = false, offer = null, offerLoading = false, onUpgradeOffer, canUseCode = false, onApplyCode }: {
  onClose: () => void;
  onUpgrade: (period: BillingPeriod) => void;
  upgrading: boolean;
  /** PRO's prices from Paystack; yearly is null when there's no yearly plan. */
  prices?: { monthly: PlanPriceView | null; yearly: PlanPriceView | null } | null;
  /** When the account's free PRO trial ends, while it lasts. */
  trialEndsAt?: number | null;
  /** When the first month's discount opens (the trial's end), while it hasn't. */
  offerOpensAt?: number | null;
  /** The account has the first-month discount now (its price may still be loading). */
  offerExpected?: boolean;
  offer?: FirstMonthOffer | null;
  offerLoading?: boolean;
  onUpgradeOffer?: () => void;
  /** Whether the account can still take a creator code. */
  canUseCode?: boolean;
  onApplyCode?: (code: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const monthly = prices?.monthly ?? null;
  const yearly = prices?.yearly ?? null;
  // Against twelve months at the monthly price, when both are in one currency.
  const savePct = monthly && yearly && monthly.currency === yearly.currency && monthly.amount > 0
    ? Math.round(100 - (yearly.amount / (monthly.amount * 12)) * 100)
    : null;
  // Shown in dollars; Paystack charges the naira amount, said under each button.
  const monthlyLabel = monthly ? `${showPrice(monthly.amount, monthly.currency)}/month` : PRO_PRICE;
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const applyCode = async () => {
    if (!onApplyCode || !code.trim() || applying) return;
    setApplying(true);
    setCodeError(null);
    try {
      const result = await onApplyCode(code.trim());
      if (!result.ok) setCodeError(result.error || "That code couldn't be used.");
    } finally {
      setApplying(false);
    }
  };
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
                {trialEndsAt ? "Keep the full agent after your trial" : "Build more with the full agent"}
              </h2>
              {trialEndsAt && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-primary-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-primary)]">
                  <Clock size={12} aria-hidden="true" /> Your free PRO trial ends {formatDay(trialEndsAt)}
                </p>
              )}
              <p className="text-xs text-[var(--text-muted)] mt-1">
                {PRO_WINDOW_TOKENS / FREE_WINDOW_TOKENS}× more AI every {WINDOW_HOURS} hours, full-size replies, auto-debug, Plan Mode, and unlimited compiles and projects.
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
            Both plans use the same AI model and refill every {WINDOW_HOURS} hours. Free includes up to{" "}
            {FREE_DAILY_COMPILES} successful compiles a day. Usage limits apply to both plans.
          </p>

          {trialEndsAt ? (
            // No checkout during the trial: the first month's discount opens when it ends.
            <p className="mt-5 rounded-xl bg-[var(--bg-panel)] border border-[var(--border-main)] px-4 py-3 text-center text-[12px] text-[var(--text-muted)]">
              {offerOpensAt
                ? <>When your trial ends on {formatDay(offerOpensAt)}, your first month of PRO is 20% off. You'll see the offer here then.</>
                : <>Enjoy PRO until {formatDay(trialEndsAt)}.</>}
            </p>
          ) : (
            <>
              {yearly && (
                <div className="mt-5 grid grid-cols-2 rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)] p-1" role="radiogroup" aria-label="Billing">
                  {(["monthly", "yearly"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={period === p}
                      onClick={() => setPeriod(p)}
                      className={`min-h-[40px] rounded-full text-[13px] font-semibold transition ${period === p ? "text-white shadow" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                      style={period === p ? { background: "var(--gradient-hero)" } : undefined}
                    >
                      {p === "monthly" ? "Monthly" : <>Yearly{savePct !== null && savePct > 0 ? <span className="ml-1 text-[11px] font-bold">· save {savePct}%</span> : null}</>}
                    </button>
                  ))}
                </div>
              )}

              {period === "yearly" && yearly ? (
                <>
                  <button
                    onClick={() => onUpgrade("yearly")}
                    disabled={upgrading}
                    className="mt-4 w-full flex items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold text-white shadow-lg btn-lift disabled:opacity-60"
                    style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
                  >
                    {upgrading ? <Loader2 size={17} className="animate-spin" /> : <Rocket size={17} />}
                    {upgrading ? "Opening checkout…" : `Upgrade to PRO — ${showPrice(yearly.amount, yearly.currency)}/year`}
                  </button>
                  <p className="mt-3 text-center text-[11px] text-[var(--text-muted)]">
                    {savePct !== null && savePct > 0 ? `${savePct}% less than paying monthly. ` : ""}Renews yearly. Cancel anytime.
                  </p>
                  <NairaNote text={nairaNote(yearly.amount, yearly.currency, "a year")} />
                </>
              ) : offerExpected && onUpgradeOffer ? (
                offer ? (
                  <>
                    <button
                      onClick={onUpgradeOffer}
                      disabled={upgrading}
                      className={`${yearly ? "mt-4" : "mt-5"} w-full flex items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold text-white shadow-lg btn-lift disabled:opacity-60`}
                      style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
                    >
                      {upgrading ? <Loader2 size={17} className="animate-spin" /> : <Gift size={17} />}
                      {upgrading ? "Opening checkout…" : `Get PRO — first month ${showPrice(offer.amount, offer.currency)}`}
                    </button>
                    <p className="mt-3 text-center text-[11px] text-[var(--text-muted)]">
                      {offer.discountPct}% off your first month, then {showPrice(offer.fullAmount, offer.currency)}/month. Cancel anytime.
                    </p>
                    <NairaNote text={nairaNote(offer.amount, offer.currency, `for the first month, then ${formatMoney(offer.fullAmount, offer.currency)} a month`)} />
                    <p className="mt-1 text-center text-[10px] text-[var(--text-subtle)]">Offer ends {formatDay(offer.until)}</p>
                  </>
                ) : offerLoading ? (
                  <p className="mt-5 flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
                    <Loader2 size={14} className="animate-spin" /> Loading your offer…
                  </p>
                ) : (
                  <p className="mt-5 text-center text-[12px] text-[var(--text-muted)]">
                    Your first-month offer couldn't load just now. Close this and open it again in a moment.
                  </p>
                )
              ) : (
                <>
                  <button
                    onClick={() => onUpgrade("monthly")}
                    disabled={upgrading}
                    className={`${yearly ? "mt-4" : "mt-5"} w-full flex items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold text-white shadow-lg btn-lift disabled:opacity-60`}
                    style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
                  >
                    {upgrading ? <Loader2 size={17} className="animate-spin" /> : <Rocket size={17} />}
                    {upgrading ? "Opening checkout…" : `Upgrade to PRO — ${monthlyLabel}`}
                  </button>
                  <p className="mt-3 text-center text-[11px] text-[var(--text-muted)]">Renews monthly. Cancel anytime.</p>
                  {monthly && <NairaNote text={nairaNote(monthly.amount, monthly.currency, "a month")} />}
                </>
              )}
            </>
          )}

          {canUseCode && onApplyCode && (
            <div className="mt-4 border-t border-[var(--border-main)] pt-3">
              {!codeOpen ? (
                <button
                  type="button"
                  onClick={() => setCodeOpen(true)}
                  className="mx-auto flex min-h-[40px] items-center gap-1.5 text-[12px] font-medium text-[var(--text-muted)] hover:text-[var(--text-main)]"
                >
                  <Gift size={13} aria-hidden="true" /> Have a creator code?
                </button>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); void applyCode(); }}>
                  <label htmlFor="creator-code" className="text-[12px] font-medium text-[var(--text-main)]">Creator code</label>
                  <p className="text-[11px] text-[var(--text-muted)]">7 days of PRO free, then 20% off your first month.</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      id="creator-code"
                      value={code}
                      onChange={(e) => { setCode(e.target.value.toUpperCase()); setCodeError(null); }}
                      maxLength={24}
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="e.g. TOBI20"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] px-3 py-2 text-[14px] font-semibold tracking-wide text-[var(--text-main)] placeholder:font-normal placeholder:text-[var(--text-subtle)] focus:border-[var(--accent-primary)] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={applying || !code.trim()}
                      className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                    >
                      {applying ? <Loader2 size={14} className="animate-spin" /> : null} Apply
                    </button>
                  </div>
                  {codeError && <p role="alert" className="mt-2 text-[11px] text-red-500">{codeError}</p>}
                </form>
              )}
            </div>
          )}

          <p className="mt-4 text-center text-[11px] text-[var(--text-muted)]">
            Buying for a school, class or team?{" "}
            <a href="/team" target="_blank" rel="noopener" className="font-semibold text-[var(--accent-primary)] hover:underline">See team licenses</a>
          </p>
        </div>
      </div>
    </div>
  );
}
