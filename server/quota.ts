import type { Request, Response, NextFunction } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { loadAdminConfig } from "./adminConfig";
import { accessLevelFor, bypassesLaunchLock, LAUNCH_LOCKED_CODE, LAUNCH_LOCKED_MESSAGE } from "./access";
import { hasPaidPro, standing, type BillingState } from "./billing";
import { isOnTrial } from "./referrals";
import { teamGivesPro, teamMonthKey, nextTeamMonthStart, isPeriod, type TeamPeriod } from "./teamRules";
import { noteActive } from "./stats";

/** Sentinel subscription status for accounts whose usage is never counted. */
export const UNMETERED_STATUS = "unmetered";

/**
 * Every metered account works in 5-hour windows, the way ChatGPT, Claude and
 * Gemini meter their plans. A window opens with the first counted reply after
 * the previous one closed, and refills in full when it ends.
 *
 * Free: FREE_WINDOW_TOKENS a window and at most FREE_DAILY_TOKENS a UTC day.
 * PRO: PRO_WINDOW_TOKENS a window (25x Free), and a subscriber at most
 * PAID_TOKEN_CAP a billing cycle (reset by server/paystack.ts on each
 * successful charge). A granted PRO account has the window, not the cycle
 * cap: nothing would ever reset it. A team or school license's member
 * (server/teams.ts) has PRO's window and at most PAID_TOKEN_CAP a calendar
 * month (UTC).
 *
 * Only what the model writes is counted, as before.
 */
export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const FREE_WINDOW_TOKENS = 10000;
export const FREE_DAILY_TOKENS = 20000;
export const PRO_WINDOW_TOKENS = 250000;
export const PAID_TOKEN_CAP = 3000000;

/** Free compiles. Only successful builds count: a failed one is handed back. */
export const FREE_WINDOW_COMPILES = 10;
export const FREE_DAILY_COMPILES = 30;

export type Tier = "unmetered" | "pro" | "free";

/** What the quota middleware learned about the caller, for the route. */
export interface QuotaContext {
  tier: Tier;
  subscriptionStatus: string;
  tokensUsed: number;
  tokenCap: number;
}

declare global {
  namespace Express {
    interface Request {
      uid?: string;
      quota?: QuotaContext;
      email?: string | null;
      emailVerified?: boolean;
    }
  }
}

// Per-uid request throttle, independent of the token cap — bounds how fast a
// single account can hammer the 4 Gemini-calling routes regardless of how
// much of their token allowance remains, so a runaway client-side loop or a
// scripted abuse attempt can't rack up cost at unbounded speed. In-memory,
// per-instance — fine for a single Cloud Run instance today; move to a
// shared store (Firestore/Redis) if this ever runs multi-instance.
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitState = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(uid: string): boolean {
  const now = Date.now();
  const entry = rateLimitState.get(uid);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(uid, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

export interface UserQuotaDoc {
  /** Every token a free account has used, ever. Monitoring only now. */
  lifetimeFreeTokensUsed: number;
  cycleTokensUsed: number;
  subscriptionStatus: "none" | "active" | "past_due" | "canceled";
  paystackCustomerCode: string | null;
  paystackSubscriptionCode: string | null;
  paystackEmailToken: string | null;
  /** The plan this account's PRO was paid on, so its renewals are recognised. */
  paystackPlanCode: string | null;
  currentPeriodEnd: Timestamp | null;
  /** When the last successful payment was made (ms since epoch). */
  lastPaymentAt: number | null;
  /** When a renewal charge failed (ms since epoch), while past due. */
  pastDueAt: number | null;
  /** When the current token window opened (ms since epoch). */
  windowStart: number | null;
  windowTokens: number;
  /** UTC date (YYYY-MM-DD) dayTokens belongs to. */
  tokenDay: string | null;
  dayTokens: number;
  compileWindowStart: number | null;
  compileWindowCount: number;
  /** UTC date (YYYY-MM-DD) compileDayCount belongs to. */
  compileDay: string | null;
  compileDayCount: number;
  /** The creator code this account came by (server/creators.ts), once taken. */
  referralCode: string | null;
  /** The free PRO trial a code gave (ms since epoch). */
  trialStartedAt: number | null;
  trialEndsAt: number | null;
  /** The Paystack reference of the discounted first month, once paid. */
  firstMonthReference: string | null;
  /** The paid plan's interval ("monthly", "annually"), from the last payment. */
  planInterval: string | null;
  /** When the paid period began: a yearly plan's allowance refills monthly from here. */
  cycleStartedAt: number | null;
  /** On a yearly plan, which of its months cycleTokensUsed counts. */
  cycleMonth: number | null;
  /** The team or school license this account is on (server/teams.ts). */
  teamId: string | null;
  /** When that license is paid until, and what it was paid for (its grace days). Read from the team, never stored here (teamLicenseFor). */
  teamPaidUntil: number | null;
  teamPaidFor: TeamPeriod | null;
  /** The calendar month (teamMonthKey) teamMonthTokens counts. */
  teamMonth: number | null;
  teamMonthTokens: number;
}

const DEFAULT_USER_DOC: UserQuotaDoc = {
  lifetimeFreeTokensUsed: 0,
  cycleTokensUsed: 0,
  subscriptionStatus: "none",
  paystackCustomerCode: null,
  paystackSubscriptionCode: null,
  paystackEmailToken: null,
  paystackPlanCode: null,
  currentPeriodEnd: null,
  lastPaymentAt: null,
  pastDueAt: null,
  windowStart: null,
  windowTokens: 0,
  tokenDay: null,
  dayTokens: 0,
  compileWindowStart: null,
  compileWindowCount: 0,
  compileDay: null,
  compileDayCount: 0,
  referralCode: null,
  trialStartedAt: null,
  trialEndsAt: null,
  firstMonthReference: null,
  planInterval: null,
  cycleStartedAt: null,
  cycleMonth: null,
  teamId: null,
  teamPaidUntil: null,
  teamPaidFor: null,
  teamMonth: null,
  teamMonthTokens: 0,
};

export function readUserDoc(data: any): UserQuotaDoc {
  data = data || {};
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const time = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    lifetimeFreeTokensUsed: num(data.lifetimeFreeTokensUsed),
    cycleTokensUsed: num(data.cycleTokensUsed),
    subscriptionStatus: data.subscriptionStatus ?? "none",
    paystackCustomerCode: data.paystackCustomerCode ?? null,
    paystackSubscriptionCode: data.paystackSubscriptionCode ?? null,
    paystackEmailToken: data.paystackEmailToken ?? null,
    paystackPlanCode: typeof data.paystackPlanCode === "string" ? data.paystackPlanCode : null,
    currentPeriodEnd: data.currentPeriodEnd ?? null,
    lastPaymentAt: time(data.lastPaymentAt),
    pastDueAt: time(data.pastDueAt),
    windowStart: time(data.windowStart),
    windowTokens: num(data.windowTokens),
    tokenDay: typeof data.tokenDay === "string" ? data.tokenDay : null,
    dayTokens: num(data.dayTokens),
    compileWindowStart: time(data.compileWindowStart),
    compileWindowCount: num(data.compileWindowCount),
    compileDay: typeof data.compileDay === "string" ? data.compileDay : null,
    compileDayCount: num(data.compileDayCount),
    referralCode: typeof data.referralCode === "string" ? data.referralCode : null,
    trialStartedAt: time(data.trialStartedAt),
    trialEndsAt: time(data.trialEndsAt),
    firstMonthReference: typeof data.firstMonthReference === "string" ? data.firstMonthReference : null,
    planInterval: typeof data.planInterval === "string" ? data.planInterval : null,
    cycleStartedAt: time(data.cycleStartedAt),
    cycleMonth: typeof data.cycleMonth === "number" && Number.isFinite(data.cycleMonth) ? data.cycleMonth : null,
    teamId: typeof data.teamId === "string" && data.teamId ? data.teamId : null,
    teamPaidUntil: null,
    teamPaidFor: null,
    teamMonth: typeof data.teamMonth === "number" && Number.isFinite(data.teamMonth) ? data.teamMonth : null,
    teamMonthTokens: num(data.teamMonthTokens),
  };
}

// A team's paid-until date, kept a minute so a member's every request
// doesn't read the team too. server/teams.ts forgets a team when it changes.
const TEAM_CACHE_MS = 60_000;
const teamCache = new Map<string, { at: number; paidUntil: number | null; paidFor: TeamPeriod | null }>();

/** When a team's license is paid until (teams/{id}), or null, and what it was paid for last. */
export async function teamLicenseFor(teamId: string, now = Date.now()): Promise<{ paidUntil: number | null; paidFor: TeamPeriod | null }> {
  const hit = teamCache.get(teamId);
  if (hit && now - hit.at < TEAM_CACHE_MS) return { paidUntil: hit.paidUntil, paidFor: hit.paidFor };
  const snap = await adminDb.collection("teams").doc(teamId).get();
  const v = snap.exists ? snap.get("paidUntil") : null;
  const f = snap.exists ? snap.get("paidFor") : null;
  const paidUntil = typeof v === "number" && Number.isFinite(v) ? v : null;
  const paidFor = isPeriod(f) ? f : null;
  teamCache.set(teamId, { at: now, paidUntil, paidFor });
  return { paidUntil, paidFor };
}

export function forgetTeam(teamId: string): void {
  teamCache.delete(teamId);
}

/** The account with its team's paid-until date (and what it was paid for) filled in. */
export async function withTeam(doc: UserQuotaDoc): Promise<UserQuotaDoc> {
  if (!doc.teamId) return doc;
  const license = await teamLicenseFor(doc.teamId);
  return { ...doc, teamPaidUntil: license.paidUntil, teamPaidFor: license.paidFor };
}

export async function getOrCreateUserDoc(uid: string): Promise<UserQuotaDoc> {
  const ref = adminDb.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const now = FieldValue.serverTimestamp();
    const { teamPaidUntil: _notStored, teamPaidFor: _notStoredEither, ...fields } = DEFAULT_USER_DOC;
    await ref.set({ ...fields, createdAt: now, updatedAt: now });
    return { ...DEFAULT_USER_DOC };
  }
  return withTeam(readUserDoc(snap.data()));
}

type Identity = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** Signed in with an email and password whose address isn't confirmed yet. */
  unverifiedPassword: boolean;
};

/** Who a checked sign-in token belongs to. */
export function identityFromToken(decoded: { uid: string; email?: string; email_verified?: boolean; firebase?: { sign_in_provider?: string } }): Identity {
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    // Never trust the address without this — see server/access.ts.
    emailVerified: decoded.email_verified === true,
    unverifiedPassword: decoded.firebase?.sign_in_provider === "password" && decoded.email_verified !== true,
  };
}

async function verifyBearerToken(req: Request): Promise<Identity | null> {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return null;
  try {
    return identityFromToken(await adminAuth.verifyIdToken(idToken));
  } catch {
    return null;
  }
}

/**
 * Whether a request carries a valid sign-in, without answering it. Used to
 * decide whether a large request body is worth reading at all; the route's
 * own middleware still does the real check.
 */
export async function hasValidSignIn(req: Request): Promise<boolean> {
  if (!isFirebaseAdminConfigured()) return false;
  return (await verifyBearerToken(req)) !== null;
}

export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

/**
 * An email-and-password account is used once its address is confirmed, with
 * the launch lock on or off: the sign-up sends the link, and the app shows
 * "Verify your email address" until it's opened (src/main.tsx). Google
 * accounts come verified.
 */
export function verifiedEmailCheck(who: Identity, res: Response): boolean {
  if (!who.unverifiedPassword) return true;
  res.status(403).json({
    error: "Verify your email address first: open the link we emailed you, then try again.",
    code: EMAIL_NOT_VERIFIED_CODE,
  });
  return false;
}

/** Refuses everyone without a grant while the launch lock is on. */
function launchLockCheck(who: Identity, res: Response): boolean {
  if (!loadAdminConfig().launchLocked) return true;
  if (bypassesLaunchLock(accessLevelFor(who.email, who.emailVerified))) return true;
  res.status(403).json({ error: LAUNCH_LOCKED_MESSAGE, code: LAUNCH_LOCKED_CODE });
  return false;
}

// Auth only, no quota check — for routes a blocked user must still reach
// (checking their own status, completing a payment).
export async function requireFirebaseAuth(req: Request, res: Response, next: NextFunction) {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: "Sign-in is not configured on the server yet.", code: "AUTH_NOT_CONFIGURED" });
  }
  const who = await verifyBearerToken(req);
  if (!who) {
    return res.status(401).json({ error: "Sign in required.", code: "AUTH_REQUIRED" });
  }
  if (!verifiedEmailCheck(who, res)) return;
  if (!launchLockCheck(who, res)) return;
  req.uid = who.uid;
  req.email = who.email;
  req.emailVerified = who.emailVerified;
  noteActive(who.uid);
  next();
}

/**
 * Sign-in only, without the pre-launch lock: for the pages around the product
 * rather than the product itself (a creator's own page), which people need
 * before launch too.
 */
export async function requireSignedIn(req: Request, res: Response, next: NextFunction) {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: "Sign-in is not configured on the server yet.", code: "AUTH_NOT_CONFIGURED" });
  }
  const who = await verifyBearerToken(req);
  if (!who) {
    return res.status(401).json({ error: "Sign in required.", code: "AUTH_REQUIRED" });
  }
  req.uid = who.uid;
  req.email = who.email;
  req.emailVerified = who.emailVerified;
  next();
}

/** The subscription side of an account, for server/billing.ts. */
export function billingOf(doc: UserQuotaDoc): BillingState {
  const end = doc.currentPeriodEnd && typeof (doc.currentPeriodEnd as any).toMillis === "function"
    ? (doc.currentPeriodEnd as any).toMillis() as number
    : null;
  return { subscriptionStatus: doc.subscriptionStatus, currentPeriodEnd: end, lastPaymentAt: doc.lastPaymentAt ?? null, pastDueAt: doc.pastDueAt ?? null };
}

/** When a subscription renews, or when a cancelled or unpaid one's PRO ends. */
export function subscriptionStanding(doc: UserQuotaDoc, now = Date.now()) {
  return standing(billingOf(doc), now);
}

/**
 * Where an account stands: the owner, paid or granted PRO, or free. Paid PRO
 * includes a cancelled subscription until its paid period ends, and a failed
 * renewal until its grace period ends (server/billing.ts). A creator code's
 * trial is PRO until it ends, metered like granted PRO: the 5-hour window,
 * no monthly cap. A team license's member has PRO while it is paid, and for
 * its grace days after (server/teamRules.ts).
 */
export function tierOf(doc: UserQuotaDoc, level: string, now = Date.now()): Tier {
  if (level === "unmetered") return "unmetered";
  if (hasPaidPro(billingOf(doc), now) || level === "pro" || isOnTrial(doc, now) || onTeamPro(doc, now)) return "pro";
  return "free";
}

/** Whether the account has PRO through a team license. */
export function onTeamPro(doc: Pick<UserQuotaDoc, "teamId" | "teamPaidUntil" | "teamPaidFor">, now: number): boolean {
  return !!doc.teamId && teamGivesPro(doc.teamPaidUntil, now, doc.teamPaidFor);
}

export function utcDay(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The window in force at `now`: the stored one while it lasts, else none. */
function liveWindow(start: number | null, used: number, now: number): { start: number | null; used: number } {
  if (start !== null && now >= start && now < start + WINDOW_MS) return { start, used };
  return { start: null, used: 0 };
}

/** Of several pauses, the one that lifts last governs; null (unknown) is last. */
function latest(blockers: Array<{ reason: PauseReason; at: number | null }>) {
  let pick = blockers[0];
  for (const b of blockers) {
    if (pick.at === null) break;
    if (b.at === null || b.at > pick.at) pick = b;
  }
  return pick;
}

export type PauseReason = "window" | "day" | "cycle";

function addMonths(ms: number, k: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.getTime();
}

/**
 * On a yearly plan, the month of it that `now` falls in, and when the next
 * begins: the monthly allowance (PAID_TOKEN_CAP) refills every month of the
 * year, as it would on the monthly plan. Null on a monthly plan, whose
 * allowance refills with each payment.
 */
export function allowanceMonth(doc: Pick<UserQuotaDoc, "planInterval" | "cycleStartedAt">, now: number): { key: number; resetAt: number } | null {
  if (String(doc.planInterval || "").toLowerCase() !== "annually" || doc.cycleStartedAt === null) return null;
  const start = doc.cycleStartedAt;
  if (now < start) return { key: 0, resetAt: addMonths(start, 1) };
  const s = new Date(start);
  const n = new Date(now);
  let k = (n.getUTCFullYear() - s.getUTCFullYear()) * 12 + (n.getUTCMonth() - s.getUTCMonth());
  while (k > 0 && addMonths(start, k) > now) k--;
  while (addMonths(start, k + 1) <= now) k++;
  return { key: k, resetAt: addMonths(start, k + 1) };
}

/** What counts against the paid allowance now: nothing yet in a new month of a yearly plan. */
function cycleUsedNow(doc: UserQuotaDoc, now: number): number {
  const month = allowanceMonth(doc, now);
  if (month && doc.cycleMonth !== month.key) return 0;
  return doc.cycleTokensUsed;
}

export interface Allowance {
  blocked: boolean;
  reason: PauseReason | null;
  /** When the pause lifts (ms since epoch). Null when not paused, or when it
   *  lifts on a billing date the server has not been told. */
  resetAt: number | null;
  windowUsed: number;
  windowCap: number;
  /** When the current window refills; null before it has opened. */
  windowResetAt: number | null;
  dayUsed: number | null;
  dayCap: number | null;
  cycleUsed: number | null;
  cycleCap: number | null;
}

/** How much an account may still use, and if nothing, until when. */
export function allowanceFor(doc: UserQuotaDoc, tier: Tier, now = Date.now()): Allowance {
  if (tier === "unmetered") {
    return {
      blocked: false, reason: null, resetAt: null,
      windowUsed: 0, windowCap: 0, windowResetAt: null,
      dayUsed: null, dayCap: null, cycleUsed: null, cycleCap: null,
    };
  }
  const win = liveWindow(doc.windowStart, doc.windowTokens, now);
  const windowCap = tier === "free" ? FREE_WINDOW_TOKENS : PRO_WINDOW_TOKENS;
  const windowResetAt = win.start === null ? null : win.start + WINDOW_MS;
  const blockers: Array<{ reason: PauseReason; at: number | null }> = [];
  if (win.used >= windowCap) blockers.push({ reason: "window", at: windowResetAt });

  let dayUsed: number | null = null;
  let dayCap: number | null = null;
  let cycleUsed: number | null = null;
  let cycleCap: number | null = null;
  if (tier === "free") {
    dayUsed = doc.tokenDay === utcDay(now) ? doc.dayTokens : 0;
    dayCap = FREE_DAILY_TOKENS;
    if (dayUsed >= dayCap) blockers.push({ reason: "day", at: nextUtcMidnight(now) });
  } else if (hasPaidPro(billingOf(doc), now)) {
    cycleUsed = cycleUsedNow(doc, now);
    cycleCap = PAID_TOKEN_CAP;
    if (cycleUsed >= cycleCap) {
      const month = allowanceMonth(doc, now);
      const end = doc.currentPeriodEnd && typeof (doc.currentPeriodEnd as any).toMillis === "function"
        ? (doc.currentPeriodEnd as any).toMillis() as number
        : null;
      // A yearly plan refills at its next month. Otherwise a billing date
      // already passed means the renewal has not landed yet: when it does is
      // not something the server can promise.
      blockers.push({ reason: "cycle", at: month ? month.resetAt : end !== null && end > now ? end : null });
    }
  } else if (onTeamPro(doc, now)) {
    cycleUsed = doc.teamMonth === teamMonthKey(now) ? doc.teamMonthTokens : 0;
    cycleCap = PAID_TOKEN_CAP;
    if (cycleUsed >= cycleCap) blockers.push({ reason: "cycle", at: nextTeamMonthStart(now) });
  }

  const governing = blockers.length ? latest(blockers) : null;
  return {
    blocked: governing !== null,
    reason: governing ? governing.reason : null,
    resetAt: governing ? governing.at : null,
    windowUsed: win.used,
    windowCap,
    windowResetAt,
    dayUsed,
    dayCap,
    cycleUsed,
    cycleCap,
  };
}

/** "3 days 4 h", "2 h 13 min", "13 min", "less than a minute". */
export function formatWait(resetAt: number | null, now = Date.now()): string {
  if (resetAt === null) return "your next billing date";
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes <= 1) return "less than a minute";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  // Past a day, minutes are noise: "3 days 4 h" reads better than "76 h 12 min".
  if (d) return `${d} day${d === 1 ? "" : "s"}${h ? ` ${h} h` : ""}`;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function pauseMessage(tier: Tier, a: Allowance, now = Date.now()): string {
  if (a.reason === "cycle") {
    return a.resetAt === null
      ? "You've used this month's AI tokens. They refresh on your next billing date."
      : `You've used this month's AI tokens. They refresh in ${formatWait(a.resetAt, now)}.`;
  }
  const when = formatWait(a.resetAt, now);
  if (tier === "free") {
    const more = `${PRO_WINDOW_TOKENS / FREE_WINDOW_TOKENS}x`;
    return a.reason === "day"
      ? `You've used today's free AI tokens. They refill in ${when}. Get PRO for ${more} more every 5 hours.`
      : `You've used your free AI tokens for now. They refill in ${when}. Get PRO for ${more} more every 5 hours.`;
  }
  return `You've used this 5-hour window's AI tokens. They refill in ${when}.`;
}

/**
 * A PRO Smart Flash auto-debug run that began inside the allowance finishes
 * its rounds even if the allowance runs out partway: stopping between an AI
 * fix and its recompile leaves the user with neither. The app names the run
 * on each /api/ai/debug call; its first round must be admitted normally, and
 * one run per account is remembered, so the overshoot is bounded to the
 * rounds left in that one run. In-memory, like the rate limiter above.
 */
export const AUTO_DEBUG_ROUNDS = 5;
const AUTO_DEBUG_RUN_MS = 15 * 60 * 1000;
const autoDebugRuns = new Map<string, { runId: string; left: number; expires: number }>();

function autoDebugRunOf(req: Request): string | null {
  if (!(req.originalUrl || "").split("?")[0].endsWith("/api/ai/debug")) return null;
  const id = req.body?.autoDebugRun;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

/** An admitted round: starts the run, or counts a round of the one in progress. */
export function noteAutoDebugRound(uid: string, runId: string, now = Date.now()): void {
  const run = autoDebugRuns.get(uid);
  if (run && run.runId === runId && now < run.expires) {
    run.left = Math.max(0, run.left - 1);
    return;
  }
  autoDebugRuns.set(uid, { runId, left: AUTO_DEBUG_ROUNDS - 1, expires: now + AUTO_DEBUG_RUN_MS });
}

/** Whether a paused account's round belongs to a run that started in time, and has rounds left. */
export function continueAutoDebugRun(uid: string, runId: string, now = Date.now()): boolean {
  const run = autoDebugRuns.get(uid);
  if (!run || run.runId !== runId || now >= run.expires || run.left <= 0) return false;
  run.left -= 1;
  return true;
}

// Auth + token-allowance enforcement — for every route that calls a model.
export async function requireAuthAndQuota(req: Request, res: Response, next: NextFunction) {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: "Sign-in is not configured on the server yet.", code: "AUTH_NOT_CONFIGURED" });
  }
  const who = await verifyBearerToken(req);
  if (!who) {
    return res.status(401).json({ error: "Sign in required.", code: "AUTH_REQUIRED" });
  }
  if (!verifiedEmailCheck(who, res)) return;
  if (!launchLockCheck(who, res)) return;
  const uid = who.uid;

  // Cheap, in-memory — checked before the Firestore read below so an
  // abusive burst doesn't cost a Firestore read per request either.
  if (isRateLimited(uid)) {
    return res.status(429).json({ error: "Too many requests — please slow down.", code: "RATE_LIMITED" });
  }

  const level = accessLevelFor(who.email, who.emailVerified);
  noteActive(uid);

  // The owner is never metered. The unmetered tier flows through to
  // incrementTokenUsage via req.quota, which short-circuits on it, so no call
  // site needs to know about the exemption.
  if (level === "unmetered") {
    req.uid = uid;
    req.email = who.email;
    req.emailVerified = who.emailVerified;
    req.quota = { tier: "unmetered", subscriptionStatus: UNMETERED_STATUS, tokensUsed: 0, tokenCap: Number.MAX_SAFE_INTEGER };
    return next();
  }

  const doc = await getOrCreateUserDoc(uid);
  const tier = tierOf(doc, level);
  const now = Date.now();
  const a = allowanceFor(doc, tier, now);
  // Auto-debug is PRO's; a free account naming a run is ignored.
  const autoDebugRun = tier === "pro" ? autoDebugRunOf(req) : null;

  // Paused, not refused for good: the response says when it lifts, so the
  // app can count down to it.
  if (a.blocked && !(autoDebugRun && continueAutoDebugRun(uid, autoDebugRun, now))) {
    const used = a.reason === "cycle" ? a.cycleUsed : a.reason === "day" ? a.dayUsed : a.windowUsed;
    const cap = a.reason === "cycle" ? a.cycleCap : a.reason === "day" ? a.dayCap : a.windowCap;
    return res.status(402).json({
      error: pauseMessage(tier, a, now),
      code: "TOKEN_CAP_REACHED",
      tier: tier === "free" ? "free" : "paid",
      reason: a.reason,
      resetAt: a.resetAt,
      tokensUsed: used ?? 0,
      tokenCap: cap ?? 0,
    });
  }

  if (autoDebugRun && !a.blocked) noteAutoDebugRound(uid, autoDebugRun, now);

  req.uid = uid;
  req.email = who.email;
  req.emailVerified = who.emailVerified;
  req.quota = { tier, subscriptionStatus: doc.subscriptionStatus, tokensUsed: a.windowUsed, tokenCap: a.windowCap };
  next();
}

/**
 * The counters after `tokens` more are written. A window opens with the first
 * counted reply after the last one closed. Applied inside a transaction, so
 * reading and adding cannot interleave with another request's.
 */
export function tokenUsagePatch(doc: UserQuotaDoc, quota: Pick<QuotaContext, "tier" | "subscriptionStatus">, tokens: number, now: number): Partial<UserQuotaDoc> {
  const win = liveWindow(doc.windowStart, doc.windowTokens, now);
  const patch: Partial<UserQuotaDoc> = { windowStart: win.start ?? now, windowTokens: win.used + tokens };
  if (quota.tier === "free") {
    const today = utcDay(now);
    patch.tokenDay = today;
    patch.dayTokens = (doc.tokenDay === today ? doc.dayTokens : 0) + tokens;
    patch.lifetimeFreeTokensUsed = doc.lifetimeFreeTokensUsed + tokens;
  } else if (quota.subscriptionStatus === "active" || hasPaidPro(billingOf(doc), now)) {
    const month = allowanceMonth(doc, now);
    patch.cycleTokensUsed = cycleUsedNow(doc, now) + tokens;
    if (month) patch.cycleMonth = month.key;
  } else if (onTeamPro(doc, now)) {
    const key = teamMonthKey(now);
    patch.teamMonth = key;
    patch.teamMonthTokens = (doc.teamMonth === key ? doc.teamMonthTokens : 0) + tokens;
  }
  return patch;
}

// Call after a successful model response, before responding. Awaited by the
// caller so the counters are durably updated before the client could fire a
// follow-up request.
export async function incrementTokenUsage(uid: string, quota: QuotaContext | undefined, tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  if (!quota || quota.tier === "unmetered") return;
  const ref = adminDb.collection("users").doc(uid);
  try {
    await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const doc = await withTeam(readUserDoc(snap.exists ? snap.data() : {}));
      tx.set(ref, { ...tokenUsagePatch(doc, quota, tokens, Date.now()), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (err) {
    console.error(`[Quota] Failed to count ${tokens} tokens for uid=${uid}:`, err);
  }
}

export interface CompileAllowance {
  blocked: boolean;
  /** Which limit is holding: this window's compiles, or today's. */
  reason: "window" | "day" | null;
  /** Compiles left before the next pause. */
  left: number;
  resetAt: number | null;
}

/** A free account's compiles: FREE_WINDOW_COMPILES a window, FREE_DAILY_COMPILES a day. */
export function compileAllowance(doc: UserQuotaDoc, now = Date.now()): CompileAllowance {
  const win = liveWindow(doc.compileWindowStart, doc.compileWindowCount, now);
  const dayCount = doc.compileDay === utcDay(now) ? doc.compileDayCount : 0;
  const blockers: Array<{ reason: PauseReason; at: number | null }> = [];
  if (win.used >= FREE_WINDOW_COMPILES) blockers.push({ reason: "window", at: (win.start as number) + WINDOW_MS });
  if (dayCount >= FREE_DAILY_COMPILES) blockers.push({ reason: "day", at: nextUtcMidnight(now) });
  const governing = blockers.length ? latest(blockers) : null;
  return {
    blocked: governing !== null,
    reason: governing ? (governing.reason as "window" | "day") : null,
    left: Math.max(0, Math.min(FREE_WINDOW_COMPILES - win.used, FREE_DAILY_COMPILES - dayCount)),
    resetAt: governing ? governing.at : null,
  };
}

/** Which window and day a compile was counted in, so it can be handed back. */
export interface CompileReceipt {
  windowStart: number;
  day: string;
}

export interface CompileSpend {
  allowed: boolean;
  /** When refused, which limit is holding. */
  reason: "window" | "day" | null;
  /** Compiles left after this one; null when the plan has no limit. */
  left: number | null;
  resetAt: number | null;
  patch: Partial<UserQuotaDoc> | null;
  receipt: CompileReceipt | null;
}

/** Take one free compile, if one is left. */
export function spendCompile(doc: UserQuotaDoc, now: number): CompileSpend {
  const allowance = compileAllowance(doc, now);
  if (allowance.blocked) return { allowed: false, reason: allowance.reason, left: 0, resetAt: allowance.resetAt, patch: null, receipt: null };
  const win = liveWindow(doc.compileWindowStart, doc.compileWindowCount, now);
  const today = utcDay(now);
  const start = win.start ?? now;
  return {
    allowed: true,
    reason: null,
    left: allowance.left - 1,
    resetAt: null,
    patch: {
      compileWindowStart: start,
      compileWindowCount: win.used + 1,
      compileDay: today,
      compileDayCount: (doc.compileDay === today ? doc.compileDayCount : 0) + 1,
    },
    receipt: { windowStart: start, day: today },
  };
}

/** Give back a failed compile — only to the window and day it was taken from. */
export function refundPatch(doc: UserQuotaDoc, receipt: CompileReceipt): Partial<UserQuotaDoc> | null {
  const patch: Partial<UserQuotaDoc> = {};
  if (doc.compileWindowStart === receipt.windowStart && doc.compileWindowCount > 0) {
    patch.compileWindowCount = doc.compileWindowCount - 1;
  }
  if (doc.compileDay === receipt.day && doc.compileDayCount > 0) {
    patch.compileDayCount = doc.compileDayCount - 1;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Count one of a free account's compiles; every other tier compiles without
 * limit. Transactional, so two compiles at once cannot both take the last one.
 */
export async function consumeCompile(uid: string, email: string | null, emailVerified: boolean): Promise<Omit<CompileSpend, "patch">> {
  const level = accessLevelFor(email, emailVerified);
  if (level === "unmetered") return { allowed: true, reason: null, left: null, resetAt: null, receipt: null };
  const ref = adminDb.collection("users").doc(uid);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = await withTeam(readUserDoc(snap.exists ? snap.data() : {}));
    if (tierOf(doc, level) !== "free") return { allowed: true, reason: null, left: null, resetAt: null, receipt: null };
    const { patch, ...spend } = spendCompile(doc, Date.now());
    if (patch) tx.set(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return spend;
  });
}

/** Hand back a compile that failed. */
export async function refundCompile(uid: string, receipt: CompileReceipt): Promise<void> {
  const ref = adminDb.collection("users").doc(uid);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const patch = refundPatch(readUserDoc(snap.data()), receipt);
    if (patch) tx.set(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}
