// The plans as the app describes them. Mirrors server/quota.ts and
// server/deepseek.ts for display only: the server enforces every limit, and
// test/tiers.mjs fails if the two ever disagree.
export const WINDOW_HOURS = 5;
export const FREE_WINDOW_TOKENS = 10000;
export const FREE_DAILY_TOKENS = 20000;
export const PRO_WINDOW_TOKENS = 250000;
export const PAID_TOKEN_CAP = 3000000;
export const FREE_MAX_REPLY_TOKENS = 10000;
export const PRO_MAX_REPLY_TOKENS = 40000;
export const FREE_WINDOW_COMPILES = 10;
export const FREE_DAILY_COMPILES = 30;
export const PRO_PRICE = "$7/month";
/**
 * PRO a month in cents and in kobo: the $7 of PRO_PRICE, which Paystack
 * charges as ₦9,300. Prices are shown in dollars everywhere, and this is the
 * rate a naira amount is shown at.
 */
export const PRO_MONTHLY = { cents: 700, kobo: 930_000 };
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

/** A naira amount (kobo) in dollars (cents), at PRO's rate of $7 to ₦9,300, to the cent. */
export function nairaToDollars(kobo: number): number {
  return Math.round((kobo * PRO_MONTHLY.cents) / PRO_MONTHLY.kobo);
}

const isNaira = (currency: string) => currency.toUpperCase() === "NGN";

/** A price as the app shows it: in dollars (a naira amount at $7 to ₦9,300), any other currency as it is. */
export function showPrice(minor: number, currency: string): string {
  return isNaira(currency) ? formatMoney(nairaToDollars(minor), "USD") : formatMoney(minor, currency);
}

/**
 * What Paystack's payment window will charge, in naira, for the line under a
 * pay button ("Charged in naira at checkout: ₦9,300 a month."). Null when the
 * price isn't in naira, so the button already says what's charged.
 */
export function nairaNote(minor: number, currency: string, per = ""): string | null {
  return isNaira(currency) ? `Charged in naira at checkout: ${formatMoney(minor, "NGN")}${per ? ` ${per}` : ""}.` : null;
}
