import { hasPaidPro, standing, type BillingState } from "./billing";

/**
 * The admin dashboard's arithmetic: who is on which plan, sign-ups and
 * activity over time, daily series, payments, and a plain verdict on the
 * server. Pure functions over data the routes gather (server/adminStats.ts),
 * so every figure can be tested without Firebase or Paystack.
 */

const DAY = 24 * 60 * 60 * 1000;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface AuthUser {
  uid: string;
  email: string | null;
  name: string | null;
  providers: string[];
  verified: boolean;
  disabled: boolean;
  createdAt: number | null;
  lastSignInAt: number | null;
  /** When their sign-in was last refreshed: the app does this about hourly while open. */
  lastRefreshAt: number | null;
}

export interface UserDocSummary {
  subscriptionStatus?: string;
  currentPeriodEnd?: number | null;
  lastPaymentAt?: number | null;
  pastDueAt?: number | null;
  lastActiveAt?: number | null;
  compilesTotal?: number;
  aiMessagesTotal?: number;
  /** A creator code's free PRO trial (server/creators.ts). */
  trialEndsAt?: number | null;
  referralCode?: string | null;
}

export interface AccessLists {
  ownerEmails: string[];
  proAccessEmails: string[];
  earlyAccessEmails: string[];
}

export type Plan = "owner" | "granted" | "pro" | "trial" | "free";

export interface AdminUserRow {
  uid: string;
  name: string | null;
  email: string | null;
  providers: string[];
  verified: boolean;
  disabled: boolean;
  createdAt: number | null;
  lastSignInAt: number | null;
  lastActiveAt: number | null;
  plan: Plan;
  /** Early access while the launch lock is on. */
  early: boolean;
  subscriptionStatus: string;
  renewsAt: number | null;
  proUntil: number | null;
  projects: number;
  compilesTotal: number;
  aiMessagesTotal: number;
  /** A Free account holding more projects than Free allows. */
  overLimit: boolean;
  /** The creator code the account came by, if any. */
  referralCode: string | null;
  /** When a code's PRO trial ends (or ended). */
  trialEndsAt: number | null;
}

const norm = (e: string | null | undefined) => (e || "").trim().toLowerCase();

function billingOf(doc: UserDocSummary | undefined): BillingState {
  return {
    subscriptionStatus: doc?.subscriptionStatus || "none",
    currentPeriodEnd: doc?.currentPeriodEnd ?? null,
    lastPaymentAt: doc?.lastPaymentAt ?? null,
    pastDueAt: doc?.pastDueAt ?? null,
  };
}

/** A user's plan, the way the rest of the server decides it (server/access.ts, server/quota.ts). */
export function planOf(user: Pick<AuthUser, "email" | "verified">, doc: UserDocSummary | undefined, lists: AccessLists, now: number): Plan {
  const email = user.verified ? norm(user.email) : "";
  if (email && lists.ownerEmails.map(norm).includes(email)) return "owner";
  if (hasPaidPro(billingOf(doc), now)) return "pro";
  if (email && lists.proAccessEmails.map(norm).includes(email)) return "granted";
  if (typeof doc?.trialEndsAt === "number" && doc.trialEndsAt > now) return "trial";
  return "free";
}

export function buildUserRows(
  users: AuthUser[],
  docs: Map<string, UserDocSummary>,
  projectCounts: Map<string, number>,
  lists: AccessLists,
  now: number,
  freeProjectLimit: number,
): AdminUserRow[] {
  const early = new Set(lists.earlyAccessEmails.map(norm));
  return users.map((u) => {
    const doc = docs.get(u.uid);
    const plan = planOf(u, doc, lists, now);
    const billing = billingOf(doc);
    const { renewsAt, proUntil } = standing(billing, now);
    const projects = projectCounts.get(u.uid) ?? 0;
    const lastActiveAt = Math.max(doc?.lastActiveAt ?? 0, u.lastRefreshAt ?? 0, u.lastSignInAt ?? 0) || null;
    return {
      uid: u.uid,
      name: u.name,
      email: u.email,
      providers: u.providers,
      verified: u.verified,
      disabled: u.disabled,
      createdAt: u.createdAt,
      lastSignInAt: u.lastSignInAt,
      lastActiveAt,
      plan,
      early: u.verified && early.has(norm(u.email)),
      subscriptionStatus: billing.subscriptionStatus,
      renewsAt: plan === "pro" ? renewsAt : null,
      proUntil: plan === "pro" ? proUntil : null,
      projects,
      compilesTotal: doc?.compilesTotal ?? 0,
      aiMessagesTotal: doc?.aiMessagesTotal ?? 0,
      overLimit: plan === "free" && projects > freeProjectLimit,
      referralCode: doc?.referralCode ?? null,
      trialEndsAt: doc?.trialEndsAt ?? null,
    };
  }).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export interface UserSummary {
  total: number;
  verified: number;
  disabled: number;
  providers: Record<string, number>;
  signups: { today: number; d7: number; d30: number };
  active: { d1: number; d7: number; d30: number };
  plans: { owner: number; granted: number; pro: number; proRenewing: number; proEnding: number; trial: number; free: number; early: number };
  /** Paid PRO accounts whose last renewal failed. */
  pastDue: number;
  freeOverLimit: number;
  withProjects: number;
}

export function summarizeUsers(rows: AdminUserRow[], now: number): UserSummary {
  const today = utcDay(now);
  const within = (t: number | null, days: number) => t !== null && t >= now - days * DAY;
  const providers: Record<string, number> = {};
  for (const r of rows) for (const p of r.providers.length ? r.providers : ["unknown"]) providers[p] = (providers[p] ?? 0) + 1;
  const count = (f: (r: AdminUserRow) => boolean) => rows.filter(f).length;
  return {
    total: rows.length,
    verified: count((r) => r.verified),
    disabled: count((r) => r.disabled),
    providers,
    signups: {
      today: count((r) => r.createdAt !== null && utcDay(r.createdAt) === today),
      d7: count((r) => within(r.createdAt, 7)),
      d30: count((r) => within(r.createdAt, 30)),
    },
    active: {
      d1: count((r) => within(r.lastActiveAt, 1)),
      d7: count((r) => within(r.lastActiveAt, 7)),
      d30: count((r) => within(r.lastActiveAt, 30)),
    },
    plans: {
      owner: count((r) => r.plan === "owner"),
      granted: count((r) => r.plan === "granted"),
      pro: count((r) => r.plan === "pro"),
      proRenewing: count((r) => r.plan === "pro" && r.proUntil === null),
      proEnding: count((r) => r.plan === "pro" && r.proUntil !== null),
      trial: count((r) => r.plan === "trial"),
      free: count((r) => r.plan === "free"),
      early: count((r) => r.early),
    },
    pastDue: count((r) => r.subscriptionStatus === "past_due"),
    freeOverLimit: count((r) => r.overLimit),
    withProjects: count((r) => r.projects > 0),
  };
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** The last `days` UTC days, oldest first, ending today. */
export function dayRange(days: number, now: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(now - i * DAY));
  return out;
}

export type DailyStats = Record<string, any>;

export interface SeriesRow {
  day: string;
  signups: number;
  projectsCreated: number;
  activeUsers: number;
  compilesOk: number;
  compilesFailed: number;
  compilesBusy: number;
  aiMessages: number;
  aiFree: number;
  aiPro: number;
  voiceNotes: number;
  libraryAdds: number;
  pageViews: number;
  apiRequests: number;
  paymentsFailed: number;
  cancellations: number;
  avgCompileMs: number | null;
  maxCompileMs: number | null;
  compileWaits: number;
  avgWaitMs: number | null;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Counts per day: what was recorded that day, plus sign-ups and new projects by their own dates. */
export function buildSeries(days: string[], stats: Map<string, DailyStats>, signupTimes: number[], projectTimes: number[]): SeriesRow[] {
  const perDay = (times: number[]) => {
    const m = new Map<string, number>();
    for (const t of times) { const d = utcDay(t); m.set(d, (m.get(d) ?? 0) + 1); }
    return m;
  };
  const signups = perDay(signupTimes);
  const projects = perDay(projectTimes);
  return days.map((day) => {
    const s = stats.get(day) || {};
    const compileCount = n(s.compile_ms_count);
    const waits = n(s.compile_waits);
    return {
      day,
      signups: signups.get(day) ?? 0,
      projectsCreated: projects.get(day) ?? 0,
      activeUsers: n(s.active_users),
      compilesOk: n(s.compiles_ok),
      compilesFailed: n(s.compiles_failed),
      compilesBusy: n(s.compiles_busy),
      aiMessages: n(s.ai_chat) + n(s.ai_generate) + n(s.ai_debug),
      aiFree: n(s.ai_free),
      aiPro: n(s.ai_pro),
      voiceNotes: n(s.voice_notes),
      libraryAdds: n(s.library_imports) + n(s.library_adds),
      pageViews: n(s.page_views),
      apiRequests: n(s.api_requests),
      paymentsFailed: n(s.payments_failed),
      cancellations: n(s.cancellations),
      avgCompileMs: compileCount ? Math.round(n(s.compile_ms_total) / compileCount) : null,
      maxCompileMs: n(s.compile_ms_max) || null,
      compileWaits: waits,
      avgWaitMs: waits ? Math.round(n(s.compile_wait_ms_total) / waits) : null,
    };
  });
}

export function totals(series: SeriesRow[]) {
  const sum = (k: keyof SeriesRow) => series.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const compiles = sum("compilesOk") + sum("compilesFailed");
  const timed = series.filter((r) => r.avgCompileMs !== null);
  const weighted = timed.reduce((a, r) => a + (r.avgCompileMs ?? 0) * (r.compilesOk + r.compilesFailed || 1), 0);
  const weight = timed.reduce((a, r) => a + (r.compilesOk + r.compilesFailed || 1), 0);
  return {
    signups: sum("signups"),
    projectsCreated: sum("projectsCreated"),
    compilesOk: sum("compilesOk"),
    compilesFailed: sum("compilesFailed"),
    compilesBusy: sum("compilesBusy"),
    compileSuccessRate: compiles ? Math.round((sum("compilesOk") / compiles) * 100) : null,
    aiMessages: sum("aiMessages"),
    aiFree: sum("aiFree"),
    aiPro: sum("aiPro"),
    voiceNotes: sum("voiceNotes"),
    libraryAdds: sum("libraryAdds"),
    pageViews: sum("pageViews"),
    apiRequests: sum("apiRequests"),
    paymentsFailed: sum("paymentsFailed"),
    cancellations: sum("cancellations"),
    avgCompileMs: weight ? Math.round(weighted / weight) : null,
    maxCompileMs: Math.max(0, ...series.map((r) => r.maxCompileMs ?? 0)) || null,
    compileWaits: sum("compileWaits"),
    peakActiveUsers: Math.max(0, ...series.map((r) => r.activeUsers)),
  };
}

/** Builds per board over the days given, most first. */
export function boardTotals(days: string[], stats: Map<string, DailyStats>): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const day of days) {
    const boards = stats.get(day)?.boards;
    if (!boards || typeof boards !== "object") continue;
    for (const [id, v] of Object.entries(boards)) m.set(id, (m.get(id) ?? 0) + n(v));
  }
  return [...m].map(([id, count]) => ({ id, count })).filter((b) => b.count > 0).sort((a, b) => b.count - a.count);
}

/** Two sets of daily counts added together: what is saved, and what isn't written yet. */
export function addStats(a: DailyStats | undefined, b: { add: Record<string, number>; boards: Record<string, number>; max: Record<string, number> } | null): DailyStats {
  const out: DailyStats = { ...(a || {}) };
  if (!b) return out;
  for (const [k, v] of Object.entries(b.add)) out[k] = n(out[k]) + v;
  if (Object.keys(b.boards).length) {
    out.boards = { ...(out.boards || {}) };
    for (const [k, v] of Object.entries(b.boards)) out.boards[k] = n(out.boards[k]) + v;
  }
  for (const [k, v] of Object.entries(b.max)) out[k] = Math.max(n(out[k]), v);
  return out;
}

// ---------------------------------------------------------------------------
// Payments (Paystack)
// ---------------------------------------------------------------------------

export interface PaystackTx {
  id?: number | string;
  status?: string;
  amount?: number;
  currency?: string;
  paid_at?: string | null;
  paidAt?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  channel?: string;
  customer?: { email?: string };
  plan?: unknown;
}

export interface PaymentRow {
  id: string;
  at: number | null;
  email: string | null;
  amount: number;
  currency: string;
  status: string;
  channel: string | null;
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export function paymentRows(txs: PaystackTx[]): PaymentRow[] {
  return txs.map((t) => {
    const raw = t.paid_at || t.paidAt || t.created_at || t.createdAt || null;
    const at = raw ? Date.parse(raw) : NaN;
    return {
      id: String(t.id ?? ""),
      at: Number.isFinite(at) ? at : null,
      email: t.customer?.email ?? null,
      // Paystack counts in the smallest unit (kobo, cents).
      amount: n(t.amount) / 100,
      currency: String(t.currency || "NGN"),
      status: String(t.status || "unknown"),
      channel: t.channel ?? null,
    };
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function summarizePayments(rows: PaymentRow[], now: number) {
  const thisMonth = monthOf(now);
  const d = new Date(now);
  const lastMonth = monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15));
  const byCurrency: Record<string, { allTime: number; thisMonth: number; lastMonth: number; payments: number; failed: number }> = {};
  const entry = (currency: string) => (byCurrency[currency] ||= { allTime: 0, thisMonth: 0, lastMonth: 0, payments: 0, failed: 0 });
  const months = new Map<string, Record<string, number>>();
  let failed = 0;
  for (const r of rows) {
    if (r.status !== "success") {
      if (r.status === "failed") { failed++; entry(r.currency).failed += 1; }
      continue;
    }
    const c = entry(r.currency);
    c.allTime += r.amount;
    c.payments += 1;
    if (r.at !== null) {
      const m = monthOf(r.at);
      if (m === thisMonth) c.thisMonth += r.amount;
      if (m === lastMonth) c.lastMonth += r.amount;
      const row = months.get(m) || {};
      row[r.currency] = (row[r.currency] ?? 0) + r.amount;
      months.set(m, row);
    }
  }
  const byMonth: { month: string; amounts: Record<string, number> }[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15));
    byMonth.push({ month: m, amounts: months.get(m) || {} });
  }
  return { byCurrency, byMonth, failed, successful: rows.filter((r) => r.status === "success").length };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface ServerSnapshot {
  cores: number;
  load1: number;
  memTotal: number;
  memAvailable: number;
  diskTotal: number;
  diskFree: number;
  slots: number;
  running: number;
  waiting: number;
  /** The longest a build has waited for its turn today. */
  longestWaitMs: number;
  /** Builds turned away today because the line was too long. */
  busyToday: number;
}

export interface Verdict {
  level: "ok" | "busy" | "overloaded";
  reasons: string[];
  advice: string | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** OK, Busy or Overloaded, with the reasons in plain words. */
export function serverVerdict(s: ServerSnapshot): Verdict {
  const hard: string[] = [];
  const soft: string[] = [];
  const memUsed = pct(s.memTotal - s.memAvailable, s.memTotal);
  const diskUsed = pct(s.diskTotal - s.diskFree, s.diskTotal);
  const loadPct = pct(s.load1, s.cores);

  if (s.waiting >= s.slots * 3) hard.push(`${s.waiting} compiles are waiting for a turn`);
  else if (s.waiting > 0) soft.push(`${s.waiting} compile${s.waiting === 1 ? " is" : "s are"} waiting for a turn`);
  if (s.busyToday > 0) hard.push(`${s.busyToday} compile${s.busyToday === 1 ? " was" : "s were"} turned away today because the line was too long`);
  if (memUsed >= 90) hard.push(`memory is ${memUsed}% used`);
  else if (memUsed >= 80) soft.push(`memory is ${memUsed}% used`);
  if (diskUsed >= 95) hard.push(`the disk is ${diskUsed}% full`);
  else if (diskUsed >= 85) soft.push(`the disk is ${diskUsed}% full`);
  if (loadPct >= 200) hard.push(`the processor is working at ${loadPct}% of what it can handle`);
  else if (loadPct >= 100) soft.push(`the processor is working at ${loadPct}% of what it can handle`);
  if (s.longestWaitMs >= 60000) soft.push(`a compile waited ${Math.round(s.longestWaitMs / 1000)} seconds for its turn today`);

  const level: Verdict["level"] = hard.length ? "overloaded" : soft.length ? "busy" : "ok";
  let advice: string | null = null;
  if (diskUsed >= 85) advice = "Free up disk space, or add a larger disk.";
  else if (level === "overloaded") advice = "The server can't keep up. Move to a bigger server (for example 4 cores and 8 GB of memory).";
  else if (level === "busy") advice = "Fine for now. If this shows often, consider a bigger server.";
  return { level, reasons: [...hard, ...soft], advice };
}
