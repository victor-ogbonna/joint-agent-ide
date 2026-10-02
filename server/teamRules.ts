/**
 * Team and school licenses: the rules, kept free of Firebase so each can be
 * tested on its own (test/teams.mjs). The data and routes are server/teams.ts.
 *
 *   - A team pays per seat: DEFAULT_SEAT_PRICE a member a month unless the
 *     admin page sets a special price for it, at least MIN_SEATS seats.
 *   - It pays ahead for a month, or a year (12 months for the price of
 *     11). No card is charged by itself: the team's admin renews by paying
 *     again, or we record an invoice that was paid.
 *   - Every member has PRO while the license is paid, and for GRACE_DAYS
 *     after it ends, which every member is shown counting down.
 *   - Seats added part-way through are charged for the days left.
 */
const DAY = 24 * 60 * 60 * 1000;

/** In the currency's smallest unit: $5.00. */
export const DEFAULT_SEAT_PRICE = 500;
export const DEFAULT_TEAM_CURRENCY = "USD";
export const MIN_SEATS = 5;
export const MAX_SEATS = 2000;
export const GRACE_DAYS = 7;
export const GRACE_MS = GRACE_DAYS * DAY;
/** The Paystack metadata that marks a team license payment. */
export const TEAM_KIND = "team_license";
/** Most email addresses invited in one go (a Firestore transaction writes at most 500 documents). */
export const MAX_INVITES_AT_ONCE = 400;
/** Seats added part-way are charged per day, a month counting as this many. */
const DAYS_PER_MONTH = 30;

/** A month, or a year. No school term: terms differ from place to place. */
export type TeamPeriod = "month" | "year";

export const PERIODS: Record<TeamPeriod, { months: number; chargedMonths: number; label: string }> = {
  month: { months: 1, chargedMonths: 1, label: "1 month" },
  year: { months: 12, chargedMonths: 11, label: "1 year (12 months for the price of 11)" },
};

export function isPeriod(v: unknown): v is TeamPeriod {
  return v === "month" || v === "year";
}

export function addMonths(ms: number, k: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.getTime();
}

/** A seat count a team may have, or null. */
export function validSeats(raw: unknown, atLeast = MIN_SEATS): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < Math.max(MIN_SEATS, atLeast) || n > MAX_SEATS) return null;
  return n;
}

/** What paying ahead costs: seats × price × the months charged. */
export function renewalPrice(seats: number, seatPrice: number, period: TeamPeriod): number {
  return seats * seatPrice * PERIODS[period].chargedMonths;
}

/**
 * What extra seats cost for the rest of the paid period, by the day, at
 * least one day. Nothing is charged when nothing is paid yet: the seats are
 * then simply part of the first payment.
 */
export function addSeatsPrice(extra: number, seatPrice: number, paidUntil: number | null, now: number): number {
  if (extra <= 0 || paidUntil === null || paidUntil <= now) return 0;
  const days = Math.max(1, Math.ceil((paidUntil - now) / DAY));
  return Math.ceil((extra * seatPrice * days) / DAYS_PER_MONTH);
}

/** Paid through when a renewal lands: on from the current end, or from now if it has passed. */
export function renewedUntil(paidUntil: number | null, paidAt: number, months: number): number {
  const from = paidUntil !== null && paidUntil > paidAt ? paidUntil : paidAt;
  return addMonths(from, months);
}

export type LicenseState = "unpaid" | "active" | "grace" | "ended";

/** Where a license stands, and until when its members keep PRO. */
export function licenseStanding(paidUntil: number | null, now: number): { state: LicenseState; proUntil: number | null; graceUntil: number | null } {
  if (paidUntil === null) return { state: "unpaid", proUntil: null, graceUntil: null };
  const graceUntil = paidUntil + GRACE_MS;
  if (now < paidUntil) return { state: "active", proUntil: graceUntil, graceUntil };
  if (now < graceUntil) return { state: "grace", proUntil: graceUntil, graceUntil };
  return { state: "ended", proUntil: null, graceUntil };
}

/** Whether a member has PRO through their team: until the license ends, plus the grace days. */
export function teamGivesPro(teamPaidUntil: number | null, now: number): boolean {
  return teamPaidUntil !== null && now < teamPaidUntil + GRACE_MS;
}

/** Email addresses from pasted text (commas, spaces, new lines), lower case, each once. */
export function emailList(text: unknown, max = MAX_SEATS): { emails: string[]; invalid: string[] } {
  const parts = String(text ?? "").split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(p) || p.length > 200) { invalid.push(p); continue; }
    if (!emails.includes(p)) emails.push(p);
  }
  return { emails: emails.slice(0, max), invalid };
}

/** A join code: 8 characters people can read aloud (no 0/O, 1/I/L). */
export function newJoinCode(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(random() * alphabet.length)];
  return code;
}

export function normalizeJoinCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-HJ-KM-NP-Z2-9]{8}$/.test(code) ? code : null;
}

/** A team member's monthly AI allowance runs by the calendar month (UTC). */
export function teamMonthKey(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function nextTeamMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
