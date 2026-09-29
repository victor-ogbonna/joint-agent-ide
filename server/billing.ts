/**
 * How long a paying account keeps PRO, like Claude's plans:
 *   - active: renewing; Paystack charges the saved card every period.
 *   - canceled: no further charges, but PRO lasts until the paid period ends.
 *   - past_due: a renewal charge failed; PRO carries on for GRACE_DAYS after
 *     the failure (never less than the period already paid for), so there
 *     is time to pay again before dropping to Free.
 * Kept free of Firebase so every rule here can be tested on its own.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const GRACE_DAYS = 3;
export const GRACE_MS = GRACE_DAYS * DAY;

export interface BillingState {
  subscriptionStatus: string;
  /** When the period paid for ends (ms), if known. */
  currentPeriodEnd: number | null;
  /** When the last successful payment was made (ms). */
  lastPaymentAt: number | null;
  /** When the renewal charge failed (ms), while past due. */
  pastDueAt: number | null;
}

/** A billing period after `ms`, by the plan's interval (monthly unless it says otherwise). */
export function addInterval(ms: number, interval?: string | null): number {
  const d = new Date(ms);
  switch (String(interval || "monthly").toLowerCase()) {
    case "hourly": return ms + HOUR;
    case "daily": return ms + DAY;
    case "weekly": return ms + 7 * DAY;
    case "quarterly": d.setUTCMonth(d.getUTCMonth() + 3); return d.getTime();
    case "biannually": d.setUTCMonth(d.getUTCMonth() + 6); return d.getTime();
    case "annually": d.setUTCFullYear(d.getUTCFullYear() + 1); return d.getTime();
    default: d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime();
  }
}

/** When the paid period ends: the date on file, or a month after the last payment. */
export function paidThrough(s: BillingState): number | null {
  if (s.currentPeriodEnd !== null) return s.currentPeriodEnd;
  if (s.lastPaymentAt !== null) return addInterval(s.lastPaymentAt);
  return null;
}

/** The end of the grace period after a failed renewal. */
export function graceEndsAt(s: BillingState): number | null {
  const paid = paidThrough(s);
  const start = s.pastDueAt ?? paid;
  if (start === null) return null;
  return Math.max(start + GRACE_MS, paid ?? 0);
}

/** Until when a paying account has PRO: Infinity while it renews, null when it has none now. */
export function paidProUntil(s: BillingState, now: number): number | null {
  let end: number | null;
  switch (s.subscriptionStatus) {
    case "active": return Infinity;
    case "canceled": end = paidThrough(s); break;
    case "past_due": end = graceEndsAt(s); break;
    default: return null;
  }
  return end !== null && end > now ? end : null;
}

export function hasPaidPro(s: BillingState, now: number): boolean {
  return paidProUntil(s, now) !== null;
}

/** What the app shows: when a renewing plan renews, or when a non-renewing one ends. */
export function standing(s: BillingState, now: number): { renewsAt: number | null; proUntil: number | null } {
  const until = paidProUntil(s, now);
  if (until === Infinity) return { renewsAt: paidThrough(s), proUntil: null };
  return { renewsAt: null, proUntil: until };
}

function parseTime(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** When a Paystack payment was made; now if it doesn't say. */
export function paymentTime(data: any, now: number): number {
  return parseTime(data?.paid_at) ?? parseTime(data?.paidAt) ?? parseTime(data?.transaction_date) ?? now;
}

/**
 * When the period a Paystack payment or subscription pays for ends: its next
 * payment date when it gives one, otherwise one plan interval after payment.
 */
export function periodEndFrom(data: any, now: number): number {
  const next = parseTime(data?.next_payment_date) ?? parseTime(data?.subscription?.next_payment_date);
  if (next !== null) return next;
  const interval = data?.plan?.interval ?? data?.plan_object?.interval ?? null;
  return addInterval(paymentTime(data, now), typeof interval === "string" ? interval : null);
}

/** The subscription a Paystack event is about, when it says. */
export function eventSubscriptionCode(data: any): string | null {
  const code = data?.subscription_code ?? data?.subscription?.subscription_code;
  return typeof code === "string" && code ? code : null;
}

/**
 * Whether an event is about the subscription on file. One about an older
 * subscription (replaced when the user paid again) must not change the
 * account: its cancellation isn't the new one's.
 */
export function isCurrentSubscription(storedCode: string | null, data: any): boolean {
  const code = eventSubscriptionCode(data);
  return !code || !storedCode || code === storedCode;
}
