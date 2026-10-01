/**
 * Creator codes: the data and the routes. The rules are server/referrals.ts.
 *
 * Firestore, server-only (the browser can't read or write any of these):
 *   creators/{CODE}            name, email, rate, on/off, sign-ups, paying users
 *   creatorEarnings/{ref}      one per PRO payment that earns a commission,
 *                              keyed by the Paystack reference, so the same
 *                              payment reported twice (the app's check and
 *                              Paystack's webhook) is counted once
 *   creatorPayouts/{id}        each "Mark paid": what was paid, and when
 *   users/{uid}                referralCode, trialStartedAt, trialEndsAt,
 *                              firstPaidAt, firstMonthReference
 *
 * Every function takes the database as its first argument: adminDb in the
 * server, an in-memory stand-in in test/referrals.mjs.
 */
import type express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth, requireSignedIn, readUserDoc, getOrCreateUserDoc } from "./quota";
import { accessLevelFor } from "./access";
import { paymentTime } from "./billing";
import {
  normalizeCode, validRate, claimRefusal, firstMonthOfferUntil, discountedAmount, firstMonthPeriod,
  commissionFor, inCommissionWindow, summarize, TRIAL_MS, DEFAULT_COMMISSION_PCT, FIRST_MONTH_KIND,
  type Claimant, type MoneySummary,
} from "./referrals";

export const CREATORS = "creators";
export const EARNINGS = "creatorEarnings";
export const PAYOUTS = "creatorPayouts";
const USERS = "users";

/** adminDb, or a stand-in with the same calls (tests). */
type Db = any;

/** A refusal meant for the person: its message is shown as it is. */
export class CreatorError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "CreatorError";
  }
}

export interface CreatorRecord {
  code: string;
  name: string;
  email: string | null;
  ratePct: number;
  active: boolean;
  createdAt: number;
  /** Accounts that took the code (each got the trial). */
  signups: number;
  /** Of those, how many have paid for PRO. */
  payingUsers: number;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function creatorOf(code: string, d: any): CreatorRecord {
  d = d || {};
  return {
    code,
    name: typeof d.name === "string" ? d.name : code,
    email: typeof d.email === "string" && d.email ? d.email : null,
    ratePct: num(d.ratePct, DEFAULT_COMMISSION_PCT),
    active: d.active !== false,
    createdAt: num(d.createdAt),
    signups: num(d.signups),
    payingUsers: num(d.payingUsers),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new CreatorError("Give the creator a name.");
  return name;
}

function cleanEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) return null;
  if (!EMAIL_RE.test(email) || email.length > 200) throw new CreatorError("That email address doesn't look right.");
  return email;
}

function cleanRate(raw: unknown): number {
  const rate = validRate(raw);
  if (rate === null) throw new CreatorError("The rate is a percentage from 0 to 100.");
  return rate;
}

/** A new creator and their code. The code is theirs for good: it can't be renamed, only switched off. */
export async function addCreator(db: Db, input: { code?: unknown; name?: unknown; email?: unknown; ratePct?: unknown }, now: number): Promise<CreatorRecord> {
  const code = normalizeCode(input.code);
  if (!code) throw new CreatorError("A code is 3 to 24 letters or digits (with - or _ allowed), like TOBI20.");
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const ratePct = input.ratePct === undefined || input.ratePct === null || input.ratePct === "" ? DEFAULT_COMMISSION_PCT : cleanRate(input.ratePct);
  const ref = db.collection(CREATORS).doc(code);
  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new CreatorError(`The code ${code} is already taken.`, 409);
    const record: CreatorRecord = { code, name, email, ratePct, active: true, createdAt: now, signups: 0, payingUsers: 0 };
    tx.set(ref, record);
    return record;
  });
}

/** Change a creator's name, email, rate, or switch the code on or off. */
export async function updateCreator(db: Db, rawCode: unknown, patch: { name?: unknown; email?: unknown; ratePct?: unknown; active?: unknown }): Promise<CreatorRecord> {
  const code = normalizeCode(rawCode);
  if (!code) throw new CreatorError("No such creator.", 404);
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.email !== undefined) changes.email = cleanEmail(patch.email);
  if (patch.ratePct !== undefined) changes.ratePct = cleanRate(patch.ratePct);
  if (patch.active !== undefined) {
    if (typeof patch.active !== "boolean") throw new CreatorError("On or off, please.");
    changes.active = patch.active;
  }
  if (!Object.keys(changes).length) throw new CreatorError("Nothing to change.");
  const ref = db.collection(CREATORS).doc(code);
  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new CreatorError("No such creator.", 404);
    tx.set(ref, changes, { merge: true });
    return creatorOf(code, { ...snap.data(), ...changes });
  });
}

/**
 * Put a code on an account and start its free trial. The account must have
 * the default fields already (getOrCreateUserDoc), which the route sees to.
 */
export async function claimCode(db: Db, uid: string, rawCode: unknown, who: Claimant, now: number): Promise<{ code: string; trialEndsAt: number }> {
  const code = normalizeCode(rawCode);
  if (!code) throw new CreatorError("That code isn't valid. Check it with the person who shared it.");
  const userRef = db.collection(USERS).doc(uid);
  const creatorRef = db.collection(CREATORS).doc(code);
  return db.runTransaction(async (tx: any) => {
    const userSnap = await tx.get(userRef);
    const creatorSnap = await tx.get(creatorRef);
    const user = readUserDoc(userSnap.exists ? userSnap.data() : {});
    const owner = creatorSnap.exists ? creatorOf(code, creatorSnap.data()) : null;
    const refusal = claimRefusal(user, code, owner, who);
    if (refusal) throw new CreatorError(refusal);
    const trialEndsAt = now + TRIAL_MS;
    tx.set(userRef, { referralCode: code, referredAt: now, trialStartedAt: now, trialEndsAt }, { merge: true });
    tx.set(creatorRef, { signups: owner!.signups + 1 }, { merge: true });
    return { code, trialEndsAt };
  });
}

/** What a Paystack payment says about itself, or null when it can't be counted. */
export interface PaymentFacts {
  reference: string;
  /** In the currency's smallest unit (kobo, cents). */
  amount: number;
  currency: string;
  paidAt: number;
}

export function paymentFacts(data: any, now: number): PaymentFacts | null {
  const reference = typeof data?.reference === "string" && data.reference.trim() ? data.reference.trim() : null;
  const amount = Number(data?.amount);
  const currency = typeof data?.currency === "string" ? data.currency.trim().toUpperCase() : "";
  if (!reference || !Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  return { reference, amount: Math.round(amount), currency, paidAt: paymentTime(data, now) };
}

/** A Firestore document id for a payment reference ("/" is the one character an id can't hold). */
export function earningId(reference: string): string {
  return reference.replace(/\//g, "_").slice(0, 500);
}

/**
 * A creator's commission on one PRO payment, if the payer came by a code and
 * is in their first COMMISSION_MONTHS. Safe to call more than once for the
 * same payment: the reference is the record's key. Also notes the payer's
 * first payment, and counts them as a paying user of the code.
 */
export async function recordCommission(db: Db, uid: string, pay: PaymentFacts, payerEmail: string | null, now: number): Promise<{ recorded: boolean; commission: number; code: string | null }> {
  const userRef = db.collection(USERS).doc(uid);
  const earningRef = db.collection(EARNINGS).doc(earningId(pay.reference));
  return db.runTransaction(async (tx: any) => {
    const none = { recorded: false, commission: 0, code: null };
    const earningSnap = await tx.get(earningRef);
    if (earningSnap.exists) return none;
    const userSnap = await tx.get(userRef);
    const raw = userSnap.exists ? userSnap.data() || {} : {};
    const code = typeof raw.referralCode === "string" ? raw.referralCode : null;
    if (!code) return none;
    const creatorRef = db.collection(CREATORS).doc(code);
    const creatorSnap = await tx.get(creatorRef);
    if (!creatorSnap.exists) return none;
    const creator = creatorOf(code, creatorSnap.data());
    const firstTime = typeof raw.firstPaidAt !== "number";
    const firstPaidAt = firstTime ? pay.paidAt : raw.firstPaidAt;
    if (firstTime) {
      tx.set(userRef, { firstPaidAt }, { merge: true });
      tx.set(creatorRef, { payingUsers: creator.payingUsers + 1 }, { merge: true });
    }
    if (!inCommissionWindow(firstPaidAt, pay.paidAt)) return { ...none, code };
    const commission = commissionFor(pay.amount, creator.ratePct);
    tx.set(earningRef, {
      reference: pay.reference,
      code,
      uid,
      payerEmail: payerEmail || null,
      amount: pay.amount,
      currency: pay.currency,
      ratePct: creator.ratePct,
      commission,
      paidAt: pay.paidAt,
      createdAt: now,
      payoutId: null,
    });
    return { recorded: true, commission, code };
  });
}

export interface PlanPrice {
  code: string;
  /** In the currency's smallest unit. */
  amount: number;
  currency: string;
}

export interface FirstMonthDeps {
  /** The PRO plan as Paystack has it: the discount is worked out from its price. */
  plan: PlanPrice;
  /** Starts the normal PRO subscription on the saved card, from a future date. True when Paystack agreed. */
  startSubscription: (args: { customer: string; authorization: string; startDate: number }) => Promise<boolean>;
}

export interface FirstMonthResult {
  applied: boolean;
  /** Already applied for this payment (the app's check and the webhook both report it). */
  already: boolean;
  /** Whether PRO will renew by itself after the month (a card could be saved). */
  renews: boolean;
  proUntil: number | null;
}

/**
 * The discounted first month: a one-off payment, not a subscription, since a
 * Paystack plan always charges its own full price. Checked against the PRO
 * plan's price and currency, and against the account's offer. It gives PRO
 * for a month (from the trial's end, if paid during it) and then, paid by a
 * card that can be charged again, starts the normal subscription on that card
 * from the month's end. Otherwise PRO just ends with the month, and renewing
 * is a normal payment from the Plans page.
 */
export async function applyFirstMonthPayment(db: Db, uid: string, data: any, deps: FirstMonthDeps, now: number): Promise<FirstMonthResult> {
  const pay = paymentFacts(data, now);
  if (!pay) throw new CreatorError("The payment's details are missing.");
  if (data?.metadata?.uid !== uid) throw new CreatorError("This payment doesn't belong to the signed-in account.", 403);
  if (data?.metadata?.kind !== FIRST_MONTH_KIND) throw new CreatorError("This isn't a first-month payment.");
  if (pay.currency !== deps.plan.currency.toUpperCase()) throw new CreatorError("The payment was in the wrong currency.", 402);
  if (pay.amount < discountedAmount(deps.plan.amount)) throw new CreatorError("The payment was less than the first month's price.", 402);

  const userRef = db.collection(USERS).doc(uid);
  const customer = typeof data?.customer?.customer_code === "string" && data.customer.customer_code
    ? data.customer.customer_code
    : typeof data?.customer?.email === "string" ? data.customer.email : "";
  const won = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(userRef);
    const user = readUserDoc(snap.exists ? snap.data() : {});
    if (user.firstMonthReference === pay.reference) {
      return { already: true, end: user.currentPeriodEnd && typeof (user.currentPeriodEnd as any).toMillis === "function" ? (user.currentPeriodEnd as any).toMillis() : null };
    }
    if (firstMonthOfferUntil(user, pay.paidAt) === null) {
      throw new CreatorError("This account doesn't have the first-month offer. Contact us for a refund.", 409);
    }
    const period = firstMonthPeriod(pay.paidAt, user.trialEndsAt);
    tx.set(userRef, {
      // Not renewing until a subscription is in place (below).
      subscriptionStatus: "canceled",
      paystackPlanCode: deps.plan.code,
      cycleTokensUsed: 0,
      lastPaymentAt: pay.paidAt,
      currentPeriodEnd: Timestamp.fromMillis(period.end),
      pastDueAt: null,
      firstMonthReference: pay.reference,
      ...(typeof data?.customer?.customer_code === "string" && data.customer.customer_code ? { paystackCustomerCode: data.customer.customer_code } : {}),
    }, { merge: true });
    return { already: false, end: period.end };
  });
  if (won.already) return { applied: false, already: true, renews: false, proUntil: won.end };

  let renews = false;
  const auth = data?.authorization;
  if (customer && auth?.reusable === true && typeof auth.authorization_code === "string" && auth.authorization_code) {
    try {
      renews = await deps.startSubscription({ customer, authorization: auth.authorization_code, startDate: won.end });
    } catch (err: any) {
      console.error(`[Creators] Could not start the subscription after uid=${uid}'s first month:`, err?.message || err);
    }
    if (renews) await userRef.set({ subscriptionStatus: "active" }, { merge: true });
  }
  return { applied: true, already: false, renews, proUntil: won.end };
}

/** One earning as the admin page shows it. */
export interface EarningRow {
  reference: string;
  code: string;
  payerEmail: string | null;
  amount: number;
  currency: string;
  ratePct: number;
  commission: number;
  paidAt: number;
  payoutId: string | null;
}

function earningOf(d: any): EarningRow {
  return {
    reference: String(d?.reference ?? ""),
    code: String(d?.code ?? ""),
    payerEmail: typeof d?.payerEmail === "string" ? d.payerEmail : null,
    amount: num(d?.amount),
    currency: typeof d?.currency === "string" ? d.currency : "",
    ratePct: num(d?.ratePct),
    commission: num(d?.commission),
    paidAt: num(d?.paidAt),
    payoutId: typeof d?.payoutId === "string" && d.payoutId ? d.payoutId : null,
  };
}

export interface PayoutRow {
  id: string;
  code: string;
  totals: { currency: string; amount: number }[];
  count: number;
  paidAt: number;
  note: string | null;
}

function payoutOf(id: string, d: any): PayoutRow {
  return {
    id,
    code: String(d?.code ?? ""),
    totals: Array.isArray(d?.totals) ? d.totals.map((t: any) => ({ currency: String(t?.currency ?? ""), amount: num(t?.amount) })) : [],
    count: num(d?.count),
    paidAt: num(d?.paidAt),
    note: typeof d?.note === "string" && d.note ? d.note : null,
  };
}

/** Most earnings marked paid in one go (a Firestore transaction writes at most 500 documents). */
export const PAYOUT_BATCH = 400;

/** Everything owed to a creator, marked paid now (after you've sent the money). */
export async function markPaid(db: Db, rawCode: unknown, now: number, note?: unknown): Promise<PayoutRow & { left: number }> {
  const code = normalizeCode(rawCode);
  if (!code) throw new CreatorError("No such creator.", 404);
  const creatorRef = db.collection(CREATORS).doc(code);
  const query = db.collection(EARNINGS).where("code", "==", code);
  return db.runTransaction(async (tx: any) => {
    const creatorSnap = await tx.get(creatorRef);
    if (!creatorSnap.exists) throw new CreatorError("No such creator.", 404);
    const found = await tx.get(query);
    const unpaid = found.docs
      .map((d: any) => ({ ref: d.ref, row: earningOf(d.data()) }))
      .filter((e: any) => !e.row.payoutId)
      .sort((a: any, b: any) => a.row.paidAt - b.row.paidAt);
    if (!unpaid.length) throw new CreatorError("Nothing is owed to this creator right now.");
    const batch = unpaid.slice(0, PAYOUT_BATCH);
    const totals = summarize(batch.map((e: any) => e.row)).map((s: MoneySummary) => ({ currency: s.currency, amount: s.owed }));
    const payoutRef = db.collection(PAYOUTS).doc();
    const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
    tx.set(payoutRef, { code, totals, count: batch.length, paidAt: now, note: cleanNote });
    for (const e of batch) tx.set(e.ref, { payoutId: payoutRef.id }, { merge: true });
    return { id: payoutRef.id, code, totals, count: batch.length, paidAt: now, note: cleanNote, left: unpaid.length - batch.length };
  });
}

export interface CreatorSummary extends CreatorRecord {
  money: MoneySummary[];
}

/** Every creator, newest first, with what they've earned, been paid and are owed. */
export async function listCreators(db: Db): Promise<CreatorSummary[]> {
  const [creatorsSnap, earningsSnap] = await Promise.all([db.collection(CREATORS).get(), db.collection(EARNINGS).get()]);
  const byCode = new Map<string, EarningRow[]>();
  for (const d of earningsSnap.docs) {
    const e = earningOf(d.data());
    const list = byCode.get(e.code) ?? [];
    list.push(e);
    byCode.set(e.code, list);
  }
  return creatorsSnap.docs
    .map((d: any) => {
      const c = creatorOf(d.id, d.data());
      return { ...c, money: summarize(byCode.get(c.code) ?? []) };
    })
    .sort((a: CreatorSummary, b: CreatorSummary) => b.createdAt - a.createdAt);
}

/** One creator's earnings and payouts, newest first. */
export async function creatorDetail(db: Db, rawCode: unknown): Promise<{ earnings: EarningRow[]; payouts: PayoutRow[] }> {
  const code = normalizeCode(rawCode);
  if (!code) throw new CreatorError("No such creator.", 404);
  const [e, p] = await Promise.all([
    db.collection(EARNINGS).where("code", "==", code).get(),
    db.collection(PAYOUTS).where("code", "==", code).get(),
  ]);
  return {
    earnings: e.docs.map((d: any) => earningOf(d.data())).sort((a: EarningRow, b: EarningRow) => b.paidAt - a.paidAt),
    payouts: p.docs.map((d: any) => payoutOf(d.id, d.data())).sort((a: PayoutRow, b: PayoutRow) => b.paidAt - a.paidAt),
  };
}

/** What a creator sees about their own code: no one's name, email or account. */
export interface CreatorView {
  code: string;
  name: string;
  ratePct: number;
  active: boolean;
  signups: number;
  payingUsers: number;
  money: MoneySummary[];
  earnings: { amount: number; currency: string; commission: number; paidAt: number; paid: boolean }[];
  payouts: { totals: { currency: string; amount: number }[]; paidAt: number }[];
}

/** The codes belonging to a (verified) email address. */
export async function creatorsForEmail(db: Db, email: string): Promise<CreatorView[]> {
  const mine = String(email || "").trim().toLowerCase();
  if (!mine) return [];
  const snap = await db.collection(CREATORS).where("email", "==", mine).get();
  const out: CreatorView[] = [];
  for (const d of snap.docs) {
    const c = creatorOf(d.id, d.data());
    const { earnings, payouts } = await creatorDetail(db, c.code);
    out.push({
      code: c.code,
      name: c.name,
      ratePct: c.ratePct,
      active: c.active,
      signups: c.signups,
      payingUsers: c.payingUsers,
      money: summarize(earnings),
      earnings: earnings.slice(0, 200).map((e) => ({ amount: e.amount, currency: e.currency, commission: e.commission, paidAt: e.paidAt, paid: !!e.payoutId })),
      payouts: payouts.map((p) => ({ totals: p.totals, paidAt: p.paidAt })),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

// Taking a code is cheap to try, so it's limited per account.
const claimTries = new Map<string, { count: number; start: number }>();
const CLAIM_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_MAX = 10;

function tooManyClaims(uid: string, now: number): boolean {
  const e = claimTries.get(uid);
  if (!e || now - e.start > CLAIM_WINDOW_MS) {
    claimTries.set(uid, { count: 1, start: now });
    return false;
  }
  e.count += 1;
  return e.count > CLAIM_MAX;
}

function sendError(res: express.Response, err: unknown, what: string) {
  if (err instanceof CreatorError) return res.status(err.status).json({ error: err.message });
  console.error(`[Creators] ${what} failed:`, (err as any)?.message || err);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

export function registerCreatorRoutes(app: express.Express, requireAdmin: express.RequestHandler) {
  const ready = (res: express.Response) => {
    if (isFirebaseAdminConfigured()) return true;
    res.status(503).json({ error: "Accounts aren't configured on the server yet." });
    return false;
  };

  // ---- People ----

  // Put a creator's code on the signed-in account: the app sends it after a
  // visit by the creator's link, or when it's typed on the Plans page.
  app.post("/api/referral/claim", requireFirebaseAuth, async (req, res) => {
    if (!ready(res)) return;
    const now = Date.now();
    if (tooManyClaims(req.uid!, now)) return res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    try {
      await getOrCreateUserDoc(req.uid!);
      const who: Claimant = {
        email: req.email ?? null,
        emailVerified: req.emailVerified === true,
        level: accessLevelFor(req.email ?? null, req.emailVerified === true),
      };
      const result = await claimCode(adminDb, req.uid!, req.body?.code, who, now);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, "Taking a code");
    }
  });

  // A creator's own page: their codes, by their verified email address. Not
  // held by the pre-launch lock: creators promote before launch.
  app.get("/api/creator/me", requireSignedIn, async (req, res) => {
    if (!ready(res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (!req.emailVerified || !req.email) return res.json({ creators: [], verified: false });
    try {
      res.json({ creators: await creatorsForEmail(adminDb, req.email), verified: true });
    } catch (err) {
      sendError(res, err, "Loading a creator's page");
    }
  });

  // ---- Admin ----

  app.get("/api/admin/creators", requireAdmin, async (_req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ creators: await listCreators(adminDb), defaultRatePct: DEFAULT_COMMISSION_PCT });
    } catch (err) {
      sendError(res, err, "Listing creators");
    }
  });

  app.post("/api/admin/creators", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ creator: await addCreator(adminDb, req.body || {}, Date.now()) });
    } catch (err) {
      sendError(res, err, "Adding a creator");
    }
  });

  app.post("/api/admin/creators/:code", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ creator: await updateCreator(adminDb, req.params.code, req.body || {}) });
    } catch (err) {
      sendError(res, err, "Changing a creator");
    }
  });

  app.post("/api/admin/creators/:code/payout", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ payout: await markPaid(adminDb, req.params.code, Date.now(), req.body?.note) });
    } catch (err) {
      sendError(res, err, "Marking a payout");
    }
  });

  app.get("/api/admin/creators/:code/earnings", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json(await creatorDetail(adminDb, req.params.code));
    } catch (err) {
      sendError(res, err, "Loading a creator's earnings");
    }
  });
}
