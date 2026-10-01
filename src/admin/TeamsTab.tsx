import React, { useState } from "react";
import { Users, Plus, ChevronDown, ChevronUp, Loader2, Receipt, Pencil, UserPlus } from "lucide-react";
import { Toolbar, ErrorNote, Loading } from "./Toolbar";
import { useAdminData, type AdminGet } from "./data";
import { full, date } from "./format";
import { formatMoney } from "../lib/plans";
import { stateLabel, type LicenseState, type TeamRole, type TeamKind } from "../lib/teams";
import type { AdminPost } from "./CreatorsTab";

/**
 * Team and school licenses (server/teams.ts): add one for a school's admin,
 * record an invoice they paid, set a special seat price, and see who's on
 * each. Teams can also start themselves at /team and pay there online.
 */
interface TeamSummary {
  id: string;
  name: string;
  kind: TeamKind;
  state: LicenseState;
  paidUntil: number | null;
  graceUntil: number | null;
  seats: number;
  memberCount: number;
  seatPrice: number;
  customSeatPrice: number | null;
  currency: string;
  ownerEmail: string | null;
  createdAt: number;
}
interface TeamsResponse { teams: TeamSummary[]; defaults: { seatPrice: number; currency: string; minSeats: number } }
interface Detail {
  members: { uid: string; email: string | null; emailVerified: boolean; role: TeamRole; joinedAt: number }[];
  invites: { email: string; role: TeamRole; invitedAt: number }[];
  payments: { id: string; kind: "online" | "invoice"; action: "renew" | "add_seats"; months: number; seats: number; extra: number; amount: number; currency: string; paidAt: number; payerEmail: string | null; note: string | null }[];
  joinCode: string;
  joinOpen: boolean;
}

const input = "w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] focus:border-[var(--accent-primary)] focus:outline-none";
const label = "mb-1 block text-[11px] font-medium text-[var(--text-muted)]";
const button = "inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[12px] font-medium text-[var(--text-main)] transition hover:bg-[var(--bg-hover)] disabled:opacity-50";

/** "12.50" (major units) to 1250 (smallest unit); null when blank; NaN when not a number. */
function toMinor(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

/** A date input's day as the end of that day, UTC. */
function endOfDay(day: string): number | null {
  const t = Date.parse(`${day}T23:59:59Z`);
  return Number.isFinite(t) ? t : null;
}

async function answer(res: Response | null): Promise<{ ok: boolean; body: any }> {
  if (!res) return { ok: false, body: { error: "Your admin session ended. Sign in again." } };
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

function StateBadge({ state }: { state: LicenseState }) {
  const tone = state === "active" ? "bg-green-500/15 text-green-500" : state === "grace" ? "bg-orange-500/15 text-orange-400" : "bg-[var(--bg-hover)] text-[var(--text-muted)]";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{stateLabel(state)}</span>;
}

function AddTeam({ post, defaults, onAdded }: { post: AdminPost; defaults: TeamsResponse["defaults"]; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TeamKind>("school");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [seats, setSeats] = useState(String(defaults.minSeats));
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState(defaults.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const seatPrice = toMinor(price);
    if (Number.isNaN(seatPrice)) { setError("The seat price is a number, like 4 or 3.50."); return; }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { ok, body } = await answer(await post("/api/admin/teams", { name, kind, ownerEmail, seats, seatPrice, currency }));
      if (!ok) { setError(body.error || "Couldn't add the team."); return; }
      setDone(`Added ${body.team.name}. ${body.team.ownerEmail} becomes its admin when they next sign in. Record their payment below once it arrives.`);
      setName(""); setOwnerEmail(""); setPrice("");
      onAdded();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-main)]"><Plus size={14} aria-hidden="true" /> Add a school or team</h2>
      <p className="mb-3 text-[11px] text-[var(--text-muted)]">
        For a school paying by invoice, or at a special price. Its admin is invited by email and manages it at /team. Normal price: {formatMoney(defaults.seatPrice, defaults.currency)} a seat a month.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="tm-name" className={label}>Name</label>
          <input id="tm-name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Kings College" required maxLength={80} />
        </div>
        <div>
          <label htmlFor="tm-owner" className={label}>Its admin's email</label>
          <input id="tm-owner" className={input} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="ict@school.edu.ng" required maxLength={200} />
        </div>
        <div>
          <label htmlFor="tm-kind" className={label}>Kind</label>
          <select id="tm-kind" className={input} value={kind} onChange={(e) => setKind(e.target.value === "team" ? "team" : "school")}>
            <option value="school">School or class</option>
            <option value="team">Team or group</option>
          </select>
        </div>
        <div>
          <label htmlFor="tm-seats" className={label}>Seats</label>
          <input id="tm-seats" className={input} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <div>
          <label htmlFor="tm-price" className={label}>Special price a seat a month (blank: normal)</label>
          <input id="tm-price" className={input} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={(defaults.seatPrice / 100).toFixed(2)} />
        </div>
        <div>
          <label htmlFor="tm-currency" className={label}>Currency</label>
          <input id="tm-currency" className={`${input} uppercase`} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || name.trim().length < 2 || !ownerEmail.trim()} className={`${button} text-white border-transparent`} style={{ background: "var(--gradient-hero)" }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
        </button>
        {error && <span role="alert" className="text-[12px] text-[var(--viz-alert-text)]">{error}</span>}
        {done && <span role="status" className="text-[12px] text-green-500">{done}</span>}
      </div>
    </form>
  );
}

function Details({ get, id }: { get: AdminGet; id: string }) {
  const { data, error, loading } = useAdminData<Detail>(get, `/api/admin/teams/${encodeURIComponent(id)}`);
  if (error) return <ErrorNote text={error} />;
  if (!data) return loading ? <Loading /> : null;
  return (
    <div className="mt-3 space-y-3 text-[12px]">
      <p className="text-[var(--text-muted)]">Join code <span className="font-bold tracking-wider text-[var(--text-main)]">{data.joinCode}</span>{data.joinOpen ? "" : " (joining by code is off)"}</p>
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Members ({full(data.members.length)})</h4>
        {data.members.length === 0 ? <p className="text-[var(--text-muted)]">Nobody yet.</p> : (
          <ul className="space-y-1">
            {data.members.map((m) => (
              <li key={m.uid} className="flex flex-wrap gap-x-2">
                <span className="break-all">{m.email || m.uid}</span>
                <span className="text-[var(--text-subtle)]">{m.role === "admin" ? "admin" : "member"} · joined {date(m.joinedAt)}{m.email && !m.emailVerified ? " · email not verified" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {data.invites.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Invited, not joined yet ({full(data.invites.length)})</h4>
          <ul className="space-y-1">
            {data.invites.map((i) => <li key={i.email} className="break-all">{i.email}{i.role === "admin" ? " (as admin)" : ""} · {date(i.invitedAt)}</li>)}
          </ul>
        </div>
      )}
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Payments</h4>
        {data.payments.length === 0 ? <p className="text-[var(--text-muted)]">None yet.</p> : (
          <ul className="space-y-1">
            {data.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-x-2">
                <span className="whitespace-nowrap">{date(p.paidAt)}</span>
                <span className="font-semibold tabular-nums">{p.amount > 0 ? formatMoney(p.amount, p.currency) : "—"}</span>
                <span className="text-[var(--text-muted)]">
                  {p.kind === "invoice" ? "invoice" : "online"} · {p.action === "add_seats" ? `${p.extra} seats added` : `${p.months} months, ${p.seats} seats`}{p.payerEmail ? ` · ${p.payerEmail}` : ""}{p.note ? ` · ${p.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TeamCard({ t, get, post, onChanged }: { t: TeamSummary; get: AdminGet; post: AdminPost; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"invoice" | "edit" | "invite" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Invoice
  const [months, setMonths] = useState("4");
  const [invSeats, setInvSeats] = useState(String(t.seats));
  const [amount, setAmount] = useState("");
  const [invCurrency, setInvCurrency] = useState(t.currency);
  const [invNote, setInvNote] = useState("");
  // Edit
  const [name, setName] = useState(t.name);
  const [seats, setSeats] = useState(String(t.seats));
  const [price, setPrice] = useState(t.customSeatPrice === null ? "" : (t.customSeatPrice / 100).toFixed(2));
  const [currency, setCurrency] = useState(t.currency);
  const [paidUntil, setPaidUntil] = useState(t.paidUntil ? new Date(t.paidUntil).toISOString().slice(0, 10) : "");
  // Invite
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("admin");

  /** Opens a form, filled in from the team as it is now. */
  const toggle = (which: "invoice" | "edit" | "invite") => {
    if (panel === which) { setPanel(null); return; }
    setError(null);
    setNote(null);
    setMonths("4"); setInvSeats(String(t.seats)); setAmount(""); setInvCurrency(t.currency); setInvNote("");
    setName(t.name); setSeats(String(t.seats)); setCurrency(t.currency);
    setPrice(t.customSeatPrice === null ? "" : (t.customSeatPrice / 100).toFixed(2));
    setPaidUntil(t.paidUntil ? new Date(t.paidUntil).toISOString().slice(0, 10) : "");
    setInviteEmail(""); setInviteRole("admin");
    setPanel(which);
  };

  const run = async (path: string, body: unknown, ok: (b: any) => string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await answer(await post(path, body));
      if (!r.ok) { setError(r.body.error || "That didn't work."); return; }
      setNote(ok(r.body));
      setPanel(null);
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const base = `/api/admin/teams/${encodeURIComponent(t.id)}`;

  const recordInvoice = (e: React.FormEvent) => {
    e.preventDefault();
    const minor = toMinor(amount);
    if (Number.isNaN(minor)) { setError("The amount is a number, like 250 or 99.50."); return; }
    if (!window.confirm(`Record that ${t.name} paid for ${months} month(s)${minor ? `, ${formatMoney(minor, invCurrency || t.currency)}` : ""}?\n\nIts license is extended right away.`)) return;
    void run(`${base}/invoice`, { months: Number(months), seats: invSeats, amount: minor, currency: invCurrency, note: invNote }, (b) =>
      `Recorded. Paid until ${date(b.team.paidUntil)}, ${b.team.seats} seats.`);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const minor = toMinor(price);
    if (Number.isNaN(minor)) { setError("The seat price is a number, like 4 or 3.50."); return; }
    const until = paidUntil ? endOfDay(paidUntil) : null;
    if (paidUntil && until === null) { setError("That date doesn't look right."); return; }
    const body: Record<string, unknown> = { name, seats, seatPrice: minor, currency };
    const before = t.paidUntil ? new Date(t.paidUntil).toISOString().slice(0, 10) : "";
    if (paidUntil !== before) {
      if (!window.confirm(paidUntil ? `Set ${t.name} as paid until ${paidUntil}?` : `Mark ${t.name} as not paid? Its members lose PRO now, with no grace days.`)) return;
      body.paidUntil = until;
    }
    void run(base, body, () => "Saved.");
  };

  return (
    <li className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--text-main)]">{t.name}</span>
            <StateBadge state={t.state} />
            <span className="text-[11px] text-[var(--text-subtle)]">{t.kind === "school" ? "School" : "Team"}</span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            {t.ownerEmail || "No admin address"} · added {date(t.createdAt)}
          </p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Seats used</dt><dd className="text-[16px] font-bold tabular-nums">{full(t.memberCount)} / {full(t.seats)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">A seat a month</dt><dd className="text-[14px] font-semibold tabular-nums">{formatMoney(t.seatPrice, t.currency)}{t.customSeatPrice !== null ? <span className="ml-1 text-[10px] font-normal text-[var(--text-subtle)]">special</span> : null}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Paid until</dt><dd className="text-[14px] font-semibold">{t.paidUntil ? date(t.paidUntil) : "—"}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">PRO until</dt><dd className={`text-[14px] font-semibold ${t.state === "grace" ? "text-orange-400" : ""}`}>{t.state === "active" || t.state === "grace" ? date(t.graceUntil) : "—"}</dd></div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={() => toggle("invoice")} aria-expanded={panel === "invoice"}><Receipt size={13} /> Record an invoice</button>
        <button type="button" className={button} onClick={() => toggle("edit")} aria-expanded={panel === "edit"}><Pencil size={13} /> Edit</button>
        <button type="button" className={button} onClick={() => toggle("invite")} aria-expanded={panel === "invite"}><UserPlus size={13} /> Invite</button>
        <button type="button" className={button} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Members and payments
        </button>
      </div>

      {panel === "invoice" && (
        <form onSubmit={recordInvoice} className="mt-3 grid gap-3 rounded-lg border border-[var(--border-main)] p-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor={`inv-months-${t.id}`} className={label}>Paid for</label>
            <select id={`inv-months-${t.id}`} className={input} value={months} onChange={(e) => setMonths(e.target.value)}>
              <option value="1">1 month</option>
              <option value="4">1 term (4 months)</option>
              <option value="6">6 months</option>
              <option value="12">1 year</option>
            </select>
          </div>
          <div>
            <label htmlFor={`inv-seats-${t.id}`} className={label}>Seats</label>
            <input id={`inv-seats-${t.id}`} className={input} inputMode="numeric" value={invSeats} onChange={(e) => setInvSeats(e.target.value.replace(/[^0-9]/g, ""))} />
          </div>
          <div>
            <label htmlFor={`inv-amount-${t.id}`} className={label}>Amount received</label>
            <input id={`inv-amount-${t.id}`} className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="250" />
          </div>
          <div>
            <label htmlFor={`inv-cur-${t.id}`} className={label}>Currency</label>
            <input id={`inv-cur-${t.id}`} className={`${input} uppercase`} value={invCurrency} maxLength={3} onChange={(e) => setInvCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          </div>
          <div>
            <label htmlFor={`inv-note-${t.id}`} className={label}>Note</label>
            <input id={`inv-note-${t.id}`} className={input} value={invNote} maxLength={200} onChange={(e) => setInvNote(e.target.value)} placeholder="Bank transfer, INV-12" />
          </div>
          <div className="sm:col-span-2 lg:col-span-5">
            <button type="submit" className={button} disabled={busy}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Receipt size={13} />} Record payment</button>
            <p className="mt-1 text-[11px] text-[var(--text-subtle)]">The months are added after the current end, or from today if it has ended.</p>
          </div>
        </form>
      )}

      {panel === "edit" && (
        <form onSubmit={save} className="mt-3 grid gap-3 rounded-lg border border-[var(--border-main)] p-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor={`ed-name-${t.id}`} className={label}>Name</label>
            <input id={`ed-name-${t.id}`} className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`ed-seats-${t.id}`} className={label}>Seats</label>
            <input id={`ed-seats-${t.id}`} className={input} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/[^0-9]/g, ""))} />
          </div>
          <div>
            <label htmlFor={`ed-price-${t.id}`} className={label}>Special seat price (blank: normal)</label>
            <input id={`ed-price-${t.id}`} className={input} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`ed-cur-${t.id}`} className={label}>Currency</label>
            <input id={`ed-cur-${t.id}`} className={`${input} uppercase`} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          </div>
          <div>
            <label htmlFor={`ed-until-${t.id}`} className={label}>Paid until (blank: not paid)</label>
            <input id={`ed-until-${t.id}`} type="date" className={input} value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} />
          </div>
          <div className="sm:col-span-2 lg:col-span-5">
            <button type="submit" className={button} disabled={busy}>{busy ? <Loader2 size={13} className="animate-spin" /> : null} Save</button>
          </div>
        </form>
      )}

      {panel === "invite" && (
        <form
          onSubmit={(e) => { e.preventDefault(); void run(`${base}/invite`, { email: inviteEmail, role: inviteRole }, (b) => (b.invited.length ? `Invited ${b.invited[0]}.` : "Already on the team or invited.")); }}
          className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border-main)] p-3"
        >
          <div className="min-w-[200px] flex-1">
            <label htmlFor={`invite-${t.id}`} className={label}>Email</label>
            <input id={`invite-${t.id}`} className={input} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label htmlFor={`invite-role-${t.id}`} className={label}>As</label>
            <select id={`invite-role-${t.id}`} className={input} value={inviteRole} onChange={(e) => setInviteRole(e.target.value === "member" ? "member" : "admin")}>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
          </div>
          <button type="submit" className={button} disabled={busy || !inviteEmail.trim()}>{busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Invite</button>
        </form>
      )}

      {error && <p role="alert" className="mt-2 text-[12px] text-[var(--viz-alert-text)]">{error}</p>}
      {note && <p role="status" className="mt-2 text-[12px] text-green-500">{note}</p>}
      {open && <Details get={get} id={t.id} />}
    </li>
  );
}

export default function TeamsTab({ get, post }: { get: AdminGet; post: AdminPost }) {
  const { data, error, loading, reload } = useAdminData<TeamsResponse>(get, "/api/admin/teams");
  const members = (data?.teams ?? []).reduce((n, t) => n + t.memberCount, 0);
  const defaults = data?.defaults ?? { seatPrice: 500, currency: "USD", minSeats: 5 };

  return (
    <div>
      <Toolbar onRefresh={() => void reload(true)} loading={loading}>
        {data && (
          <span className="text-[12px] text-[var(--text-muted)]">
            {full(data.teams.length)} team{data.teams.length === 1 ? "" : "s"} · {full(members)} member{members === 1 ? "" : "s"}
          </span>
        )}
      </Toolbar>
      {error && <ErrorNote text={error} />}
      <AddTeam post={post} defaults={defaults} onAdded={() => void reload(true)} />
      {!data && loading && <Loading />}
      {data && data.teams.length === 0 && (
        <p className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]"><Users size={14} aria-hidden="true" /> No teams yet. Add one above, or teams start their own at {window.location.origin}/team.</p>
      )}
      {data && data.teams.length > 0 && (
        <ul className="space-y-3">
          {data.teams.map((t) => <TeamCard key={t.id} t={t} get={get} post={post} onChanged={() => void reload(true)} />)}
        </ul>
      )}
      <p className="mt-6 text-[11px] text-[var(--text-subtle)]">
        Team admins manage their own team at {window.location.origin}/team: they invite people, pay online and renew. Creators earn nothing on team payments.
      </p>
    </div>
  );
}
