import React, { useCallback, useEffect, useState } from "react";
import { Users, Copy, Check, LogOut, Loader2, UserPlus, CreditCard, Link2, Mail, Shield, Trash2, RefreshCw, Pencil, X, PiggyBank, Lock } from "lucide-react";
import { useDocumentScroll } from "./useDocumentScroll";
import { useAuth } from "./contexts/AuthContext";
import GoogleSignInButton from "./components/GoogleSignInButton";
import { formatMoney, formatDay, nairaToDollars, PRO_MONTHLY } from "./lib/plans";
import { loadPaystack } from "./lib/paystackScript";
import { ConsentCard, MemberProjects, TeamProjectsCard } from "./components/TeamProjects";
import { TEAM_PRICES, PERIOD_MONTHS, renewalPrice, addSeatsPrice, daysLeft, stateLabel, teamSavings, teamMoney, lockOf, type TeamLock, type TeamPeriod, type LicenseState, type TeamRole, type TeamKind } from "./lib/teams";

/**
 * Team and school licenses (/team), by server/teams.ts. A team's admins pay
 * for its seats for a month or a year, invite people and manage who's on it;
 * every member has PRO while it's paid, and for its grace days after (2 after
 * a month, 30 after a year). Anyone signed
 * in can start one, or join one by its code or an invitation to their address.
 * Joining, invitations and team projects open once the license is paid, and
 * lock again if it ends without being renewed (lockOf). Prices are shown in
 * dollars; Paystack charges them in naira, said under each pay button.
 */

interface MemberRow { uid: string; email: string | null; emailVerified: boolean; role: TeamRole; joinedAt: number; adminsCanView: boolean }
interface PaymentRow { id: string; kind: "online" | "invoice"; action: "renew" | "add_seats"; period: TeamPeriod | null; months: number; seats: number; extra: number; amount: number; currency: string; paidAt: number; payerEmail: string | null; note: string | null }
interface TeamView {
  id: string;
  name: string;
  kind: TeamKind;
  role: TeamRole;
  state: LicenseState;
  paidUntil: number | null;
  graceUntil: number | null;
  seats: number;
  memberCount: number;
  admins: string[];
  /** Whether the person lets the team's admins see their projects. */
  adminsCanView: boolean;
  // An admin's view only.
  joinCode?: string;
  joinOpen?: boolean;
  seatPrice?: number;
  currency?: string;
  members?: MemberRow[];
  invites?: { email: string; role: TeamRole; invitedAt: number }[];
  payments?: PaymentRow[];
}
interface PageData {
  team: TeamView | null;
  invites: { teamId: string; teamName: string; role: TeamRole; state?: LicenseState }[];
  verified: boolean;
  prices: { seatPrice: number; currency: string; minSeats: number; maxSeats: number };
  payments: boolean;
}
type Call = (path: string, body?: unknown) => Promise<{ ok: boolean; data: any }>;
type ProPrice = { amount: number; currency: string };

// Shown for paying by invoice or bank transfer instead (as on /privacy).
const CONTACT_EMAIL = "victorogbonna313@gmail.com";

const card = "rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-5";
const input = "w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] px-3 py-2 text-[14px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] focus:border-[var(--accent-primary)] focus:outline-none";
const button = "inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium text-[var(--text-main)] transition hover:bg-[var(--bg-hover)] disabled:opacity-50";
const primary = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-5 text-[14px] font-bold text-white shadow-md disabled:opacity-60";
const heading = "flex items-center gap-2 text-[14px] font-semibold text-[var(--text-main)]";
const small = "text-[12px] text-[var(--text-muted)]";

function Notes({ error, note }: { error: string | null; note: string | null }) {
  return (
    <>
      {error && <p role="alert" className="mt-2 text-[13px] text-red-500">{error}</p>}
      {note && <p role="status" className="mt-2 text-[13px] text-green-500">{note}</p>}
    </>
  );
}

/**
 * The message for a locked join link, invitation box or team projects: pay
 * first (or renew), with a button to the Pay card for an admin.
 */
function PayFirst({ text, admin, lock }: { text: string; admin: boolean; lock: TeamLock }) {
  const toPay = () => {
    const el = document.getElementById("pay");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.querySelector<HTMLElement>("input[type=radio]:checked, button")?.focus({ preventScroll: true });
  };
  return (
    <div role="alert" data-pay-first="" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-orange-400/40 bg-orange-500/10 px-3 py-2 text-[13px] text-[var(--text-main)]">
      <span className="flex min-w-0 flex-1 items-start gap-2"><Lock size={14} className="mt-0.5 shrink-0 text-orange-400" aria-hidden="true" /> <span className="min-w-0">{text}</span></span>
      {admin && (
        <button type="button" onClick={toPay} className="shrink-0 font-semibold text-[var(--accent-primary)] underline underline-offset-2">
          {lock === "ended" ? "Renew now" : "Pay now"}
        </button>
      )}
    </div>
  );
}

/** What Paystack charges, in naira, under a pay button that shows dollars. */
function NairaLine({ naira }: { naira: string | null }) {
  return naira ? <p className={`mt-1 ${small}`} data-naira-note="">Charged in naira at checkout: {naira}.</p> : null;
}

/** Runs one request at a time for a card, with its own error and note. */
function useAction(call: Call, after: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (what: string, path: string, body: unknown, done: (data: any) => string | null): Promise<boolean> => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const r = await call(path, body);
      if (!r.ok) { setError(r.data.error || "That didn't work. Try again."); return false; }
      setNote(done(r.data));
      await after();
      return true;
    } catch {
      setError("Couldn't reach the server. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, note, run, setError, setNote };
}

function StateBadge({ state }: { state: LicenseState }) {
  const tone = state === "active" ? "bg-green-500/15 text-green-500" : state === "grace" ? "bg-orange-500/15 text-orange-400" : "bg-[var(--bg-hover)] text-[var(--text-muted)]";
  return <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{stateLabel(state)}</span>;
}

function Standing({ team }: { team: TeamView }) {
  const who = team.role === "admin" ? "Everyone on it" : "You";
  if (team.state === "active" && team.paidUntil !== null) {
    return <p className="text-[14px] text-[var(--text-main)]">Paid until <strong>{formatDay(team.paidUntil)}</strong>. {who} {team.role === "admin" ? "has" : "have"} PRO.</p>;
  }
  if (team.state === "grace" && team.paidUntil !== null && team.graceUntil !== null) {
    const days = daysLeft(team.graceUntil);
    return (
      <p className="text-[14px] text-orange-400">
        Ended on {formatDay(team.paidUntil)}. {who} {team.role === "admin" ? "keeps" : "keep"} PRO for {days} more day{days === 1 ? "" : "s"}, until <strong>{formatDay(team.graceUntil)}</strong>.
        {team.role === "admin" ? " Renew below to keep it." : " Ask an admin to renew it."}
      </p>
    );
  }
  if (team.state === "ended") {
    return <p className="text-[14px] text-[var(--text-muted)]">Ended{team.paidUntil !== null ? ` on ${formatDay(team.paidUntil)}` : ""}. Members are on Free until it's renewed. Everyone's projects are kept.</p>;
  }
  return <p className="text-[14px] text-[var(--text-muted)]">Not paid yet. Everyone on it gets PRO once it's paid.</p>;
}

function Overview({ team }: { team: TeamView }) {
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[18px] font-bold text-[var(--text-main)]">{team.name}</h2>
        <StateBadge state={team.state} />
        <span className="text-[12px] text-[var(--text-subtle)]">{team.kind === "school" ? "School license" : "Team license"}{team.role === "admin" ? " · you're an admin" : ""}</span>
      </div>
      <div className="mt-2"><Standing team={team} /></div>
      <p className={`mt-2 ${small}`}>{team.memberCount} of {team.seats} seats used.</p>
      {team.role !== "admin" && team.admins.length > 0 && (
        <p className={`mt-1 ${small}`}>Admin{team.admins.length === 1 ? "" : "s"}: {team.admins.join(", ")}</p>
      )}
    </section>
  );
}

function PayCard({ team, call, reload, paymentsOn, prices }: { team: TeamView; call: Call; reload: () => Promise<void>; paymentsOn: boolean; prices: PageData["prices"] }) {
  const seatPrice = team.seatPrice ?? prices.seatPrice;
  const currency = team.currency ?? prices.currency;
  const money = teamMoney(seatPrice, currency);
  const least = Math.max(prices.minSeats, team.memberCount);
  const [period, setPeriod] = useState<TeamPeriod>("month");
  const [seats, setSeats] = useState(String(Math.max(team.seats, least)));
  // After a payment or a change of members, start from the team's new count.
  useEffect(() => { setSeats(String(Math.max(team.seats, least))); }, [team.seats, least]);
  const [extra, setExtra] = useState("1");
  const [paying, setPaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const seatCount = Number(seats);
  const seatsOk = Number.isInteger(seatCount) && seatCount >= least && seatCount <= prices.maxSeats;
  const extraCount = Number(extra);
  const extraOk = Number.isInteger(extraCount) && extraCount >= 1 && team.seats + extraCount <= prices.maxSeats;
  const renewAmount = seatsOk ? renewalPrice(seatCount, seatPrice, period) : 0;
  const addAmount = extraOk ? addSeatsPrice(extraCount, seatPrice, team.paidUntil) : 0;

  const pay = async (what: string, body: Record<string, unknown>) => {
    setPaying(what);
    setError(null);
    setNote(null);
    let checkout: any;
    try {
      const r = await call("/api/team/checkout", body);
      if (!r.ok) { setError(r.data.error || "Couldn't start the payment."); setPaying(null); return; }
      checkout = r.data;
    } catch {
      setError("Couldn't reach the server. Try again.");
      setPaying(null);
      return;
    }
    if (!(await loadPaystack()) || !window.PaystackPop) {
      setError("The payment window couldn't load. Check your connection, then try again.");
      setPaying(null);
      return;
    }
    window.PaystackPop.setup({
      key: checkout.publicKey,
      email: checkout.email,
      amount: checkout.amount,
      currency: checkout.currency,
      metadata: checkout.metadata,
      // A plain function: Paystack rejects an async one.
      callback: (response) => {
        void (async () => {
          try {
            const v = await call("/api/paystack/verify", { reference: response.reference });
            if (v.ok) {
              setNote(typeof v.data.paidUntil === "number"
                ? `Paid, thank you. The license runs until ${formatDay(v.data.paidUntil)}, with ${v.data.seats} seats.`
                : "Paid, thank you.");
              await reload();
            } else {
              setError(v.data.error || "The payment couldn't be confirmed. If you were charged, contact us with its reference.");
            }
          } catch {
            setError("The payment couldn't be confirmed yet. If you were charged, it shows here within a few minutes.");
          } finally {
            setPaying(null);
          }
        })();
      },
      onClose: () => setPaying((p) => (p === what ? null : p)),
    }).openIframe();
  };

  return (
    <section className={`${card} scroll-mt-4`} id="pay">
      <h2 className={heading}><CreditCard size={16} aria-hidden="true" /> {team.state === "unpaid" ? "Pay for the license" : "Renew"}</h2>
      <p className={`mt-1 ${small}`}>
        {money.show(seatPrice)} a seat a month, paid ahead for a month, or for a year at 12 months for the price of 11. Nothing renews by itself: you renew here when it's due.
        {team.state === "active" ? " Renewing now adds the time after the current end." : " It runs from the day you pay."}
        {" "}If it isn't renewed, everyone keeps PRO for 2 more days after a month, or 30 more days after a year.
      </p>

      <fieldset className="mt-4">
        <legend className="mb-2 text-[12px] font-medium text-[var(--text-muted)]">How long</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(PERIOD_MONTHS) as TeamPeriod[]).map((p) => (
            <label key={p} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${period === p ? "border-[var(--accent-primary)] bg-[var(--accent-primary-soft)]" : "border-[var(--border-main)]"}`}>
              <input type="radio" name="period" value={p} checked={period === p} onChange={() => setPeriod(p)} className="accent-[var(--accent-primary)]" />
              <span>{p === "year" ? <>1 year <span className="text-[var(--text-muted)]">(12 months for the price of 11)</span></> : "1 month"}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-32">
          <label htmlFor="renew-seats" className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Seats</label>
          <input id="renew-seats" className={input} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        <button
          type="button"
          className={primary}
          style={{ background: "var(--gradient-hero)" }}
          disabled={!paymentsOn || !seatsOk || paying !== null}
          onClick={() => void pay("renew", { action: "renew", period, seats: seatCount })}
        >
          {paying === "renew" ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
          {seatsOk ? `Pay ${money.show(renewAmount)} for ${PERIOD_MONTHS[period].label}` : "Pay"}
        </button>
      </div>
      {seatsOk && <NairaLine naira={money.naira(renewAmount)} />}
      {!seatsOk && <p className={`mt-1 ${small}`}>Choose {least} to {prices.maxSeats} seats{team.memberCount > prices.minSeats ? `: the team has ${team.memberCount} members` : ""}.</p>}

      {team.state === "active" && team.paidUntil !== null && (
        <div className="mt-5 border-t border-[var(--border-main)] pt-4">
          <h3 className="text-[13px] font-semibold text-[var(--text-main)]">Add seats now</h3>
          <p className={`mt-1 ${small}`}>Charged only for the {daysLeft(team.paidUntil)} days left, until {formatDay(team.paidUntil)}.</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className="w-32">
              <label htmlFor="extra-seats" className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Extra seats</label>
              <input id="extra-seats" className={input} inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value.replace(/[^0-9]/g, ""))} />
            </div>
            <button type="button" className={button} disabled={!paymentsOn || !extraOk || paying !== null} onClick={() => void pay("add", { action: "add_seats", extra: extraCount })}>
              {paying === "add" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              {extraOk ? `Add ${extraCount} seat${extraCount === 1 ? "" : "s"}: ${money.show(addAmount)}` : "Add seats"}
            </button>
          </div>
          {extraOk && <NairaLine naira={money.naira(addAmount)} />}
        </div>
      )}

      {!paymentsOn && <p className={`mt-3 ${small}`}>Paying online isn't switched on yet.</p>}
      <p className={`mt-3 ${small}`}>
        Paying by invoice or bank transfer? Email <a className="text-[var(--accent-primary)] hover:underline" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Team license: ${team.name}`)}`}>{CONTACT_EMAIL}</a> with your team's name and the seats you need.
      </p>
      <Notes error={error} note={note} />
    </section>
  );
}

/** What a team saves against everyone paying for PRO on their own, at the foot of the page. */
function SavingsCard({ seats, seatPrice, currency, proMonthly }: { seats: number; seatPrice: number; currency: string; proMonthly: ProPrice | null }) {
  const shown = teamMoney(seatPrice, currency);
  // PRO on your own as the app shows it, in dollars: Paystack's monthly price, else the listed $7.
  const pro = proMonthly && proMonthly.currency.toUpperCase() === "NGN" ? { amount: nairaToDollars(proMonthly.amount), currency: "USD" } : proMonthly;
  const s = teamSavings(seats, shown.seat, shown.currency, [pro, { amount: PRO_MONTHLY.cents, currency: "USD" }]);
  if (!s) return null;
  const money = (n: number) => formatMoney(n, shown.currency);
  return (
    <section className={card} data-savings="">
      <h2 className={heading}><PiggyBank size={16} className="text-[var(--accent-primary)]" aria-hidden="true" /> What you save</h2>
      <p className="mt-2 text-[14px] text-[var(--text-main)]">
        <strong>{money(shown.seat)}</strong> a seat a month, instead of {money(s.pro)} for PRO on your own: <strong className="text-[var(--accent-primary)]">{money(s.perSeat)} saved</strong> on every seat, every month.
      </p>
      <p className={`mt-1 ${small}`}>
        {seats} seats: {money(s.teamPays)} a month instead of {money(s.onTheirOwn)}. That's {money(s.saved)} saved every month.
        {" "}Paying for a year at once is 12 months for the price of 11: one more month, {money(s.teamPays)}, saved.
      </p>
    </section>
  );
}

/** Before the license is paid, or once it has ended: why the join link and invitations are locked. */
const joinLockText = (lock: TeamLock, what: string) => (lock === "ended"
  ? `The license has ended. Renew it first, then ${what}.`
  : `Pay for the license first. Then ${what}.`);

/** Why team projects, and seeing members' projects, are locked: as the server says it. */
const teamProjectsLockText = (lock: TeamLock, admin: boolean) => (lock === "ended"
  ? (admin ? "The license has ended. Renew it to use team projects again. Everyone's own projects are kept." : "Your team's license has ended. Team projects come back once an admin renews it. Your own projects are kept.")
  : (admin ? "Team projects start once the license is paid." : "Team projects start once your team's license is paid. Ask an admin to pay for it."));

function JoinLinkCard({ team, call, reload }: { team: TeamView; call: Call; reload: () => Promise<void> }) {
  const { busy, error, note, run } = useAction(call, reload);
  const [copied, setCopied] = useState(false);
  const [askedLocked, setAskedLocked] = useState(false);
  const lock = lockOf(team.state);
  // The new state after a payment: unlocked, with nothing left to say.
  useEffect(() => { if (!lock) setAskedLocked(false); }, [lock]);
  const link = `${window.location.origin}/team?join=${encodeURIComponent(team.joinCode ?? "")}`;
  const copy = async () => {
    if (lock) { setAskedLocked(true); return; }
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  if (lock) {
    // Unclickable until it's paid: the code is hidden, and a press says why.
    return (
      <section className={card} data-join-link="locked">
        <h2 className={heading}><Link2 size={16} aria-hidden="true" /> Join link <Lock size={13} className="text-[var(--text-muted)]" aria-label="Locked" /></h2>
        <p className={`mt-1 ${small}`}>Anyone signed in with this link or code joins, while seats are free. It works once the license is paid.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" aria-disabled="true" onClick={() => setAskedLocked(true)} className="min-w-0 flex-1 cursor-not-allowed break-all rounded-lg bg-[var(--bg-surface)] px-3 py-2 text-left font-mono text-[13px] text-[var(--text-subtle)]">
            {window.location.origin}/team?join=••••••••
          </button>
          <button type="button" aria-disabled="true" onClick={() => void copy()} className={`${button} cursor-not-allowed opacity-50`}>
            <Copy size={14} /> Copy
          </button>
        </div>
        {askedLocked && <PayFirst text={joinLockText(lock, "share the join link")} admin lock={lock} />}
      </section>
    );
  }
  const newCode = () => {
    if (!window.confirm("Make a new join code? The current link and code stop working.")) return;
    void run("code", "/api/team/settings", { newCode: true }, () => "New code made. Share the new link.");
  };
  return (
    <section className={card}>
      <h2 className={heading}><Link2 size={16} aria-hidden="true" /> Join link</h2>
      <p className={`mt-1 ${small}`}>Anyone signed in with this link or code joins, while seats are free. Share it with your class or team.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-[var(--bg-surface)] px-3 py-2 text-[13px] text-[var(--text-main)]">{link}</code>
        <button type="button" onClick={copy} className={button}>
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={`mt-2 ${small}`}>Code: <span className="font-bold tracking-wider text-[var(--text-main)]">{team.joinCode}</span>{team.joinOpen ? "" : " · joining by code is off"}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy !== null} onClick={() => void run("open", "/api/team/settings", { joinOpen: !team.joinOpen }, () => (team.joinOpen ? "Joining by code is off. Invitations still work." : "Joining by code is on."))}>
          {busy === "open" && <Loader2 size={14} className="animate-spin" />} {team.joinOpen ? "Turn off joining by code" : "Turn on joining by code"}
        </button>
        <button type="button" className={button} disabled={busy !== null} onClick={newCode}>
          {busy === "code" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} New code
        </button>
      </div>
      <Notes error={error} note={note} />
    </section>
  );
}

function InviteCard({ team, call, reload }: { team: TeamView; call: Call; reload: () => Promise<void> }) {
  const { busy, error, note, run } = useAction(call, reload);
  const [emails, setEmails] = useState("");
  const [askedLocked, setAskedLocked] = useState(false);
  const lock = lockOf(team.state);
  useEffect(() => { if (!lock) setAskedLocked(false); }, [lock]);
  const invites = team.invites ?? [];
  const free = team.seats - team.memberCount - invites.length;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock) { setAskedLocked(true); return; }
    const ok = await run("invite", "/api/team/invites", { emails }, (d) => {
      const parts = [`Invited ${d.invited.length}.`];
      if (d.already.length) parts.push(`${d.already.length} already on the team or invited.`);
      if (d.invalid.length) parts.push(`Not email addresses: ${d.invalid.slice(0, 5).join(", ")}.`);
      return parts.join(" ");
    });
    if (ok) setEmails("");
  };
  return (
    <section className={card}>
      <h2 className={heading}><Mail size={16} aria-hidden="true" /> Invite by email {lock && <Lock size={13} className="text-[var(--text-muted)]" aria-label="Locked" />}</h2>
      <p className={`mt-1 ${small}`}>
        Paste addresses, separated by commas or new lines. Each person joins the next time they open Joint-Agent signed in with that address.{" "}
        {lock ? "It works once the license is paid." : free > 0 ? `${free} seat${free === 1 ? " is" : "s are"} free to invite.` : "Every seat is taken or invited."}
      </p>
      <form onSubmit={send} className="mt-3" data-invite-form={lock ? "locked" : ""}>
        <label htmlFor="invite-emails" className="sr-only">Email addresses</label>
        {lock ? (
          // Unclickable until it's paid: a press, or a tab into it, says why.
          <textarea
            id="invite-emails" readOnly aria-disabled="true" value="" onClick={() => setAskedLocked(true)} onFocus={() => setAskedLocked(true)}
            className={`${input} min-h-[96px] cursor-not-allowed opacity-50`} placeholder={"ada@school.edu\nben@school.edu"}
          />
        ) : (
          <textarea id="invite-emails" className={`${input} min-h-[96px]`} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={"ada@school.edu\nben@school.edu"} />
        )}
        {lock ? (
          <button type="submit" aria-disabled="true" className={`${button} mt-2 cursor-not-allowed opacity-50`}>
            <UserPlus size={14} /> Invite
          </button>
        ) : (
          <button type="submit" className={`${button} mt-2`} disabled={busy !== null || !emails.trim()}>
            {busy === "invite" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Invite
          </button>
        )}
      </form>
      {lock && askedLocked && <PayFirst text={joinLockText(lock, "invite people")} admin lock={lock} />}
      <Notes error={error} note={note} />
      {invites.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Invited, not joined yet</h3>
          <ul className="mt-2 divide-y divide-[var(--border-main)] text-[13px]">
            {invites.map((i) => (
              <li key={i.email} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-all">{i.email}{i.role === "admin" ? <span className="ml-1 text-[11px] text-[var(--text-subtle)]">(as admin)</span> : null}</span>
                <button type="button" className={button} disabled={busy !== null} onClick={() => void run(`x:${i.email}`, "/api/team/invites/cancel", { email: i.email }, () => `Withdrew the invitation to ${i.email}.`)}>
                  {busy === `x:${i.email}` ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Withdraw
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function MembersCard({ team, me, call, reload }: { team: TeamView; me: string; call: Call; reload: () => Promise<void> }) {
  const { busy, error, note, run } = useAction(call, reload);
  const members = team.members ?? [];
  const lock = lockOf(team.state);
  const remove = (m: MemberRow) => {
    if (!window.confirm(`Remove ${m.email || "this member"} from ${team.name}?\n\nThey keep their projects, and go back to the Free plan unless they pay for PRO themselves.`)) return;
    void run(`rm:${m.uid}`, "/api/team/members/remove", { uid: m.uid }, () => `Removed ${m.email || "the member"}.`);
  };
  return (
    <section className={card}>
      <h2 className={heading}><Users size={16} aria-hidden="true" /> Members ({members.length})</h2>
      <ul className="mt-3 divide-y divide-[var(--border-main)] text-[13px]">
        {members.map((m) => (
          <li key={m.uid} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0">
              <p className="break-all text-[var(--text-main)]">
                {m.email || "No email address"}
                {m.uid === me && <span className="ml-1 text-[11px] text-[var(--text-subtle)]">(you)</span>}
                {m.email && !m.emailVerified && <span className="ml-1 text-[11px] text-orange-400">(email not verified)</span>}
              </p>
              <p className="text-[11px] text-[var(--text-subtle)]">{m.role === "admin" ? "Admin" : "Member"} · joined {formatDay(m.joinedAt)}{m.uid !== me && !m.adminsCanView ? " · projects private" : ""}</p>
            </div>
            {m.uid !== me && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button" className={button} disabled={busy !== null}
                  onClick={() => void run(`role:${m.uid}`, "/api/team/members/role", { uid: m.uid, role: m.role === "admin" ? "member" : "admin" }, () => (m.role === "admin" ? `${m.email || "They"} can no longer manage the team.` : `${m.email || "They"} can now manage the team.`))}
                >
                  {busy === `role:${m.uid}` ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />} {m.role === "admin" ? "Make member" : "Make admin"}
                </button>
                <button type="button" className={`${button} hover:text-red-500`} disabled={busy !== null} onClick={() => remove(m)}>
                  {busy === `rm:${m.uid}` ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove
                </button>
              </div>
            )}
            {/* Only those who chose to let admins see their projects. */}
            {m.uid !== me && m.adminsCanView && <MemberProjects uid={m.uid} email={m.email} call={call} locked={lock ? <PayFirst text={joinLockText(lock, "see the projects of members who allow it")} admin lock={lock} /> : null} />}
          </li>
        ))}
      </ul>
      <Notes error={error} note={note} />
    </section>
  );
}

function PaymentsCard({ team, prices }: { team: TeamView; prices: PageData["prices"] }) {
  const payments = team.payments ?? [];
  if (!payments.length) return null;
  const currency = team.currency ?? prices.currency;
  const money = teamMoney(team.seatPrice ?? prices.seatPrice, currency);
  // In dollars, as every price is shown, with the naira Paystack charged beside it.
  const amount = (p: PaymentRow) => {
    if (p.amount <= 0) return "—";
    if (p.currency.toUpperCase() !== currency.toUpperCase()) return formatMoney(p.amount, p.currency);
    const naira = money.naira(p.amount);
    return <>{money.show(p.amount)}{naira && <>{" "}<span className="text-[11px] font-normal text-[var(--text-subtle)]">({naira})</span></>}</>;
  };
  return (
    <section className={card}>
      <h2 className={heading}><CreditCard size={16} aria-hidden="true" /> Payments</h2>
      <ul className="mt-3 divide-y divide-[var(--border-main)] text-[13px]">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-[var(--text-muted)]">
              {formatDay(p.paidAt)} · {p.action === "add_seats" ? `${p.extra} seat${p.extra === 1 ? "" : "s"} added` : `${p.months} month${p.months === 1 ? "" : "s"}, ${p.seats} seats`}
              {p.kind === "invoice" ? " · by invoice" : ""}
            </span>
            <span className="font-semibold tabular-nums">{amount(p)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenameCard({ team, call, reload }: { team: TeamView; call: Call; reload: () => Promise<void> }) {
  const { busy, error, note, run } = useAction(call, reload);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  if (!editing) {
    return (
      <div>
        <button type="button" className={button} onClick={() => { setName(team.name); setEditing(true); }}><Pencil size={14} /> Rename</button>
        <Notes error={error} note={note} />
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => { e.preventDefault(); void run("name", "/api/team/settings", { name }, () => "Renamed.").then((ok) => { if (ok) setEditing(false); }); }}
    >
      <label htmlFor="team-name" className="sr-only">Team name</label>
      <input id="team-name" className={`${input} max-w-xs`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
      <button type="submit" className={button} disabled={busy !== null || name.trim().length < 2}>{busy ? <Loader2 size={14} className="animate-spin" /> : null} Save</button>
      <button type="button" className={button} onClick={() => setEditing(false)}>Cancel</button>
      <Notes error={error} note={null} />
    </form>
  );
}

function LeaveButton({ team, call, reload }: { team: TeamView; call: Call; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(call, reload);
  const leave = () => {
    if (!window.confirm(`Leave ${team.name}?\n\nYou keep your projects, and go back to the Free plan unless you pay for PRO yourself.`)) return;
    void run("leave", "/api/team/leave", {}, () => null);
  };
  return (
    <div>
      <button type="button" className={`${button} hover:text-red-500`} disabled={busy !== null} onClick={leave}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />} Leave team
      </button>
      <Notes error={error} note={null} />
    </div>
  );
}

function WaitingInvites({ data, call, reload }: { data: PageData; call: Call; reload: () => Promise<void> }) {
  const { busy, error, note, run } = useAction(call, reload);
  if (!data.invites.length) return null;
  return (
    <section className={card}>
      <h2 className={heading}><Mail size={16} aria-hidden="true" /> Invitations</h2>
      <ul className="mt-2 divide-y divide-[var(--border-main)] text-[13px]">
        {data.invites.map((i) => (
          <li key={i.teamId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <strong>{i.teamName}</strong> invited you{i.role === "admin" ? " as its admin" : ""}.{" "}
              <span className="text-[var(--text-muted)]">
                {data.team
                  ? "Leave your current team to join it."
                  : i.role !== "admin" && i.state === "unpaid"
                    ? "It's waiting for the team's license to be paid."
                    : i.role !== "admin" && i.state === "ended"
                      ? "It's waiting for the team's license to be renewed."
                      : "It's waiting for a free seat."}
              </span>
            </span>
            <button type="button" className={button} disabled={busy !== null} onClick={() => void run(`d:${i.teamId}`, "/api/team/invites/decline", { teamId: i.teamId }, () => `Declined ${i.teamName}'s invitation.`)}>
              {busy === `d:${i.teamId}` ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Decline
            </button>
          </li>
        ))}
      </ul>
      <Notes error={error} note={note} />
    </section>
  );
}

function NoTeam({ data, call, reload, joinFromLink, proMonthly }: { data: PageData; call: Call; reload: () => Promise<void>; joinFromLink: string; proMonthly: ProPrice | null }) {
  const join = useAction(call, reload);
  const create = useAction(call, reload);
  const [code, setCode] = useState(joinFromLink);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TeamKind>("school");
  const [seats, setSeats] = useState(String(data.prices.minSeats));
  const seatCount = Number(seats);
  const seatsOk = Number.isInteger(seatCount) && seatCount >= data.prices.minSeats && seatCount <= data.prices.maxSeats;
  const shownSeats = seatsOk ? seatCount : data.prices.minSeats;
  const money = teamMoney(data.prices.seatPrice, data.prices.currency);
  const price = (p: TeamPeriod) => money.show(renewalPrice(shownSeats, data.prices.seatPrice, p));
  const naira = (p: TeamPeriod) => money.naira(renewalPrice(shownSeats, data.prices.seatPrice, p));

  return (
    <div className="space-y-4">
      <section className={card}>
        <h2 className={heading}><UserPlus size={16} aria-hidden="true" /> Join a team</h2>
        <p className={`mt-1 ${small}`}>Got a join code or link from your teacher or team? Enter the code.</p>
        {!data.verified && (
          <p className={`mt-1 ${small}`}>Invited by email? Verify your email address, then open this page again.</p>
        )}
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void join.run("join", "/api/team/join", { code }, (d) => {
              const url = new URL(window.location.href);
              url.searchParams.delete("join");
              window.history.replaceState(null, "", url.toString());
              return `You joined ${d.name}.`;
            });
          }}
        >
          <label htmlFor="join-code" className="sr-only">Join code</label>
          <input
            id="join-code" className={`${input} w-44 font-semibold tracking-widest`} value={code} maxLength={8}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            placeholder="ABCD2345" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          />
          <button type="submit" className={primary} style={{ background: "var(--gradient-hero)" }} disabled={join.busy !== null || code.length !== 8}>
            {join.busy ? <Loader2 size={16} className="animate-spin" /> : null} Join
          </button>
        </form>
        <Notes error={join.error} note={join.note} />
      </section>

      <section className={card}>
        <h2 className={heading}><Users size={16} aria-hidden="true" /> Start a school or team license</h2>
        <p className={`mt-1 ${small}`}>
          PRO for everyone on it: {money.show(data.prices.seatPrice)} a seat a month, at least {data.prices.minSeats} seats.
          Pay for a month, or for a year at 12 months for the price of 11. When a license ends, everyone keeps PRO for 2 more days after a month, or 30 more days after a year.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => { e.preventDefault(); void create.run("create", "/api/team", { name, kind, seats: seatCount }, () => null); }}
        >
          <div>
            <label htmlFor="new-team-name" className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Name</label>
            <input id="new-team-name" className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Kings College Robotics Club" />
          </div>
          <fieldset>
            <legend className="mb-1 text-[12px] font-medium text-[var(--text-muted)]">It's for</legend>
            <div className="flex flex-wrap gap-2">
              {([["school", "A school or class"], ["team", "A team or group"]] as [TeamKind, string][]).map(([k, label]) => (
                <label key={k} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] ${kind === k ? "border-[var(--accent-primary)] bg-[var(--accent-primary-soft)]" : "border-[var(--border-main)]"}`}>
                  <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--accent-primary)]" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="w-32">
            <label htmlFor="new-team-seats" className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Seats</label>
            <input id="new-team-seats" className={input} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/[^0-9]/g, ""))} />
          </div>
          <p className={small}>
            {shownSeats} seats: {price("month")} a month, or {price("year")} a year. You pay on the next step; members get PRO, and the join link and invitations work, once it's paid.
            {naira("month") && <> Charged in naira at checkout: {naira("month")} a month, or {naira("year")} a year.</>}
          </p>
          <button type="submit" className={primary} style={{ background: "var(--gradient-hero)" }} disabled={create.busy !== null || name.trim().length < 2 || !seatsOk}>
            {create.busy ? <Loader2 size={16} className="animate-spin" /> : null} Start the license
          </button>
        </form>
        <Notes error={create.error} note={create.note} />
      </section>

      <SavingsCard seats={shownSeats} seatPrice={data.prices.seatPrice} currency={data.prices.currency} proMonthly={proMonthly} />
    </div>
  );
}

export default function TeamPage() {
  useDocumentScroll();
  const { user, loading, signOut } = useAuth();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinFromLink] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("join") || "";
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  });

  const call: Call = useCallback(async (path, body) => {
    if (!user) throw new Error("Sign in first.");
    const idToken = await user.getIdToken();
    const res = await fetch(path, body === undefined
      ? { headers: { Authorization: `Bearer ${idToken}` } }
      : { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, data: json };
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const r = await call("/api/team/me");
      if (!r.ok) { setError(r.data.error || "Couldn't load your team."); return; }
      setData(r.data);
      setError(null);
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  }, [user, call]);

  useEffect(() => {
    if (!user) { setData(null); return; }
    void load();
  }, [user, load]);

  // PRO's own monthly price from Paystack, for what a team saves (else the $7 the app lists).
  const [proMonthly, setProMonthly] = useState<ProPrice | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/paystack/prices");
        const m = (await res.json().catch(() => null))?.monthly;
        if (!cancelled && res.ok && m && typeof m.amount === "number" && typeof m.currency === "string") setProMonthly({ amount: m.amount, currency: m.currency });
      } catch {
        // The listed $7 stands in.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const team = data?.team ?? null;
  const lock = team ? lockOf(team.state) : null;

  return (
    <div className="min-h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="h-9 w-9 rounded-lg" />
            <span className="font-display text-[15px] font-bold">Joint-Agent <span className="gradient-text">IDE</span></span>
          </a>
          {user && (
            <button type="button" onClick={() => void signOut()} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-[13px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]">
              <LogOut size={14} /> Sign out
            </button>
          )}
        </header>

        <h1 className="flex items-center gap-2 font-display text-2xl font-bold"><Users size={22} className="text-[var(--accent-primary)]" /> Schools and teams</h1>

        {loading ? (
          <p className="mt-6 flex items-center gap-2 text-[14px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /> Loading…</p>
        ) : !user ? (
          <div className="mt-6 space-y-4">
            <div className={card}>
              <p className="text-[14px] text-[var(--text-muted)]">
                {joinFromLink ? "Sign in to join your team." : "Sign in to start a school or team license, or to join one."}
              </p>
              <GoogleSignInButton className={`mt-4 ${primary}`} style={{ background: "var(--gradient-hero)" }} />
            </div>
            <SavingsCard seats={TEAM_PRICES.minSeats} seatPrice={TEAM_PRICES.seatPrice} currency={TEAM_PRICES.currency} proMonthly={proMonthly} />
          </div>
        ) : error && !data ? (
          <p role="alert" className="mt-6 text-[14px] text-red-500">{error}</p>
        ) : !data ? (
          <p className="mt-6 flex items-center gap-2 text-[14px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /> Loading your team…</p>
        ) : (
          <div className="mt-6 space-y-4">
            {error && <p role="alert" className="text-[14px] text-red-500">{error}</p>}
            <WaitingInvites data={data} call={call} reload={load} />
            {!team ? (
              <NoTeam data={data} call={call} reload={load} joinFromLink={joinFromLink} proMonthly={proMonthly} />
            ) : (
              <>
                <Overview team={team} />
                {team.role === "admin" && <PayCard team={team} call={call} reload={load} paymentsOn={data.payments} prices={data.prices} />}
                <TeamProjectsCard
                  teamName={team.name} call={call}
                  locked={lock ? <PayFirst text={teamProjectsLockText(lock, team.role === "admin")} admin={team.role === "admin"} lock={lock} /> : null}
                />
                <ConsentCard teamName={team.name} allowed={team.adminsCanView} call={call} reload={load} />
                {team.role === "admin" && (
                  <>
                    <JoinLinkCard team={team} call={call} reload={load} />
                    <InviteCard team={team} call={call} reload={load} />
                    <MembersCard team={team} me={user.uid} call={call} reload={load} />
                    <PaymentsCard team={team} prices={data.prices} />
                    <SavingsCard seats={team.seats} seatPrice={team.seatPrice ?? data.prices.seatPrice} currency={team.currency ?? data.prices.currency} proMonthly={proMonthly} />
                  </>
                )}
                <div className="flex flex-wrap items-start gap-2">
                  {team.role === "admin" && <RenameCard team={team} call={call} reload={load} />}
                  <LeaveButton team={team} call={call} reload={load} />
                </div>
                <p className="text-[12px] text-[var(--text-subtle)]">
                  <a href="/" className="text-[var(--accent-primary)] hover:underline">Open Joint-Agent IDE</a>
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
