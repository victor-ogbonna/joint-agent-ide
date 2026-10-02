/**
 * Team and school licenses in the app: the shapes the server sends
 * (server/teams.ts) and the arithmetic the pages show before paying, which
 * mirrors server/teamRules.ts. The server always prices the payment itself.
 */
import { formatMoney, nairaToDollars } from "./plans";

const DAY = 24 * 60 * 60 * 1000;

export type LicenseState = "unpaid" | "active" | "grace" | "ended";
export type TeamRole = "admin" | "member";
export type TeamKind = "school" | "team";
/** A month, or a year (12 months for the price of 11). */
export type TeamPeriod = "month" | "year";

/** What /api/quota/status says about the account's team. */
export interface TeamStatusView {
  id: string;
  name: string;
  kind: TeamKind;
  role: TeamRole;
  state: LicenseState;
  paidUntil: number | null;
  graceUntil: number | null;
}

const STATES: LicenseState[] = ["unpaid", "active", "grace", "ended"];
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readTeamStatus(raw: any): TeamStatusView | null {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind === "school" ? "school" : "team",
    role: raw.role === "admin" ? "admin" : "member",
    state: STATES.includes(raw.state) ? raw.state : "unpaid",
    paidUntil: time(raw.paidUntil),
    graceUntil: time(raw.graceUntil),
  };
}

/**
 * Joining, invitations and team projects are locked before a team's first
 * payment ("unpaid"), and after its license ends until it's renewed
 * ("ended"); open while it's paid or in its grace days. As the server
 * decides (server/teams.ts licensePaid).
 */
export type TeamLock = "unpaid" | "ended" | null;
export const lockOf = (state: LicenseState): TeamLock => (state === "unpaid" || state === "ended" ? state : null);

/** An invitation waiting for the account to accept (on /team), from /api/quota/status. */
export interface TeamInvitationView {
  teamId: string;
  teamName: string;
  role: TeamRole;
  state: LicenseState;
}

export function readInvitation(raw: any): TeamInvitationView | null {
  if (!raw || typeof raw !== "object" || typeof raw.teamId !== "string" || typeof raw.teamName !== "string") return null;
  return {
    teamId: raw.teamId,
    teamName: raw.teamName,
    role: raw.role === "admin" ? "admin" : "member",
    state: STATES.includes(raw.state) ? raw.state : "unpaid",
  };
}

/** Whole days left until `at`, at least 1 while it's still ahead. */
export function daysLeft(at: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((at - now) / DAY));
}

export const PERIOD_MONTHS: Record<TeamPeriod, { months: number; chargedMonths: number; label: string; short: string }> = {
  month: { months: 1, chargedMonths: 1, label: "1 month", short: "a month" },
  year: { months: 12, chargedMonths: 11, label: "1 year", short: "a year" },
};

/**
 * The normal team prices, for a visitor not signed in yet (signed in, the
 * page shows the server's). Mirrors server/teamRules.ts: test/teams.mjs
 * fails if the two ever disagree.
 */
export const TEAM_PRICES = { seatPrice: 664_300, currency: "NGN", minSeats: 5, maxSeats: 2000 };

export function renewalPrice(seats: number, seatPrice: number, period: TeamPeriod): number {
  return seats * seatPrice * PERIOD_MONTHS[period].chargedMonths;
}

/** Extra seats for the days left of the paid period, as the server prices them. */
export function addSeatsPrice(extra: number, seatPrice: number, paidUntil: number | null, now = Date.now()): number {
  if (extra <= 0 || paidUntil === null || paidUntil <= now) return 0;
  return Math.ceil((extra * seatPrice * daysLeft(paidUntil, now)) / 30);
}

export interface TeamSavings {
  /** PRO a month for one person on their own. */
  pro: number;
  perSeat: number;
  teamPays: number;
  onTheirOwn: number;
  saved: number;
}

/**
 * A team's prices as the pages show them. Prices are shown in dollars: a
 * naira amount in proportion to the seat price, at $7 to ₦9,300 for the seat
 * itself, so a ₦6,643 seat reads $5 and 6 of them for a month read $30, not a
 * cent off. `naira` is what Paystack charges, for the line under a pay
 * button; null when the price isn't in naira (a team priced in dollars).
 */
export function teamMoney(seatPrice: number, currency: string): { seat: number; currency: string; show: (amount: number) => string; naira: (amount: number) => string | null } {
  const inNaira = currency.toUpperCase() === "NGN" && seatPrice > 0;
  const seat = inNaira ? nairaToDollars(seatPrice) : seatPrice;
  const shown = inNaira ? "USD" : currency;
  return {
    seat,
    currency: shown,
    show: (amount) => formatMoney(inNaira ? Math.round((amount * seat) / seatPrice) : amount, shown),
    naira: (amount) => (inNaira ? formatMoney(amount, "NGN") : null),
  };
}

/**
 * What a team saves a month against everyone paying for PRO on their own.
 * `pro` is PRO's monthly price, tried in order (from Paystack, then the
 * listed $7); the first in the currency given counts. Null when none is, or
 * a seat costs no less.
 */
export function teamSavings(seats: number, seatPrice: number, currency: string, pro: ({ amount: number; currency: string } | null)[]): TeamSavings | null {
  const match = pro.find((p) => p && Number.isFinite(p.amount) && p.amount > 0 && p.currency.toUpperCase() === currency.toUpperCase());
  if (!match || !Number.isInteger(seats) || seats < 1 || seatPrice >= match.amount) return null;
  const perSeat = match.amount - seatPrice;
  return { pro: match.amount, perSeat, teamPays: seats * seatPrice, onTheirOwn: seats * match.amount, saved: seats * perSeat };
}

/** The license in a few words, for a badge. */
export function stateLabel(state: LicenseState): string {
  switch (state) {
    case "active": return "Active";
    case "grace": return "Grace days";
    case "ended": return "Ended";
    default: return "Not paid yet";
  }
}
