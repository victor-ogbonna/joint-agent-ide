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

/** "2 h 13 min", "13 min", "less than a minute" until `resetAt`. */
export function formatWait(resetAt: number, now = Date.now()): string {
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes <= 1) return "less than a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The refill time on the user's own clock, e.g. "9:40 PM". */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
