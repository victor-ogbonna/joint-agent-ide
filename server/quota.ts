import type { Request, Response, NextFunction } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { loadAdminConfig } from "./adminConfig";
import { accessLevelFor, bypassesLaunchLock, LAUNCH_LOCKED_CODE, LAUNCH_LOCKED_MESSAGE } from "./access";

/** Sentinel subscription status for accounts whose usage is never counted. */
export const UNMETERED_STATUS = "unmetered";
/**
 * Sentinel subscription status for a free user whose free tokens are spent.
 * They are no longer refused: they are answered by the less capable LITE
 * model, with no auto-debug and LITE_DAILY_COMPILES compiles a day, until
 * they subscribe. Their usage is counted separately, for monitoring only.
 */
export const LITE_STATUS = "lite";
export const LITE_DAILY_COMPILES = 5;

declare global {
  namespace Express {
    interface Request {
      uid?: string;
      quota?: { subscriptionStatus: string; tokensUsed: number; tokenCap: number };
      email?: string | null;
      emailVerified?: boolean;
    }
  }
}

// Free users get this once, for life. Active subscribers get PAID_TOKEN_CAP
// fresh every billing cycle instead (reset by the Paystack webhook/verify
// handlers in server/paystack.ts on each successful charge).
export const FREE_TOKEN_CAP = 50000;
export const PAID_TOKEN_CAP = 400000;

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
  lifetimeFreeTokensUsed: number;
  cycleTokensUsed: number;
  subscriptionStatus: "none" | "active" | "past_due" | "canceled";
  paystackCustomerCode: string | null;
  paystackSubscriptionCode: string | null;
  paystackEmailToken: string | null;
  currentPeriodEnd: Timestamp | null;
  liteTokensUsed: number;
  /** UTC date (YYYY-MM-DD) the lite compile count below belongs to. */
  liteCompileDay: string | null;
  liteCompileCount: number;
}

const DEFAULT_USER_DOC: UserQuotaDoc = {
  lifetimeFreeTokensUsed: 0,
  cycleTokensUsed: 0,
  subscriptionStatus: "none",
  paystackCustomerCode: null,
  paystackSubscriptionCode: null,
  paystackEmailToken: null,
  currentPeriodEnd: null,
  liteTokensUsed: 0,
  liteCompileDay: null,
  liteCompileCount: 0,
};

export async function getOrCreateUserDoc(uid: string): Promise<UserQuotaDoc> {
  const ref = adminDb.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const now = FieldValue.serverTimestamp();
    await ref.set({ ...DEFAULT_USER_DOC, createdAt: now, updatedAt: now });
    return DEFAULT_USER_DOC;
  }
  const data = snap.data() || {};
  return {
    lifetimeFreeTokensUsed: data.lifetimeFreeTokensUsed ?? 0,
    cycleTokensUsed: data.cycleTokensUsed ?? 0,
    subscriptionStatus: data.subscriptionStatus ?? "none",
    paystackCustomerCode: data.paystackCustomerCode ?? null,
    paystackSubscriptionCode: data.paystackSubscriptionCode ?? null,
    paystackEmailToken: data.paystackEmailToken ?? null,
    currentPeriodEnd: data.currentPeriodEnd ?? null,
    liteTokensUsed: data.liteTokensUsed ?? 0,
    liteCompileDay: data.liteCompileDay ?? null,
    liteCompileCount: data.liteCompileCount ?? 0,
  };
}

type Identity = { uid: string; email: string | null; emailVerified: boolean };

async function verifyBearerToken(req: Request): Promise<Identity | null> {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      // Never trust the address without this — see server/access.ts.
      emailVerified: decoded.email_verified === true,
    };
  } catch {
    return null;
  }
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
  if (!launchLockCheck(who, res)) return;
  req.uid = who.uid;
  req.email = who.email;
  req.emailVerified = who.emailVerified;
  next();
}

export type Tier = "unmetered" | "pro" | "free" | "lite";

/** Where an account stands: paid or granted Pro, free with tokens left, or
 *  free with them spent (lite). */
export function tierOf(doc: UserQuotaDoc, level: string): Tier {
  if (level === "unmetered") return "unmetered";
  if (doc.subscriptionStatus === "active" || level === "pro") return "pro";
  return doc.lifetimeFreeTokensUsed >= FREE_TOKEN_CAP ? "lite" : "free";
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Lite compiles left today. */
export function liteCompilesLeft(doc: UserQuotaDoc, today = utcDay()): number {
  const used = doc.liteCompileDay === today ? doc.liteCompileCount : 0;
  return Math.max(0, LITE_DAILY_COMPILES - used);
}

/**
 * Spend one of a lite account's daily compiles. Every other tier compiles
 * without limit. Transactional, so two compiles at once cannot both take
 * the last one.
 */
export async function consumeCompile(uid: string, email: string | null, emailVerified: boolean): Promise<{ allowed: boolean; left: number | null }> {
  const level = accessLevelFor(email, emailVerified);
  if (level === "unmetered") return { allowed: true, left: null };
  const ref = adminDb.collection("users").doc(uid);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data: any = snap.exists ? snap.data() : {};
    const doc = { ...DEFAULT_USER_DOC, ...data } as UserQuotaDoc;
    if (tierOf(doc, level) !== "lite") return { allowed: true, left: null };
    const today = utcDay();
    const left = liteCompilesLeft(doc, today);
    if (left <= 0) return { allowed: false, left: 0 };
    const used = doc.liteCompileDay === today ? doc.liteCompileCount : 0;
    tx.set(ref, { liteCompileDay: today, liteCompileCount: used + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { allowed: true, left: left - 1 };
  });
}

// Auth + token-cap enforcement — for every route that calls Gemini.
export async function requireAuthAndQuota(req: Request, res: Response, next: NextFunction) {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: "Sign-in is not configured on the server yet.", code: "AUTH_NOT_CONFIGURED" });
  }
  const who = await verifyBearerToken(req);
  if (!who) {
    return res.status(401).json({ error: "Sign in required.", code: "AUTH_REQUIRED" });
  }
  if (!launchLockCheck(who, res)) return;
  const uid = who.uid;

  // Cheap, in-memory — checked before the Firestore read below so an
  // abusive burst doesn't cost a Firestore read per request either.
  if (isRateLimited(uid)) {
    return res.status(429).json({ error: "Too many requests — please slow down.", code: "RATE_LIMITED" });
  }

  const level = accessLevelFor(who.email, who.emailVerified);

  // The owner is never metered. UNMETERED_STATUS flows through to
  // incrementTokenUsage via req.quota, which short-circuits on it, so no call
  // site needs to know about the exemption.
  if (level === "unmetered") {
    req.uid = uid;
    req.email = who.email;
    req.quota = { subscriptionStatus: UNMETERED_STATUS, tokensUsed: 0, tokenCap: Number.MAX_SAFE_INTEGER };
    return next();
  }

  const doc = await getOrCreateUserDoc(uid);
  // A granted Pro account gets the paid cap without a Paystack subscription,
  // and is still metered — the grant raises the ceiling, it does not remove it.
  const isPaid = doc.subscriptionStatus === "active" || level === "pro";
  const tokenCap = isPaid ? PAID_TOKEN_CAP : FREE_TOKEN_CAP;
  const tokensUsed = isPaid ? doc.cycleTokensUsed : doc.lifetimeFreeTokensUsed;

  // A free user past their free tokens is not refused: the lite model
  // answers them from here on, with its own limits, until they subscribe.
  if (!isPaid && tokensUsed >= tokenCap) {
    req.uid = uid;
    req.email = who.email;
    req.emailVerified = who.emailVerified;
    req.quota = { subscriptionStatus: LITE_STATUS, tokensUsed, tokenCap };
    return next();
  }

  if (tokensUsed >= tokenCap) {
    return res.status(402).json({
      error: isPaid ? "You've used this cycle's AI tokens — they'll refresh on your next billing date." : "You've used up your free AI tokens.",
      code: "TOKEN_CAP_REACHED",
      tier: isPaid ? "paid" : "free",
      tokensUsed,
      tokenCap,
    });
  }

  req.uid = uid;
  req.email = who.email;
  req.emailVerified = who.emailVerified;
  req.quota = { subscriptionStatus: doc.subscriptionStatus, tokensUsed, tokenCap };
  next();
}

// Call after a successful Gemini response, before res.json(...). Awaited by
// the caller so the counter is durably updated before the client could fire
// a follow-up request.
export async function incrementTokenUsage(uid: string, subscriptionStatus: string, tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  if (subscriptionStatus === UNMETERED_STATUS) return;
  const field = subscriptionStatus === "active" ? "cycleTokensUsed"
    : subscriptionStatus === LITE_STATUS ? "liteTokensUsed"
    : "lifetimeFreeTokensUsed";
  try {
    await adminDb.collection("users").doc(uid).update({
      [field]: FieldValue.increment(tokens),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[Quota] Failed to increment ${field} for uid=${uid}:`, err);
  }
}
