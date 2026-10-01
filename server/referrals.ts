/**
 * Creator codes: the rules, kept free of Firebase so each one can be tested
 * on its own (test/referrals.mjs). The data and routes are server/creators.ts.
 *
 *   - A person who has never had PRO uses a creator's code, by the creator's
 *     link (?ref=CODE) or by typing it: TRIAL_DAYS of PRO, free.
 *   - Once the trial has ended, their first month of PRO is
 *     FIRST_MONTH_DISCOUNT_PCT off, if they buy it within
 *     OFFER_DAYS_AFTER_TRIAL days. After that month PRO renews at the normal
 *     price.
 *   - The creator earns their rate (a percentage, set per creator) of every
 *     PRO payment that person makes in their first COMMISSION_MONTHS, counted
 *     on what was actually paid. A free sign-up earns nothing.
 */
import { addInterval } from "./billing";

const DAY = 24 * 60 * 60 * 1000;

export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * DAY;
export const FIRST_MONTH_DISCOUNT_PCT = 20;
export const OFFER_DAYS_AFTER_TRIAL = 30;
export const COMMISSION_MONTHS = 12;
export const DEFAULT_COMMISSION_PCT = 20;
/** The Paystack metadata that marks the discounted first month's payment. */
export const FIRST_MONTH_KIND = "pro_first_month";

/** A code as stored: upper case, 3 to 24 letters, digits, "-" or "_". Null when it can't be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(code) ? code : null;
}

/** A commission rate: a whole or decimal percentage from 0 to 100. */
export function validRate(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** The parts of an account the code rules read. */
export interface ReferralState {
  referralCode: string | null;
  trialStartedAt: number | null;
  trialEndsAt: number | null;
  subscriptionStatus: string;
  lastPaymentAt: number | null;
  firstMonthReference: string | null;
}

export interface CodeOwner {
  active: boolean;
  email: string | null;
}

export interface Claimant {
  email: string | null;
  emailVerified: boolean;
  /** The account's access level (server/access.ts): "unmetered", "pro", "early" or "none". */
  level: string;
}

/** Whether an account could take a code at all (never had PRO, a trial or a code). */
export function canUseCode(user: ReferralState, level: string): boolean {
  if (level === "pro" || level === "unmetered") return false;
  if (user.referralCode) return false;
  return user.subscriptionStatus === "none" && user.lastPaymentAt === null && user.trialStartedAt === null;
}

/** Why an account can't take this code, in words for the person; null when it can. */
export function claimRefusal(user: ReferralState, code: string, owner: CodeOwner | null, who: Claimant): string | null {
  if (!owner || !owner.active) return "That code isn't valid. Check it with the person who shared it.";
  if (user.referralCode) {
    return user.referralCode === code ? "That code is already on your account." : "Your account already has a creator code.";
  }
  if (who.level === "pro" || who.level === "unmetered") return "Your account already has PRO.";
  if (!canUseCode(user, who.level)) return "Creator codes are for people new to PRO.";
  if (!who.emailVerified) return "Verify your email address first, then use the code.";
  const mine = (owner.email || "").trim().toLowerCase();
  if (mine && mine === (who.email || "").trim().toLowerCase()) return "That's your own code: share it with others.";
  return null;
}

export function isOnTrial(user: Pick<ReferralState, "trialEndsAt">, now: number): boolean {
  return user.trialEndsAt !== null && now < user.trialEndsAt;
}

/**
 * Until when the discounted first month can be bought, or null. Only for an
 * account that came by a code, whose trial has ended, and that has never paid.
 */
export function firstMonthOfferUntil(user: ReferralState, now: number): number | null {
  if (!user.referralCode || user.trialEndsAt === null) return null;
  if (user.lastPaymentAt !== null || user.subscriptionStatus !== "none" || user.firstMonthReference) return null;
  if (now < user.trialEndsAt) return null;
  const until = user.trialEndsAt + OFFER_DAYS_AFTER_TRIAL * DAY;
  return now < until ? until : null;
}

/** When the discounted first month opens: the trial's end, while it hasn't yet. */
export function firstMonthOfferOpensAt(user: ReferralState, now: number): number | null {
  if (!user.referralCode || user.trialEndsAt === null || now >= user.trialEndsAt) return null;
  if (user.lastPaymentAt !== null || user.subscriptionStatus !== "none" || user.firstMonthReference) return null;
  return user.trialEndsAt;
}

/** The first month's price, in the currency's smallest unit (kobo, cents). */
export function discountedAmount(fullAmount: number): number {
  return Math.round((fullAmount * (100 - FIRST_MONTH_DISCOUNT_PCT)) / 100);
}

/**
 * The month a discounted payment pays for: from when it was paid. (It can
 * only be bought once the trial has ended; should a payment land a moment
 * before, the month still starts at the trial's end, so no day is lost.)
 */
export function firstMonthPeriod(paidAt: number, trialEndsAt: number | null): { start: number; end: number } {
  const start = Math.max(paidAt, trialEndsAt ?? paidAt);
  return { start, end: addInterval(start, "monthly") };
}

/** A creator's share of one payment, in the smallest unit, rounded down. */
export function commissionFor(amount: number, ratePct: number): number {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(ratePct) || ratePct <= 0) return 0;
  return Math.floor((amount * ratePct) / 100);
}

/** Whether a payment falls in the COMMISSION_MONTHS after the person's first one. */
export function inCommissionWindow(firstPaidAt: number, paidAt: number): boolean {
  // Twelve months to the day: a year on the calendar.
  const end = COMMISSION_MONTHS === 12 ? addInterval(firstPaidAt, "annually") : firstPaidAt + COMMISSION_MONTHS * 30 * DAY;
  return paidAt >= firstPaidAt && paidAt < end;
}

export interface EarningLike {
  currency: string;
  commission: number;
  payoutId: string | null;
}

export interface MoneySummary {
  currency: string;
  earned: number;
  paid: number;
  owed: number;
}

/** Earned, paid and still owed, per currency, in the smallest unit. */
export function summarize(earnings: EarningLike[]): MoneySummary[] {
  const by = new Map<string, MoneySummary>();
  for (const e of earnings) {
    const cur = (e.currency || "").toUpperCase() || "NGN";
    const s = by.get(cur) ?? { currency: cur, earned: 0, paid: 0, owed: 0 };
    s.earned += e.commission;
    if (e.payoutId) s.paid += e.commission;
    else s.owed += e.commission;
    by.set(cur, s);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
