/**
 * Team and school licenses in the app: the shapes the server sends
 * (server/teams.ts) and the arithmetic the pages show before paying, which
 * mirrors server/teamRules.ts. The server always prices the payment itself.
 */
const DAY = 24 * 60 * 60 * 1000;

export type LicenseState = "unpaid" | "active" | "grace" | "ended";
export type TeamRole = "admin" | "member";
export type TeamKind = "school" | "team";
export type TeamPeriod = "month" | "term" | "year";

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

/** Whole days left until `at`, at least 1 while it's still ahead. */
export function daysLeft(at: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((at - now) / DAY));
}

export const PERIOD_MONTHS: Record<TeamPeriod, { months: number; chargedMonths: number; label: string; short: string }> = {
  month: { months: 1, chargedMonths: 1, label: "1 month", short: "a month" },
  term: { months: 4, chargedMonths: 4, label: "1 term (4 months)", short: "a term" },
  year: { months: 12, chargedMonths: 11, label: "1 year (12 months for the price of 11)", short: "a year" },
};

export function renewalPrice(seats: number, seatPrice: number, period: TeamPeriod): number {
  return seats * seatPrice * PERIOD_MONTHS[period].chargedMonths;
}

/** Extra seats for the days left of the paid period, as the server prices them. */
export function addSeatsPrice(extra: number, seatPrice: number, paidUntil: number | null, now = Date.now()): number {
  if (extra <= 0 || paidUntil === null || paidUntil <= now) return 0;
  return Math.ceil((extra * seatPrice * daysLeft(paidUntil, now)) / 30);
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
