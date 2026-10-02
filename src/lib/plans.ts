// The plans as the app describes them. Mirrors server/quota.ts and
// server/deepseek.ts for display only: the server enforces every limit, and
// test/tiers.mjs fails if the two ever disagree.
export const WINDOW_HOURS = 5;
export const FREE_WINDOW_TOKENS = 5000;
export const FREE_DAILY_TOKENS = 10000;
export const PRO_WINDOW_TOKENS = 50000;
export const PAID_TOKEN_CAP = 600000;
export const FREE_MAX_REPLY_TOKENS = 5000;
export const PRO_MAX_REPLY_TOKENS = 40000;
export const FREE_WINDOW_COMPILES = 8;
export const FREE_DAILY_COMPILES = 25;
export const PRO_PRICE = "$7/month";
/**
 * PRO's monthly price as amounts (kobo, cents), for sums such as what a team
 * saves when Paystack's own can't be read: ₦9,300 on the Paystack plan,
 * which is the $7 of PRO_PRICE.
 */
export const PRO_MONTHLY_PRICES = [{ amount: 930_000, currency: "NGN" }, { amount: 700, currency: "USD" }];
/** Projects a Free account can have at once. Nothing is ever deleted to fit: past it, a new one waits for a free slot. */
export const FREE_PROJECT_LIMIT = 5;

/** How much of an allowance is used, as a whole percentage: never shown as token counts. */
export function percentUsed(used: number, cap: number): number {
  if (!cap || cap <= 0) return 0;
  const p = (used / cap) * 100;
  // 0.4% reads as 1%, never as a reassuring 0% after real use; never above 100.
  return Math.min(100, used > 0 ? Math.max(1, Math.round(p)) : 0);
}

/** "3 days 4 h", "2 h 13 min", "13 min", "less than a minute" until `resetAt`. */
export function formatWait(resetAt: number, now = Date.now()): string {
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

/** A day on the user's own calendar: "Wed 28 Oct". */
export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** The refill time on the user's own clock: "at 9:40 PM" today, "on Fri 3 Oct, 9:40 PM" on another day. */
export function formatWhen(at: number, now = Date.now()): string {
  const when = new Date(at);
  if (when.toDateString() === new Date(now).toDateString()) {
    return `at ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return `on ${when.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Money in a currency's smallest unit (kobo, cents), as people read it:
 * "$5.60", "₦4,000". The narrow symbol, so naira reads "₦6,643" in every
 * browser language (en-US alone would write "NGN 6,643"); a browser too old
 * for it gets the usual symbol.
 */
export function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  const digits = { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol", ...digits }).format(major);
  } catch {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, ...digits }).format(major);
    } catch {
      return `${currency} ${major.toFixed(2)}`;
    }
  }
}
