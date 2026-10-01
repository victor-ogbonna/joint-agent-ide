import React, { useState } from "react";
import { UserPlus, Copy, Check, Pause, Play, Banknote, ChevronDown, ChevronUp, Loader2, Pencil } from "lucide-react";
import { Toolbar, ErrorNote, Loading } from "./Toolbar";
import { useAdminData, type AdminGet } from "./data";
import { full, date } from "./format";
import { formatMoney } from "../lib/plans";

/** Sends an admin request with a JSON body; null once the session has expired. */
export type AdminPost = (path: string, body: unknown) => Promise<Response | null>;

interface Money { currency: string; earned: number; paid: number; owed: number }
interface Creator {
  code: string;
  name: string;
  email: string | null;
  ratePct: number;
  active: boolean;
  createdAt: number;
  signups: number;
  payingUsers: number;
  money: Money[];
}
interface CreatorsResponse { creators: Creator[]; defaultRatePct: number }
interface Earning { reference: string; payerEmail: string | null; amount: number; currency: string; ratePct: number; commission: number; paidAt: number; payoutId: string | null }
interface Payout { id: string; totals: { currency: string; amount: number }[]; count: number; paidAt: number; note: string | null }

const linkFor = (code: string) => `${window.location.origin}/?ref=${encodeURIComponent(code)}`;
const moneyList = (items: { currency: string; amount: number }[]) =>
  items.length ? items.map((m) => formatMoney(m.amount, m.currency)).join(" + ") : formatMoney(0, "USD");

const input = "w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] focus:border-[var(--accent-primary)] focus:outline-none";
const label = "mb-1 block text-[11px] font-medium text-[var(--text-muted)]";
const button = "inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[12px] font-medium text-[var(--text-main)] transition hover:bg-[var(--bg-hover)] disabled:opacity-50";

async function answer(res: Response | null): Promise<{ ok: boolean; body: any }> {
  if (!res) return { ok: false, body: { error: "Your admin session ended. Sign in again." } };
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

function AddCreator({ post, defaultRate, onAdded }: { post: AdminPost; defaultRate: number; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { ok, body } = await answer(await post("/api/admin/creators", { name, email, code, ratePct: rate === "" ? undefined : rate }));
      if (!ok) { setError(body.error || "Couldn't add the creator."); return; }
      setDone(`Added ${body.creator.name}: code ${body.creator.code} at ${body.creator.ratePct}%.`);
      setName(""); setEmail(""); setCode(""); setRate("");
      onAdded();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-main)]"><UserPlus size={14} aria-hidden="true" /> Add a creator</h2>
      <p className="mb-3 text-[11px] text-[var(--text-muted)]">
        People who use the code get 7 days of PRO free, then 20% off their first month. The creator earns their rate on every PRO payment those people make in their first 12 months.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="cr-name" className={label}>Name</label>
          <input id="cr-name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tobi Tech" required maxLength={80} />
        </div>
        <div>
          <label htmlFor="cr-email" className={label}>Email (for their creator page)</label>
          <input id="cr-email" className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tobi@example.com" maxLength={200} />
        </div>
        <div>
          <label htmlFor="cr-code" className={label}>Code</label>
          <input
            id="cr-code" className={`${input} font-semibold tracking-wide`} value={code} required maxLength={24}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} placeholder="TOBI20"
            autoCapitalize="characters" autoComplete="off" spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="cr-rate" className={label}>Commission %</label>
          <input id="cr-rate" className={input} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={String(defaultRate)} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !name.trim() || !code} className={`${button} text-white border-transparent`} style={{ background: "var(--gradient-hero)" }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Add creator
        </button>
        {error && <span role="alert" className="text-[12px] text-[var(--viz-alert-text)]">{error}</span>}
        {done && <span role="status" className="text-[12px] text-green-500">{done}</span>}
      </div>
    </form>
  );
}

function Details({ get, code }: { get: AdminGet; code: string }) {
  const { data, error, loading } = useAdminData<{ earnings: Earning[]; payouts: Payout[] }>(get, `/api/admin/creators/${encodeURIComponent(code)}/earnings`);
  if (error) return <ErrorNote text={error} />;
  if (!data) return loading ? <Loading /> : null;
  return (
    <div className="mt-3 space-y-3">
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Payments that earned commission</h4>
        {data.earnings.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">None yet. Commission starts when someone who used the code pays for PRO.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[12px]">
              <thead className="text-[var(--text-muted)]">
                <tr><th className="py-1.5 pr-3 font-medium">Date</th><th className="py-1.5 pr-3 font-medium">Paid by</th><th className="py-1.5 pr-3 font-medium text-right">Payment</th><th className="py-1.5 pr-3 font-medium text-right">Commission</th><th className="py-1.5 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {data.earnings.map((e) => (
                  <tr key={e.reference} className="border-t border-[var(--border-main)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{date(e.paidAt)}</td>
                    <td className="py-1.5 pr-3">{e.payerEmail || "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatMoney(e.amount, e.currency)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{formatMoney(e.commission, e.currency)} <span className="font-normal text-[var(--text-subtle)]">({e.ratePct}%)</span></td>
                    <td className="py-1.5">{e.payoutId ? <span className="text-green-500">Paid</span> : <span className="text-orange-400">Owed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data.payouts.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Payouts</h4>
          <ul className="space-y-1 text-[12px]">
            {data.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-x-2">
                <span className="whitespace-nowrap">{date(p.paidAt)}</span>
                <span className="font-semibold tabular-nums">{moneyList(p.totals)}</span>
                <span className="text-[var(--text-muted)]">for {full(p.count)} payment{p.count === 1 ? "" : "s"}{p.note ? ` · ${p.note}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CreatorCard({ c, get, post, onChanged }: { c: Creator; get: AdminGet; post: AdminPost; onChanged: () => void }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingRate, setEditingRate] = useState(false);
  const [rate, setRate] = useState(String(c.ratePct));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const owed = c.money.filter((m) => m.owed > 0).map((m) => ({ currency: m.currency, amount: m.owed }));
  const earned = c.money.map((m) => ({ currency: m.currency, amount: m.earned }));
  const paid = c.money.filter((m) => m.paid > 0).map((m) => ({ currency: m.currency, amount: m.paid }));

  const run = async (what: string, path: string, body: unknown, ok: (b: any) => string) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const r = await answer(await post(path, body));
      if (!r.ok) { setError(r.body.error || "That didn't work."); return; }
      setNote(ok(r.body));
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(linkFor(c.code)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const markPaid = () => {
    if (!owed.length) return;
    if (!window.confirm(`Mark ${moneyList(owed)} as paid to ${c.name}?\n\nDo this after you've sent them the money.`)) return;
    void run("pay", `/api/admin/creators/${encodeURIComponent(c.code)}/payout`, {}, (b) =>
      `Marked ${moneyList(b.payout.totals)} paid.${b.payout.left ? ` ${b.payout.left} more to mark: click again.` : ""}`);
  };

  return (
    <li className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[var(--accent-primary-soft)] px-2 py-0.5 text-[13px] font-bold tracking-wide text-[var(--accent-primary)]">{c.code}</span>
            <span className="text-[13px] font-semibold text-[var(--text-main)]">{c.name}</span>
            {!c.active && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-[var(--bg-hover)] text-[var(--text-muted)]">Paused</span>}
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{c.email || "No email: no creator page"} · added {date(c.createdAt)}</p>
        </div>
        <button type="button" onClick={copy} className={button} title="Copy their link">
          {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      <p className="mt-2 break-all text-[11px] text-[var(--text-subtle)]">{linkFor(c.code)}</p>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Signed up</dt><dd className="text-[16px] font-bold tabular-nums">{full(c.signups)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Paying</dt><dd className="text-[16px] font-bold tabular-nums">{full(c.payingUsers)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Earned</dt><dd className="text-[14px] font-semibold tabular-nums">{moneyList(earned)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Paid</dt><dd className="text-[14px] font-semibold tabular-nums">{moneyList(paid)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Owed now</dt><dd className={`text-[14px] font-bold tabular-nums ${owed.length ? "text-orange-400" : ""}`}>{moneyList(owed)}</dd></div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editingRate ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); void run("rate", `/api/admin/creators/${encodeURIComponent(c.code)}`, { ratePct: rate }, (b) => `Rate is now ${b.creator.ratePct}% for new payments.`).then(() => setEditingRate(false)); }}
          >
            <label htmlFor={`rate-${c.code}`} className="sr-only">Commission %</label>
            <input id={`rate-${c.code}`} className={`${input} w-20`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus />
            <span className="text-[12px] text-[var(--text-muted)]">%</span>
            <button type="submit" className={button} disabled={busy !== null}>Save</button>
            <button type="button" className={button} onClick={() => { setEditingRate(false); setRate(String(c.ratePct)); }}>Cancel</button>
          </form>
        ) : (
          <button type="button" className={button} onClick={() => setEditingRate(true)}>
            <Pencil size={13} /> {c.ratePct}% commission
          </button>
        )}
        <button
          type="button"
          className={button}
          disabled={busy !== null}
          onClick={() => void run("active", `/api/admin/creators/${encodeURIComponent(c.code)}`, { active: !c.active }, (b) => b.creator.active ? "Code switched on." : "Code paused: no new sign-ups. People who already used it still earn the creator commission.")}
        >
          {busy === "active" ? <Loader2 size={13} className="animate-spin" /> : c.active ? <Pause size={13} /> : <Play size={13} />}
          {c.active ? "Pause code" : "Switch on"}
        </button>
        <button type="button" className={button} disabled={busy !== null || !owed.length} onClick={markPaid}>
          {busy === "pay" ? <Loader2 size={13} className="animate-spin" /> : <Banknote size={13} />} Mark paid
        </button>
        <button type="button" className={button} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Payments
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-[var(--viz-alert-text)]">{error}</p>}
      {note && <p role="status" className="mt-2 text-[12px] text-green-500">{note}</p>}
      {open && <Details get={get} code={c.code} />}
    </li>
  );
}

export default function CreatorsTab({ get, post }: { get: AdminGet; post: AdminPost }) {
  const { data, error, loading, reload } = useAdminData<CreatorsResponse>(get, "/api/admin/creators");
  const totalsOwed = new Map<string, number>();
  for (const c of data?.creators ?? []) for (const m of c.money) totalsOwed.set(m.currency, (totalsOwed.get(m.currency) ?? 0) + m.owed);
  const owedAll = [...totalsOwed].filter(([, v]) => v > 0).map(([currency, amount]) => ({ currency, amount }));

  return (
    <div>
      <Toolbar onRefresh={() => void reload(true)} loading={loading}>
        {data && (
          <span className="text-[12px] text-[var(--text-muted)]">
            {full(data.creators.length)} creator{data.creators.length === 1 ? "" : "s"}{owedAll.length ? ` · owed in total: ${moneyList(owedAll)}` : ""}
          </span>
        )}
      </Toolbar>
      {error && <ErrorNote text={error} />}
      <AddCreator post={post} defaultRate={data?.defaultRatePct ?? 20} onAdded={() => void reload(true)} />
      {!data && loading && <Loading />}
      {data && data.creators.length === 0 && (
        <p className="text-[13px] text-[var(--text-muted)]">No creators yet. Add one above, then send them their link.</p>
      )}
      {data && data.creators.length > 0 && (
        <ul className="space-y-3">
          {data.creators.map((c) => <CreatorCard key={c.code} c={c} get={get} post={post} onChanged={() => void reload(true)} />)}
        </ul>
      )}
      <p className="mt-6 text-[11px] text-[var(--text-subtle)]">
        Each creator sees their own numbers at {window.location.origin}/creator, signed in with the email above. They never see who signed up.
      </p>
    </div>
  );
}
