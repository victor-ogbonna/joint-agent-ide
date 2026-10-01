import React, { useEffect, useState } from "react";
import { Copy, Check, LogOut, Loader2, BadgePercent } from "lucide-react";
import { useDocumentScroll } from "./useDocumentScroll";
import { useAuth } from "./contexts/AuthContext";
import { formatMoney, formatDay } from "./lib/plans";

/**
 * A creator's own page (/creator): their code and link, how many people used
 * it and paid, and what they've earned and been paid (server/creators.ts).
 * Found by the creator's verified email, so they sign in with the address the
 * admin page has for them. Nobody who used the code is ever named here.
 */
interface Money { currency: string; earned: number; paid: number; owed: number }
interface CreatorView {
  code: string;
  name: string;
  ratePct: number;
  active: boolean;
  signups: number;
  payingUsers: number;
  money: Money[];
  earnings: { amount: number; currency: string; commission: number; paidAt: number; paid: boolean }[];
  payouts: { totals: { currency: string; amount: number }[]; paidAt: number }[];
}

const list = (items: { currency: string; amount: number }[]) =>
  items.length ? items.map((m) => formatMoney(m.amount, m.currency)).join(" + ") : formatMoney(0, "USD");

function CodeCard({ c }: { c: CreatorView }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/?ref=${encodeURIComponent(c.code)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const earned = c.money.map((m) => ({ currency: m.currency, amount: m.earned }));
  const paid = c.money.filter((m) => m.paid > 0).map((m) => ({ currency: m.currency, amount: m.paid }));
  const owed = c.money.filter((m) => m.owed > 0).map((m) => ({ currency: m.currency, amount: m.owed }));

  return (
    <section className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-[var(--accent-primary-soft)] px-2.5 py-1 text-[18px] font-bold tracking-wide text-[var(--accent-primary)]">{c.code}</span>
        {!c.active && <span className="rounded px-2 py-0.5 text-[11px] font-semibold bg-[var(--bg-hover)] text-[var(--text-muted)]">Paused: new people can't use it right now</span>}
      </div>
      <p className="mt-2 text-[13px] text-[var(--text-muted)]">
        You earn {c.ratePct}% of every PRO payment from people who used your code, for their first 12 months. They get 7 days of PRO free, then 20% off their first month.
      </p>

      <div className="mt-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Your link</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg bg-[var(--bg-surface)] px-3 py-2 text-[13px] text-[var(--text-main)]">{link}</code>
          <button type="button" onClick={copy} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium hover:bg-[var(--bg-hover)]">
            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-subtle)]">People can also type {c.code} on the Plans page.</p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div><dt className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Used your code</dt><dd className="text-[22px] font-bold tabular-nums">{c.signups}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Paying</dt><dd className="text-[22px] font-bold tabular-nums">{c.payingUsers}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Earned</dt><dd className="text-[16px] font-semibold tabular-nums">{list(earned)}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Paid to you</dt><dd className="text-[16px] font-semibold tabular-nums">{list(paid)}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Owed to you</dt><dd className="text-[16px] font-bold tabular-nums text-[var(--accent-primary)]">{list(owed)}</dd></div>
      </dl>

      <div className="mt-5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Payments that earned you commission</h2>
        {c.earnings.length === 0 ? (
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">None yet. You start earning when someone who used your code pays for PRO.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--border-main)] text-[13px]">
            {c.earnings.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[var(--text-muted)]">{formatDay(e.paidAt)} · a {formatMoney(e.amount, e.currency)} payment</span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(e.commission, e.currency)}{" "}
                  <span className={`text-[11px] font-medium ${e.paid ? "text-green-500" : "text-orange-400"}`}>{e.paid ? "paid" : "owed"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {c.payouts.length > 0 && (
        <div className="mt-5">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Payouts</h2>
          <ul className="mt-2 space-y-1 text-[13px]">
            {c.payouts.map((p, i) => (
              <li key={i}>{formatDay(p.paidAt)}: <span className="font-semibold tabular-nums">{list(p.totals)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function CreatorPage() {
  useDocumentScroll();
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [data, setData] = useState<{ creators: CreatorView[]; verified: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setData(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/creator/me", { headers: { Authorization: `Bearer ${idToken}` } });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(body.error || "Couldn't load your page."); return; }
        setData(body);
        setError(null);
      } catch {
        if (!cancelled) setError("Couldn't reach the server. Try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return (
    <div className="min-h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="h-9 w-9 rounded-lg" />
            <span className="font-display text-[15px] font-bold">Joint-Agent IDE</span>
          </a>
          {user && (
            <button type="button" onClick={() => void signOut()} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-[13px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]">
              <LogOut size={14} /> Sign out
            </button>
          )}
        </header>

        <h1 className="flex items-center gap-2 font-display text-2xl font-bold"><BadgePercent size={22} className="text-[var(--accent-primary)]" /> Creator dashboard</h1>

        {loading ? (
          <p className="mt-6 flex items-center gap-2 text-[14px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /> Loading…</p>
        ) : !user ? (
          <div className="mt-6 rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-5">
            <p className="text-[14px] text-[var(--text-muted)]">Sign in with the email address we have for you to see your code, sign-ups and earnings.</p>
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-full px-5 text-[14px] font-bold text-white shadow-md"
              style={{ background: "var(--gradient-hero)" }}
            >
              Sign in with Google
            </button>
          </div>
        ) : error ? (
          <p role="alert" className="mt-6 text-[14px] text-red-500">{error}</p>
        ) : !data ? (
          <p className="mt-6 flex items-center gap-2 text-[14px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /> Loading your page…</p>
        ) : !data.verified ? (
          <p className="mt-6 text-[14px] text-[var(--text-muted)]">Verify your email address first, then come back to this page.</p>
        ) : data.creators.length === 0 ? (
          <p className="mt-6 text-[14px] text-[var(--text-muted)]">
            There's no creator code for {user.email}. If you're a creator with us, ask us to add this email address to your code.
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {data.creators.map((c) => <CodeCard key={c.code} c={c} />)}
          </div>
        )}
      </div>
    </div>
  );
}
