/**
 * Team and school licenses: the data and the routes. The rules (prices,
 * seats, grace days) are server/teamRules.ts.
 *
 * Firestore, server-only (the browser can't read or write any of these):
 *   teams/{id}                name, kind, seats, special seat price and
 *                             currency, paid until, join code, member count
 *   teamMembers/{uid}         one per account (an account is on one team at
 *                             most): its team, role, email, when it joined,
 *                             and whether the team's admins may see its
 *                             projects (adminsCanView, the member's choice;
 *                             server/teamProjects.ts)
 *   teamInvites/{id}:{email}  an address a team invited; the person accepts
 *                             (or declines) it on their Team page, signed in
 *                             with that address: nobody joins without saying so
 *   teamQuotes/{id}           a price shown to a team's admin, which their
 *                             Paystack payment then pays, once
 *   teamPayments/{ref}        each payment, online (keyed by the Paystack
 *                             reference, so one reported twice counts once)
 *                             or by invoice
 *   users/{uid}               teamId, written with the membership, and
 *                             teamMonth/teamMonthTokens (server/quota.ts)
 *
 * Every function takes the database as its first argument: adminDb in the
 * server, an in-memory stand-in in test/teams.mjs.
 */
import type express from "express";
import crypto from "crypto";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth, getOrCreateUserDoc, forgetTeam, type UserQuotaDoc } from "./quota";
import { paymentFacts, earningId } from "./creators";
import {
  DEFAULT_SEAT_PRICE, DEFAULT_TEAM_CURRENCY, MIN_SEATS, MAX_SEATS, PERIODS, TEAM_KIND, MAX_INVITES_AT_ONCE,
  normalSeatPrice, paidForMonths, isPeriod, validSeats, renewalPrice, addSeatsPrice, renewedUntil, licenseStanding, emailList, newJoinCode, normalizeJoinCode,
  type TeamPeriod, type LicenseState,
} from "./teamRules";

export const TEAMS = "teams";
export const MEMBERS = "teamMembers";
export const INVITES = "teamInvites";
export const QUOTES = "teamQuotes";
export const PAYMENTS = "teamPayments";
const USERS = "users";

/** adminDb, or a stand-in with the same calls (tests). */
type Db = any;

/** Why a team action was refused, for code that needs to tell refusals apart. */
export type TeamRefusal = "on_team" | "full" | "gone" | "not_admin" | "unpaid" | "other";

/** A refusal meant for the person: its message is shown as it is. */
export class TeamError extends Error {
  constructor(message: string, public status = 400, public reason: TeamRefusal = "other") {
    super(message);
    this.name = "TeamError";
  }
}

export type TeamKind = "school" | "team";
export type TeamRole = "admin" | "member";

export interface TeamRecord {
  id: string;
  name: string;
  kind: TeamKind;
  seats: number;
  /** A special price a seat a month, in the currency's smallest unit; null for the normal one in its currency. */
  seatPrice: number | null;
  currency: string;
  paidUntil: number | null;
  /** What it was paid for last, a month or a year: its grace days follow from it. Null before any payment. */
  paidFor: TeamPeriod | null;
  joinCode: string;
  joinOpen: boolean;
  memberCount: number;
  createdAt: number;
  /** Who it was made for: the person who made it, or the address the admin page invited. */
  ownerEmail: string | null;
}

export interface MemberRecord {
  uid: string;
  teamId: string;
  email: string | null;
  emailVerified: boolean;
  role: TeamRole;
  joinedAt: number;
  /** The member lets the team's admins see their projects (off until they turn it on). */
  adminsCanView: boolean;
}

/** The signed-in person acting. */
export interface Who {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function teamOf(id: string, d: any): TeamRecord {
  d = d || {};
  const seatPrice = typeof d.seatPrice === "number" && Number.isFinite(d.seatPrice) ? d.seatPrice : null;
  return {
    id,
    name: typeof d.name === "string" && d.name ? d.name : "Team",
    kind: d.kind === "school" ? "school" : "team",
    seats: num(d.seats, MIN_SEATS),
    seatPrice,
    // The normal price is always in DEFAULT_TEAM_CURRENCY, the currency
    // Paystack takes: a team made in dollars before teams were priced in
    // naira pays ₦6,643 a seat, the same $5. Another currency comes only
    // with a special price (priceOrRefuse).
    currency: seatPrice === null ? DEFAULT_TEAM_CURRENCY : typeof d.currency === "string" && /^[A-Z]{3}$/.test(d.currency) ? d.currency : DEFAULT_TEAM_CURRENCY,
    paidUntil: time(d.paidUntil),
    paidFor: isPeriod(d.paidFor) ? d.paidFor : null,
    joinCode: typeof d.joinCode === "string" ? d.joinCode : "",
    joinOpen: d.joinOpen !== false,
    memberCount: Math.max(0, num(d.memberCount)),
    createdAt: num(d.createdAt),
    ownerEmail: typeof d.ownerEmail === "string" && d.ownerEmail ? d.ownerEmail : null,
  };
}

export function memberOf(uid: string, d: any): MemberRecord {
  d = d || {};
  return {
    uid,
    teamId: typeof d.teamId === "string" ? d.teamId : "",
    email: typeof d.email === "string" && d.email ? d.email : null,
    emailVerified: d.emailVerified === true,
    role: d.role === "admin" ? "admin" : "member",
    joinedAt: num(d.joinedAt),
    adminsCanView: d.adminsCanView === true,
  };
}

/**
 * What a seat costs this team a month: its special price, or the normal one
 * in its currency. 0 when neither is set, which nobody can be charged (the
 * admin page asks for a special price in such a currency).
 */
export const seatPriceOf = (t: TeamRecord) => t.seatPrice ?? normalSeatPrice(t.currency) ?? 0;

/** The normal price is in DEFAULT_TEAM_CURRENCY; another currency needs a special price. */
function priceOrRefuse(currency: string, seatPrice: number | null): void {
  if (seatPrice === null && currency !== DEFAULT_TEAM_CURRENCY) {
    throw new TeamError(`A team at the normal price pays in ${DEFAULT_TEAM_CURRENCY}. To charge it in ${currency}, set a special price for it.`);
  }
}

const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (name.length < 2) throw new TeamError("Give the team or school a name.");
  return name;
}

function cleanKind(raw: unknown): TeamKind {
  return raw === "school" ? "school" : "team";
}

function cleanEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new TeamError("That email address doesn't look right.");
  return email;
}

/** A special seat price (smallest unit, so 500 is $5.00), or null for the normal one. */
function cleanSeatPrice(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100_000_000) {
    throw new TeamError("The seat price is an amount of 0 or more.");
  }
  return n;
}

/** An amount paid, in the smallest unit (cents, kobo). */
function cleanAmount(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000_000_000) throw new TeamError("The amount is 0 or more.");
  return n;
}

/** A team's id as Firestore made it, or a refusal. */
function cleanTeamId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) throw new TeamError("No such team.", 404, "gone");
  return raw;
}

function cleanCurrency(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TEAM_CURRENCY;
  const c = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new TeamError("The currency is a 3-letter code, like USD or NGN.");
  return c;
}

function seatsOrRefuse(raw: unknown, atLeast: number): number {
  const seats = validSeats(raw, atLeast);
  if (seats === null) {
    const least = Math.max(MIN_SEATS, atLeast);
    throw new TeamError(atLeast > MIN_SEATS
      ? `This team has ${atLeast} members, so it needs ${least} to ${MAX_SEATS} seats.`
      : `A license has ${least} to ${MAX_SEATS} seats.`);
  }
  return seats;
}

const teamRef = (db: Db, id: string) => db.collection(TEAMS).doc(id);
const memberRef = (db: Db, uid: string) => db.collection(MEMBERS).doc(uid);
const userRef = (db: Db, uid: string) => db.collection(USERS).doc(uid);
/**
 * Whether the team's license is paid now, or in its grace days. Joining,
 * invitations and team projects work only then: before the first payment,
 * and after a license ends until it's renewed, they're locked.
 */
export function licensePaid(team: Pick<TeamRecord, "paidUntil" | "paidFor">, now: number): boolean {
  const { state } = licenseStanding(team.paidUntil, now, team.paidFor);
  return state === "active" || state === "grace";
}

/** An invite's id: the team, then the address (an address has no "/"). */
export const inviteId = (teamId: string, email: string) => `${teamId}:${email}`;
const inviteRef = (db: Db, teamId: string, email: string) => db.collection(INVITES).doc(inviteId(teamId, email));

/** A random number from 0 up to 1, from the system's secure source. */
const secureRandom = () => crypto.randomInt(0, 1_000_000_000) / 1_000_000_000;

/** A join code no other team has. */
async function uniqueJoinCode(db: Db, random: () => number): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = newJoinCode(random);
    const taken = await db.collection(TEAMS).where("joinCode", "==", code).get();
    if (taken.empty) return code;
  }
  throw new Error("Could not find a free join code.");
}

/** The signed-in person's membership, which must be an admin's. */
async function adminMembership(tx: any, db: Db, uid: string): Promise<MemberRecord> {
  const snap = await tx.get(memberRef(db, uid));
  if (!snap.exists) throw new TeamError("You're not on a team.", 404, "gone");
  const m = memberOf(uid, snap.data());
  if (m.role !== "admin") throw new TeamError("Only the team's admins can do that.", 403, "not_admin");
  return m;
}

async function readTeam(tx: any, db: Db, id: string): Promise<TeamRecord> {
  const snap = await tx.get(teamRef(db, id));
  if (!snap.exists) throw new TeamError("That team no longer exists.", 404, "gone");
  return teamOf(id, snap.data());
}

export interface CreateTeamInput {
  name?: unknown;
  kind?: unknown;
  seats?: unknown;
  /** The admin page only. */
  seatPrice?: unknown;
  currency?: unknown;
  ownerEmail?: unknown;
}

/**
 * A new team. Made by a signed-in person (`by`), they are its first member
 * and admin, at the normal price. Made from the admin page (`by` null), the
 * owner's address is invited as its admin, and a special price may be set.
 * Either way it is unpaid until a payment or an invoice is recorded.
 */
export async function createTeam(db: Db, by: Who | null, input: CreateTeamInput, now: number, random: () => number = secureRandom): Promise<TeamRecord> {
  const name = cleanName(input.name);
  const kind = cleanKind(input.kind);
  const seats = seatsOrRefuse(input.seats ?? MIN_SEATS, MIN_SEATS);
  const seatPrice = by ? null : cleanSeatPrice(input.seatPrice);
  const currency = by ? DEFAULT_TEAM_CURRENCY : cleanCurrency(input.currency);
  priceOrRefuse(currency, seatPrice);
  let ownerEmail: string;
  if (by) {
    if (!by.email) throw new TeamError("Your account needs an email address to start a team.");
    ownerEmail = by.email.trim().toLowerCase();
  } else {
    ownerEmail = cleanEmail(input.ownerEmail);
  }
  const joinCode = await uniqueJoinCode(db, random);
  const ref = db.collection(TEAMS).doc();
  const record = { name, kind, seats, seatPrice, currency, paidUntil: null, joinCode, joinOpen: true, memberCount: by ? 1 : 0, createdAt: now, ownerEmail };
  return db.runTransaction(async (tx: any) => {
    if (by) {
      const mine = await tx.get(memberRef(db, by.uid));
      if (mine.exists) throw new TeamError("You're already on a team. Leave it first to start a new one.", 409, "on_team");
      tx.set(ref, record);
      tx.set(memberRef(db, by.uid), { teamId: ref.id, email: ownerEmail, emailVerified: by.emailVerified, role: "admin", joinedAt: now });
      tx.set(userRef(db, by.uid), { teamId: ref.id }, { merge: true });
    } else {
      tx.set(ref, record);
      tx.set(inviteRef(db, ref.id, ownerEmail), { teamId: ref.id, email: ownerEmail, role: "admin", invitedAt: now });
    }
    return teamOf(ref.id, record);
  });
}

/**
 * Put an account on a team, by its join code or by an invitation to the
 * account's (verified) address. An invitation is used up; one as admin makes
 * the person an admin.
 */
async function joinTeam(db: Db, who: Who, teamId: string, via: { code?: string }, now: number): Promise<TeamRecord> {
  const email = who.emailVerified && who.email ? who.email.trim().toLowerCase() : null;
  return db.runTransaction(async (tx: any) => {
    const mine = await tx.get(memberRef(db, who.uid));
    const team = await readTeam(tx, db, teamId);
    const invite = email ? await tx.get(inviteRef(db, teamId, email)) : null;
    if (mine.exists) {
      const m = memberOf(who.uid, mine.data());
      throw m.teamId === teamId
        ? new TeamError("You're already on this team.", 409, "on_team")
        : new TeamError("You're already on a team. Leave it first to join another.", 409, "on_team");
    }
    if (via.code !== undefined) {
      if (team.joinCode !== via.code) throw new TeamError("That join code isn't valid. Check it with your team's admin.", 404, "gone");
      if (!team.joinOpen) throw new TeamError("Joining by code is switched off for this team. Ask its admin.", 403);
    } else if (!invite?.exists) {
      throw new TeamError("That invitation is no longer open.", 404, "gone");
    }
    const role: TeamRole = invite?.exists && invite.data()?.role === "admin" ? "admin" : "member";
    // Nobody joins a team that isn't paid, except an admin invited from the
    // admin page: they join to pay for it.
    if (role !== "admin" && !licensePaid(team, now)) {
      throw new TeamError(team.paidUntil === null
        ? "This team's license isn't paid yet, so nobody can join it. Ask its admin to pay for it first."
        : "This team's license has ended, so nobody can join it until it's renewed. Ask its admin to renew it.", 402, "unpaid");
    }
    if (team.memberCount >= team.seats) throw new TeamError("This team is full. Ask its admin to add seats.", 409, "full");
    tx.set(memberRef(db, who.uid), { teamId, email: who.email ? who.email.trim().toLowerCase() : null, emailVerified: who.emailVerified, role, joinedAt: now });
    tx.set(userRef(db, who.uid), { teamId }, { merge: true });
    tx.set(teamRef(db, teamId), { memberCount: team.memberCount + 1 }, { merge: true });
    if (invite?.exists) tx.delete(inviteRef(db, teamId, email!));
    return { ...team, memberCount: team.memberCount + 1 };
  });
}

/** Join the team whose code this is. */
export async function joinByCode(db: Db, who: Who, rawCode: unknown, now: number): Promise<TeamRecord> {
  const code = normalizeJoinCode(rawCode);
  if (!code) throw new TeamError("A join code is 8 letters and digits. Check it with your team's admin.");
  const found = await db.collection(TEAMS).where("joinCode", "==", code).get();
  if (found.empty) throw new TeamError("That join code isn't valid. Check it with your team's admin.", 404, "gone");
  return joinTeam(db, who, found.docs[0].id, { code }, now);
}

interface InviteRow {
  teamId: string;
  email: string;
  role: TeamRole;
  invitedAt: number;
}

const inviteOf = (d: any): InviteRow => ({
  teamId: String(d?.teamId ?? ""),
  email: String(d?.email ?? ""),
  role: d?.role === "admin" ? "admin" : "member",
  invitedAt: num(d?.invitedAt),
});

async function invitesFor(db: Db, email: string): Promise<InviteRow[]> {
  const snap = await db.collection(INVITES).where("email", "==", email).get();
  return snap.docs.map((d: any) => inviteOf(d.data())).sort((a: InviteRow, b: InviteRow) => a.invitedAt - b.invitedAt);
}

/**
 * Accept an invitation to the account's verified address: the person joins
 * only when they say so (Accept on their Team page). Refused, with the
 * invitation kept, while they're on another team, the team is full, or its
 * license isn't paid (an admin's invitation excepted); one for a team that's
 * gone is cleared. The team joined.
 */
export async function acceptInvite(db: Db, who: Who, rawTeamId: unknown, now: number): Promise<TeamRecord> {
  if (!who.emailVerified || !who.email) throw new TeamError("Verify your email address first, then accept the invitation.");
  const teamId = cleanTeamId(rawTeamId);
  try {
    return await joinTeam(db, who, teamId, {}, now);
  } catch (err) {
    if (err instanceof TeamError && err.reason === "gone") {
      await inviteRef(db, teamId, who.email.trim().toLowerCase()).delete().catch(() => {});
    }
    throw err;
  }
}

/** The oldest invitation waiting for the account's verified address, for the app to point to; null when none. */
export async function invitationFor(db: Db, who: Who, now: number): Promise<WaitingInvite | null> {
  if (!who.emailVerified || !who.email) return null;
  const email = who.email.trim().toLowerCase();
  for (const inv of await invitesFor(db, email)) {
    const t = await teamRef(db, inv.teamId).get();
    // A team that's gone: its invitation is cleared, so it isn't read again.
    if (!t.exists) { await inviteRef(db, inv.teamId, email).delete().catch(() => {}); continue; }
    return waitingInvite(inv, teamOf(inv.teamId, t.data()), now);
  }
  return null;
}

/** Leave your team. Its last admin can't leave while others are on it. */
export async function leaveTeam(db: Db, uid: string): Promise<void> {
  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(memberRef(db, uid));
    if (!snap.exists) throw new TeamError("You're not on a team.", 404, "gone");
    const me = memberOf(uid, snap.data());
    const teamSnap = await tx.get(teamRef(db, me.teamId));
    const all = await tx.get(db.collection(MEMBERS).where("teamId", "==", me.teamId));
    const others = all.docs.filter((d: any) => d.id !== uid).map((d: any) => memberOf(d.id, d.data()));
    if (me.role === "admin" && others.length > 0 && !others.some((m: MemberRecord) => m.role === "admin")) {
      throw new TeamError("Make another member an admin before you leave, so the team still has one.", 409);
    }
    tx.delete(memberRef(db, uid));
    tx.set(userRef(db, uid), { teamId: null }, { merge: true });
    if (teamSnap.exists) tx.set(teamRef(db, me.teamId), { memberCount: Math.max(0, others.length) }, { merge: true });
  });
}

/** Take someone off your team (an admin). Their projects stay theirs; they're on Free unless they pay. */
export async function removeMember(db: Db, adminUid: string, targetUid: unknown): Promise<void> {
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) throw new TeamError("That person isn't on your team.", 404);
  if (targetUid === adminUid) throw new TeamError("To leave the team yourself, use Leave team.");
  await db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const snap = await tx.get(memberRef(db, targetUid));
    const team = await readTeam(tx, db, admin.teamId);
    if (!snap.exists || memberOf(targetUid, snap.data()).teamId !== admin.teamId) throw new TeamError("That person isn't on your team.", 404);
    tx.delete(memberRef(db, targetUid));
    tx.set(userRef(db, targetUid), { teamId: null }, { merge: true });
    tx.set(teamRef(db, admin.teamId), { memberCount: Math.max(0, team.memberCount - 1) }, { merge: true });
  });
}

/** Make a member an admin, or an admin a member (an admin, for someone else). */
export async function setRole(db: Db, adminUid: string, targetUid: unknown, role: unknown): Promise<void> {
  if (role !== "admin" && role !== "member") throw new TeamError("A role is admin or member.");
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) throw new TeamError("That person isn't on your team.", 404);
  if (targetUid === adminUid) throw new TeamError("Another admin can change your role.");
  await db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const snap = await tx.get(memberRef(db, targetUid));
    if (!snap.exists || memberOf(targetUid, snap.data()).teamId !== admin.teamId) throw new TeamError("That person isn't on your team.", 404);
    tx.set(memberRef(db, targetUid), { role }, { merge: true });
  });
}

/** Rename the team, switch joining by code on or off, or replace the code (an admin). */
export async function updateTeamSettings(db: Db, adminUid: string, patch: { name?: unknown; joinOpen?: unknown; newCode?: unknown }, random: () => number = secureRandom): Promise<TeamRecord> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.joinOpen !== undefined) {
    if (typeof patch.joinOpen !== "boolean") throw new TeamError("On or off, please.");
    changes.joinOpen = patch.joinOpen;
  }
  if (patch.newCode === true) changes.joinCode = await uniqueJoinCode(db, random);
  if (!Object.keys(changes).length) throw new TeamError("Nothing to change.");
  return db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const team = await readTeam(tx, db, admin.teamId);
    tx.set(teamRef(db, team.id), changes, { merge: true });
    return teamOf(team.id, { ...team, ...changes });
  });
}

async function addInvites(tx: any, db: Db, team: TeamRecord, emails: string[], role: TeamRole, now: number): Promise<{ invited: string[]; already: string[] }> {
  const members = await tx.get(db.collection(MEMBERS).where("teamId", "==", team.id));
  const pending = await tx.get(db.collection(INVITES).where("teamId", "==", team.id));
  const memberEmails = new Set(members.docs.map((d: any) => memberOf(d.id, d.data()).email).filter(Boolean));
  const invited = new Set(pending.docs.map((d: any) => inviteOf(d.data()).email));
  const fresh = emails.filter((e) => !memberEmails.has(e) && !invited.has(e));
  const free = team.seats - team.memberCount - invited.size;
  if (fresh.length > free) {
    throw new TeamError(free <= 0
      ? "Every seat is taken or invited. Add seats to invite more people."
      : `${free} seat${free === 1 ? " is" : "s are"} free, and you added ${fresh.length} new address${fresh.length === 1 ? "" : "es"}. Add seats, or invite fewer.`, 409, "full");
  }
  for (const email of fresh) tx.set(inviteRef(db, team.id, email), { teamId: team.id, email, role, invitedAt: now });
  return { invited: fresh, already: emails.filter((e) => !fresh.includes(e)) };
}

/** Invite a pasted list of addresses (an admin). Each takes a seat when they join. */
export async function inviteEmails(db: Db, adminUid: string, text: unknown, now: number): Promise<{ invited: string[]; already: string[]; invalid: string[] }> {
  const { emails, invalid } = emailList(text, Number.MAX_SAFE_INTEGER);
  if (!emails.length) {
    throw new TeamError(invalid.length ? `These don't look like email addresses: ${invalid.slice(0, 5).join(", ")}` : "Add at least one email address.");
  }
  if (emails.length > MAX_INVITES_AT_ONCE) throw new TeamError(`Invite at most ${MAX_INVITES_AT_ONCE} addresses at a time.`);
  return db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const team = await readTeam(tx, db, admin.teamId);
    if (!licensePaid(team, now)) {
      throw new TeamError(team.paidUntil === null
        ? "Pay for the license first. Then you can invite people."
        : "The license has ended. Renew it first, then invite people.", 402, "unpaid");
    }
    const result = await addInvites(tx, db, team, emails, "member", now);
    return { ...result, invalid };
  });
}

/** Withdraw an invitation (an admin). */
export async function cancelInvite(db: Db, adminUid: string, rawEmail: unknown): Promise<void> {
  const email = cleanEmail(rawEmail);
  await db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const snap = await tx.get(inviteRef(db, admin.teamId, email));
    if (!snap.exists) throw new TeamError("That address isn't invited.", 404);
    tx.delete(inviteRef(db, admin.teamId, email));
  });
}

/** Turn down an invitation to your own address. */
export async function declineInvite(db: Db, who: Who, rawTeamId: unknown): Promise<void> {
  if (!who.emailVerified || !who.email) throw new TeamError("Verify your email address first.");
  const teamId = cleanTeamId(rawTeamId);
  const ref = inviteRef(db, teamId, who.email.trim().toLowerCase());
  const snap = await ref.get();
  if (!snap.exists) throw new TeamError("That invitation is no longer open.", 404);
  await ref.delete();
}

export type QuoteAction = "renew" | "add_seats";

export interface Quote {
  id: string;
  teamId: string;
  action: QuoteAction;
  period: TeamPeriod | null;
  /** The seats the team has once this is paid. */
  seats: number;
  extra: number;
  months: number;
  amount: number;
  currency: string;
  /** Paid until, once this is paid now. */
  paidUntilAfter: number | null;
}

/**
 * A price for a team's admin to pay online: renewing (or a first payment)
 * for a period and a number of seats, or seats added for the rest of the
 * period already paid. Kept, so the payment is checked against exactly
 * what was shown.
 */
export async function quoteFor(db: Db, adminUid: string, input: { action?: unknown; period?: unknown; seats?: unknown; extra?: unknown }, now: number): Promise<Quote> {
  const action: QuoteAction | null = input.action === "renew" ? "renew" : input.action === "add_seats" ? "add_seats" : null;
  if (!action) throw new TeamError("Choose to renew or to add seats.");
  const ref = db.collection(QUOTES).doc();
  return db.runTransaction(async (tx: any) => {
    const admin = await adminMembership(tx, db, adminUid);
    const team = await readTeam(tx, db, admin.teamId);
    const price = seatPriceOf(team);
    let quote: Omit<Quote, "id">;
    if (action === "renew") {
      if (!isPeriod(input.period)) throw new TeamError("A license is paid for a month or a year. Refresh the page, then try again.");
      const period = input.period;
      const seats = seatsOrRefuse(input.seats ?? team.seats, team.memberCount);
      const months = PERIODS[period].months;
      quote = {
        teamId: team.id, action, period, seats, extra: 0, months,
        amount: renewalPrice(seats, price, period), currency: team.currency,
        paidUntilAfter: renewedUntil(team.paidUntil, now, months),
      };
    } else {
      if (licenseStanding(team.paidUntil, now, team.paidFor).state !== "active") {
        throw new TeamError("Seats can be added while the license is paid. Renew it instead, with the seats you need.", 409);
      }
      const extra = typeof input.extra === "string" && input.extra.trim() !== "" ? Number(input.extra) : input.extra;
      if (typeof extra !== "number" || !Number.isInteger(extra) || extra < 1 || team.seats + extra > MAX_SEATS) {
        throw new TeamError(`Add 1 to ${Math.max(1, MAX_SEATS - team.seats)} seats.`);
      }
      quote = {
        teamId: team.id, action, period: null, seats: team.seats + extra, extra, months: 0,
        amount: addSeatsPrice(extra, price, team.paidUntil, now), currency: team.currency,
        paidUntilAfter: team.paidUntil,
      };
    }
    if (quote.amount <= 0) throw new TeamError("There's nothing to pay for that. Contact us if this looks wrong.");
    tx.set(ref, { ...quote, uid: adminUid, createdAt: now, paidBy: null });
    return { id: ref.id, ...quote };
  });
}

export interface TeamPaymentResult {
  applied: boolean;
  /** Already applied for this payment (the app's check and the webhook both report it). */
  already: boolean;
  teamId: string;
  paidUntil: number | null;
  seats: number;
}

/**
 * A team admin's online payment, against the price they were shown. Checked:
 * whose it is, its currency, and that it paid the whole price. Safe to call
 * more than once for the same payment.
 */
export async function applyTeamPayment(db: Db, uid: string, data: any, now: number): Promise<TeamPaymentResult> {
  const pay = paymentFacts(data, now);
  if (!pay) throw new TeamError("The payment's details are missing.");
  if (data?.metadata?.uid !== uid) throw new TeamError("This payment doesn't belong to the signed-in account.", 403);
  if (data?.metadata?.kind !== TEAM_KIND) throw new TeamError("This isn't a team license payment.");
  const quoteId = data?.metadata?.quoteId;
  if (typeof quoteId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(quoteId)) {
    throw new TeamError("The payment doesn't say what it paid for. Contact us with its reference.", 409);
  }
  const payRef = db.collection(PAYMENTS).doc(earningId(pay.reference));
  const quoteRef = db.collection(QUOTES).doc(quoteId);
  const payerEmail = typeof data?.customer?.email === "string" ? data.customer.email : null;
  const result: TeamPaymentResult = await db.runTransaction(async (tx: any) => {
    const paySnap = await tx.get(payRef);
    if (paySnap.exists) {
      const teamId = String(paySnap.data()?.teamId ?? "");
      const teamSnap = teamId ? await tx.get(teamRef(db, teamId)) : null;
      const team = teamSnap?.exists ? teamOf(teamId, teamSnap.data()) : null;
      return { applied: false, already: true, teamId, paidUntil: team?.paidUntil ?? null, seats: team?.seats ?? 0 };
    }
    const quoteSnap = await tx.get(quoteRef);
    if (!quoteSnap.exists) throw new TeamError("We couldn't find the price this payment was for. Contact us with its reference.", 409);
    const q = quoteSnap.data() || {};
    if (q.uid !== uid) throw new TeamError("This payment doesn't belong to the signed-in account.", 403);
    if (q.paidBy) throw new TeamError("That price was paid already. Contact us with this payment's reference for a refund.", 409);
    if (typeof q.teamId !== "string" || !q.teamId) throw new TeamError("We couldn't find the team this payment was for. Contact us with its reference.", 409);
    const team = await readTeam(tx, db, q.teamId);
    if (pay.currency !== String(q.currency ?? "").toUpperCase()) throw new TeamError("The payment was in the wrong currency.", 402);
    if (pay.amount < num(q.amount)) throw new TeamError("The payment was less than the price.", 402);
    let seats = team.seats;
    let paidUntil = team.paidUntil;
    let paidFor = team.paidFor;
    if (q.action === "renew") {
      seats = num(q.seats, team.seats);
      paidUntil = renewedUntil(team.paidUntil, pay.paidAt, num(q.months, 1));
      paidFor = isPeriod(q.period) ? q.period : paidForMonths(num(q.months, 1));
    } else {
      seats = team.seats + num(q.extra);
    }
    seats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, seats));
    tx.set(teamRef(db, team.id), { seats, paidUntil, ...(paidFor ? { paidFor } : {}) }, { merge: true });
    tx.set(quoteRef, { paidBy: pay.reference }, { merge: true });
    tx.set(payRef, {
      reference: pay.reference,
      teamId: team.id,
      kind: "online",
      action: q.action === "renew" ? "renew" : "add_seats",
      period: isPeriod(q.period) ? q.period : null,
      months: num(q.months),
      seats,
      extra: num(q.extra),
      amount: pay.amount,
      currency: pay.currency,
      paidAt: pay.paidAt,
      payerUid: uid,
      payerEmail,
      note: null,
      createdAt: now,
    });
    return { applied: true, already: false, teamId: team.id, paidUntil, seats };
  });
  if (result.teamId) forgetTeam(result.teamId);
  return result;
}

/** A payment by invoice, recorded from the admin page: months added, and the seats it paid for. */
export async function recordInvoice(db: Db, rawTeamId: unknown, input: { months?: unknown; seats?: unknown; amount?: unknown; currency?: unknown; note?: unknown }, now: number): Promise<TeamRecord> {
  const teamId = cleanTeamId(rawTeamId);
  const months = typeof input.months === "string" ? Number(input.months) : input.months;
  if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 36) throw new TeamError("The invoice pays for 1 to 36 months.");
  const amount = input.amount === undefined || input.amount === null || input.amount === "" ? null : cleanAmount(input.amount);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  const ref = db.collection(PAYMENTS).doc();
  const updated: TeamRecord = await db.runTransaction(async (tx: any) => {
    const team = await readTeam(tx, db, teamId);
    const seats = input.seats === undefined || input.seats === null || input.seats === "" ? team.seats : seatsOrRefuse(input.seats, team.memberCount);
    const currency = input.currency === undefined || input.currency === null || input.currency === "" ? team.currency : cleanCurrency(input.currency);
    const paidUntil = renewedUntil(team.paidUntil, now, months);
    const paidFor = paidForMonths(months);
    tx.set(teamRef(db, team.id), { seats, paidUntil, paidFor }, { merge: true });
    tx.set(ref, {
      reference: null, teamId: team.id, kind: "invoice", action: "renew", period: null, months, seats, extra: 0,
      amount: amount ?? 0, currency, paidAt: now, payerUid: null, payerEmail: null, note, createdAt: now,
    });
    return { ...team, seats, paidUntil, paidFor };
  });
  forgetTeam(updated.id);
  return updated;
}

/** Change a team from the admin page: name, kind, seats, special price, currency, or the paid-until date. */
export async function adminUpdateTeam(db: Db, rawTeamId: unknown, patch: { name?: unknown; kind?: unknown; seats?: unknown; seatPrice?: unknown; currency?: unknown; paidUntil?: unknown; joinOpen?: unknown }): Promise<TeamRecord> {
  const teamId = cleanTeamId(rawTeamId);
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.kind !== undefined) changes.kind = cleanKind(patch.kind);
  if (patch.seatPrice !== undefined) changes.seatPrice = cleanSeatPrice(patch.seatPrice);
  if (patch.currency !== undefined) changes.currency = cleanCurrency(patch.currency);
  if (patch.paidUntil !== undefined) {
    if (patch.paidUntil !== null && (typeof patch.paidUntil !== "number" || !Number.isFinite(patch.paidUntil) || patch.paidUntil < 0)) {
      throw new TeamError("Paid until is a date, or empty for unpaid.");
    }
    changes.paidUntil = patch.paidUntil;
  }
  if (patch.joinOpen !== undefined) {
    if (typeof patch.joinOpen !== "boolean") throw new TeamError("On or off, please.");
    changes.joinOpen = patch.joinOpen;
  }
  const updated: TeamRecord = await db.runTransaction(async (tx: any) => {
    const team = await readTeam(tx, db, teamId);
    if (patch.seats !== undefined) changes.seats = seatsOrRefuse(patch.seats, team.memberCount);
    if (!Object.keys(changes).length) throw new TeamError("Nothing to change.");
    const nextPrice = changes.seatPrice !== undefined ? (changes.seatPrice as number | null) : team.seatPrice;
    const nextCurrency = changes.currency !== undefined ? (changes.currency as string) : team.currency;
    priceOrRefuse(nextCurrency, nextPrice);
    // Stored as it's read (a team at the normal price, in naira).
    changes.currency = nextCurrency;
    tx.set(teamRef(db, team.id), changes, { merge: true });
    return teamOf(team.id, { ...team, ...changes });
  });
  forgetTeam(updated.id);
  return updated;
}

/** Invite an address from the admin page, as the team's admin or a member. */
export async function adminInvite(db: Db, rawTeamId: unknown, rawEmail: unknown, role: unknown, now: number): Promise<{ invited: string[]; already: string[] }> {
  const teamId = cleanTeamId(rawTeamId);
  const email = cleanEmail(rawEmail);
  return db.runTransaction(async (tx: any) => {
    const team = await readTeam(tx, db, teamId);
    return addInvites(tx, db, team, [email], role === "member" ? "member" : "admin", now);
  });
}

export interface MemberRow {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  role: TeamRole;
  joinedAt: number;
  adminsCanView: boolean;
}

export interface PaymentRow {
  id: string;
  kind: "online" | "invoice";
  action: "renew" | "add_seats";
  period: TeamPeriod | null;
  months: number;
  seats: number;
  extra: number;
  amount: number;
  currency: string;
  paidAt: number;
  payerEmail: string | null;
  note: string | null;
}

const paymentOf = (id: string, d: any): PaymentRow => ({
  id,
  kind: d?.kind === "invoice" ? "invoice" : "online",
  action: d?.action === "add_seats" ? "add_seats" : "renew",
  period: isPeriod(d?.period) ? d.period : null,
  months: num(d?.months),
  seats: num(d?.seats),
  extra: num(d?.extra),
  amount: num(d?.amount),
  currency: typeof d?.currency === "string" ? d.currency : "",
  paidAt: num(d?.paidAt),
  payerEmail: typeof d?.payerEmail === "string" ? d.payerEmail : null,
  note: typeof d?.note === "string" && d.note ? d.note : null,
});

/** A team as everyone on it sees it. */
export interface TeamView {
  id: string;
  name: string;
  kind: TeamKind;
  role: TeamRole;
  state: LicenseState;
  paidUntil: number | null;
  /** When members lose PRO: the license's end plus the grace days. */
  graceUntil: number | null;
  seats: number;
  memberCount: number;
  /** Whom to ask: the admins' addresses. */
  admins: string[];
  /** Whether the person lets the team's admins see their projects. */
  adminsCanView: boolean;
}

/** And as its admins see it. */
export interface TeamAdminView extends TeamView {
  joinCode: string;
  joinOpen: boolean;
  seatPrice: number;
  currency: string;
  members: MemberRow[];
  invites: { email: string; role: TeamRole; invitedAt: number }[];
  payments: PaymentRow[];
}

/** Everything about one team, for its admins and the admin page. */
export async function teamDetail(db: Db, rawTeamId: unknown, now: number): Promise<Omit<TeamAdminView, "role" | "adminsCanView"> & { ownerEmail: string | null; createdAt: number; customSeatPrice: number | null }> {
  const teamId = cleanTeamId(rawTeamId);
  const [teamSnap, membersSnap, invitesSnap, paymentsSnap] = await Promise.all([
    teamRef(db, teamId).get(),
    db.collection(MEMBERS).where("teamId", "==", teamId).get(),
    db.collection(INVITES).where("teamId", "==", teamId).get(),
    db.collection(PAYMENTS).where("teamId", "==", teamId).get(),
  ]);
  if (!teamSnap.exists) throw new TeamError("No such team.", 404, "gone");
  const team = teamOf(teamId, teamSnap.data());
  const members: MemberRow[] = membersSnap.docs
    .map((d: any) => memberOf(d.id, d.data()))
    .map((m: MemberRecord) => ({ uid: m.uid, email: m.email, emailVerified: m.emailVerified, role: m.role, joinedAt: m.joinedAt, adminsCanView: m.adminsCanView }))
    .sort((a: MemberRow, b: MemberRow) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === "admin" ? -1 : 1));
  const standing = licenseStanding(team.paidUntil, now, team.paidFor);
  return {
    id: team.id,
    name: team.name,
    kind: team.kind,
    state: standing.state,
    paidUntil: team.paidUntil,
    graceUntil: standing.graceUntil,
    seats: team.seats,
    memberCount: team.memberCount,
    admins: members.filter((m) => m.role === "admin" && m.email).map((m) => m.email as string),
    joinCode: team.joinCode,
    joinOpen: team.joinOpen,
    seatPrice: seatPriceOf(team),
    customSeatPrice: team.seatPrice,
    currency: team.currency,
    members,
    invites: invitesSnap.docs.map((d: any) => inviteOf(d.data())).sort((a: InviteRow, b: InviteRow) => a.invitedAt - b.invitedAt)
      .map((i: InviteRow) => ({ email: i.email, role: i.role, invitedAt: i.invitedAt })),
    payments: paymentsSnap.docs.map((d: any) => paymentOf(d.id, d.data())).sort((a: PaymentRow, b: PaymentRow) => b.paidAt - a.paidAt),
    ownerEmail: team.ownerEmail,
    createdAt: team.createdAt,
  };
}

/** An invitation to the person's address, waiting for them to accept it; `state` and `full` say if it can't be yet. */
export interface WaitingInvite {
  teamId: string;
  teamName: string;
  role: TeamRole;
  state: LicenseState;
  /** Every seat is taken: it can be accepted once the team has a free one. */
  full: boolean;
}

/** An invitation as the person's Team page and the app show it. */
const waitingInvite = (inv: InviteRow, team: TeamRecord, now: number): WaitingInvite => ({
  teamId: inv.teamId,
  teamName: team.name,
  role: inv.role,
  state: licenseStanding(team.paidUntil, now, team.paidFor).state,
  full: team.memberCount >= team.seats,
});

/** The /team page: the person's team (and as an admin sees it, if they are one), and invitations waiting. */
export async function teamPage(db: Db, who: Who, now: number): Promise<{ team: TeamView | TeamAdminView | null; invites: WaitingInvite[]; verified: boolean }> {
  const mine = await memberRef(db, who.uid).get();
  const email = who.emailVerified && who.email ? who.email.trim().toLowerCase() : null;
  const waiting = email ? await invitesFor(db, email) : [];
  const invites: WaitingInvite[] = [];
  for (const inv of waiting.slice(0, 10)) {
    const t = await teamRef(db, inv.teamId).get();
    // A team that's gone: its invitation is cleared.
    if (!t.exists) { await inviteRef(db, inv.teamId, email!).delete().catch(() => {}); continue; }
    invites.push(waitingInvite(inv, teamOf(inv.teamId, t.data()), now));
  }
  if (!mine.exists) return { team: null, invites, verified: who.emailVerified };
  const me = memberOf(who.uid, mine.data());
  let detail;
  try {
    detail = await teamDetail(db, me.teamId, now);
  } catch (err) {
    if (err instanceof TeamError && err.reason === "gone") return { team: null, invites, verified: who.emailVerified };
    throw err;
  }
  const view: TeamView = {
    id: detail.id, name: detail.name, kind: detail.kind, role: me.role, state: detail.state, paidUntil: detail.paidUntil,
    graceUntil: detail.graceUntil, seats: detail.seats, memberCount: detail.memberCount, admins: detail.admins,
    adminsCanView: me.adminsCanView,
  };
  if (me.role !== "admin") return { team: view, invites, verified: who.emailVerified };
  const { ownerEmail: _o, createdAt: _c, customSeatPrice: _p, ...rest } = detail;
  return { team: { ...rest, role: me.role, adminsCanView: me.adminsCanView }, invites, verified: who.emailVerified };
}

/** What the app's status shows about the person's team: enough for the grace banner. */
export interface TeamStatus {
  id: string;
  name: string;
  kind: TeamKind;
  role: TeamRole;
  state: LicenseState;
  paidUntil: number | null;
  /** What it was paid for last: its grace days (2 after a month, 30 after a year). */
  paidFor: TeamPeriod | null;
  graceUntil: number | null;
}

/**
 * The person's team for the app's status. The membership record decides: an
 * account whose teamId points at a team it isn't on is corrected. (An
 * invitation is never taken up here: the person accepts it themselves.)
 */
export async function teamForStatus(db: Db, who: Who, doc: Pick<UserQuotaDoc, "teamId">, now: number): Promise<TeamStatus | null> {
  const teamId = doc.teamId;
  if (!teamId) return null;
  const [memberSnap, teamSnap] = await Promise.all([memberRef(db, who.uid).get(), teamRef(db, teamId).get()]);
  const member = memberSnap.exists ? memberOf(who.uid, memberSnap.data()) : null;
  if (!member || member.teamId !== teamId) {
    await userRef(db, who.uid).set({ teamId: member ? member.teamId : null }, { merge: true });
    return null;
  }
  if (!teamSnap.exists) return null;
  const team = teamOf(teamId, teamSnap.data());
  const standing = licenseStanding(team.paidUntil, now, team.paidFor);
  return { id: team.id, name: team.name, kind: team.kind, role: member.role, state: standing.state, paidUntil: team.paidUntil, paidFor: team.paidFor, graceUntil: standing.graceUntil };
}

export interface TeamSummary {
  id: string;
  name: string;
  kind: TeamKind;
  state: LicenseState;
  paidUntil: number | null;
  graceUntil: number | null;
  seats: number;
  memberCount: number;
  seatPrice: number;
  customSeatPrice: number | null;
  currency: string;
  ownerEmail: string | null;
  createdAt: number;
}

/** Every team, newest first, for the admin page. */
export async function listTeams(db: Db, now: number): Promise<TeamSummary[]> {
  const snap = await db.collection(TEAMS).get();
  return snap.docs
    .map((d: any) => {
      const t = teamOf(d.id, d.data());
      const s = licenseStanding(t.paidUntil, now, t.paidFor);
      return {
        id: t.id, name: t.name, kind: t.kind, state: s.state, paidUntil: t.paidUntil, graceUntil: s.graceUntil,
        seats: t.seats, memberCount: t.memberCount, seatPrice: seatPriceOf(t), customSeatPrice: t.seatPrice,
        currency: t.currency, ownerEmail: t.ownerEmail, createdAt: t.createdAt,
      };
    })
    .sort((a: TeamSummary, b: TeamSummary) => b.createdAt - a.createdAt);
}

/** Every team's paid-until date and what it was paid for (its grace days), for the admin page's plan column. */
export async function teamLicenseMap(db: Db): Promise<Map<string, { paidUntil: number | null; paidFor: TeamPeriod | null }>> {
  const snap = await db.collection(TEAMS).select("paidUntil", "paidFor").get();
  const map = new Map<string, { paidUntil: number | null; paidFor: TeamPeriod | null }>();
  for (const d of snap.docs) {
    const paidFor = d.get("paidFor");
    map.set(d.id, { paidUntil: time(d.get("paidUntil")), paidFor: isPeriod(paidFor) ? paidFor : null });
  }
  return map;
}

// Every team action is cheap to try and costs database reads and writes, so
// each is limited per account, an hour at a time: far above what a person
// does, well below what a script could.
const tries = new Map<string, { count: number; start: number }>();
const TRY_WINDOW_MS = 60 * 60 * 1000;

function tooMany(key: string, max: number, now: number): boolean {
  const e = tries.get(key);
  if (!e || now - e.start > TRY_WINDOW_MS) {
    tries.set(key, { count: 1, start: now });
    // Never grows without end: the oldest entry goes first.
    if (tries.size > 20000) tries.delete(tries.keys().next().value as string);
    return false;
  }
  e.count += 1;
  return e.count > max;
}

function sendError(res: express.Response, err: unknown, what: string) {
  if (err instanceof TeamError) return res.status(err.status).json({ error: err.message });
  console.error(`[Teams] ${what} failed:`, (err as any)?.message || err);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

const whoOf = (req: express.Request): Who => ({ uid: req.uid!, email: req.email ?? null, emailVerified: req.emailVerified === true });

export interface TeamRouteDeps {
  /** Paystack's public key, to open the checkout; null when payments aren't set up. */
  paystackPublicKey: () => string | null;
}

/**
 * Teams paid before what a license is paid for was kept (paidFor) read as
 * paid for a month: 2 grace days. Once at start, each such team takes it
 * from its latest renewal, online or by invoice (a year from 12 months,
 * else a month), so one that paid for a year keeps its 30 days. A team
 * with no payment recorded stays as it is. The number of teams updated.
 */
export async function backfillPaidFor(db: Db): Promise<number> {
  const teams = await db.collection(TEAMS).get();
  let updated = 0;
  for (const d of teams.docs) {
    const data = d.data() || {};
    if (isPeriod(data.paidFor) || time(data.paidUntil) === null) continue;
    const pays = await db.collection(PAYMENTS).where("teamId", "==", d.id).get();
    const renewals = pays.docs.map((p: any) => p.data() || {}).filter((p: any) => p.action !== "add_seats" && num(p.months) > 0);
    if (!renewals.length) continue;
    const latest = renewals.reduce((a: any, b: any) => (num(b.paidAt) > num(a.paidAt) ? b : a));
    const paidFor: TeamPeriod = isPeriod(latest.period) ? latest.period : paidForMonths(num(latest.months, 1));
    const wrote = await db.runTransaction(async (tx: any) => {
      // A payment that came in meanwhile has set it already.
      const now = await tx.get(teamRef(db, d.id));
      const cur = now.exists ? now.data() || {} : {};
      if (!now.exists || isPeriod(cur.paidFor) || time(cur.paidUntil) === null) return false;
      tx.set(teamRef(db, d.id), { paidFor }, { merge: true });
      return true;
    });
    if (wrote) {
      forgetTeam(d.id);
      updated++;
    }
  }
  return updated;
}

export function registerTeamRoutes(app: express.Express, requireAdmin: express.RequestHandler, deps: TeamRouteDeps) {
  const ready = (res: express.Response) => {
    if (isFirebaseAdminConfigured()) return true;
    res.status(503).json({ error: "Accounts aren't configured on the server yet." });
    return false;
  };

  const limited = (res: express.Response, key: string, max: number) => {
    if (!tooMany(key, max, Date.now())) return false;
    res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    return true;
  };

  if (isFirebaseAdminConfigured()) {
    backfillPaidFor(adminDb)
      .then((n) => { if (n) console.log(`[Teams] Recorded what ${n} team license(s) were paid for, for their grace days.`); })
      .catch((err) => console.error("[Teams] Recording what licenses were paid for failed:", err?.message || err));
  }

  // ---- The /team page ----

  app.get("/api/team/me", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `me:${req.uid}`, 600)) return;
    res.setHeader("Cache-Control", "no-store");
    try {
      await getOrCreateUserDoc(req.uid!);
      const page = await teamPage(adminDb, whoOf(req), Date.now());
      res.json({
        ...page,
        prices: {
          seatPrice: DEFAULT_SEAT_PRICE,
          currency: DEFAULT_TEAM_CURRENCY,
          minSeats: MIN_SEATS,
          maxSeats: MAX_SEATS,
          periods: Object.fromEntries(Object.entries(PERIODS).map(([k, p]) => [k, { months: p.months, chargedMonths: p.chargedMonths, label: p.label }])),
        },
        payments: !!deps.paystackPublicKey(),
      });
    } catch (err) {
      sendError(res, err, "Loading a team");
    }
  });

  app.post("/api/team", requireFirebaseAuth, async (req, res) => {
    if (!ready(res)) return;
    const now = Date.now();
    if (tooMany(`create:${req.uid}`, 5, now)) return res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    try {
      await getOrCreateUserDoc(req.uid!);
      const body = req.body || {};
      const team = await createTeam(adminDb, whoOf(req), { name: body.name, kind: body.kind, seats: body.seats }, now);
      res.json({ ok: true, teamId: team.id });
    } catch (err) {
      sendError(res, err, "Starting a team");
    }
  });

  app.post("/api/team/join", requireFirebaseAuth, async (req, res) => {
    if (!ready(res)) return;
    const now = Date.now();
    if (tooMany(`join:${req.uid}`, 10, now)) return res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    try {
      await getOrCreateUserDoc(req.uid!);
      const team = await joinByCode(adminDb, whoOf(req), req.body?.code, now);
      res.json({ ok: true, teamId: team.id, name: team.name });
    } catch (err) {
      sendError(res, err, "Joining a team");
    }
  });

  app.post("/api/team/leave", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `leave:${req.uid}`, 30)) return;
    try {
      await leaveTeam(adminDb, req.uid!);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Leaving a team");
    }
  });

  app.post("/api/team/invites/accept", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `accept:${req.uid}`, 30)) return;
    try {
      await getOrCreateUserDoc(req.uid!);
      const team = await acceptInvite(adminDb, whoOf(req), req.body?.teamId, Date.now());
      forgetTeam(team.id);
      res.json({ ok: true, teamId: team.id, name: team.name });
    } catch (err) {
      sendError(res, err, "Accepting an invitation");
    }
  });

  app.post("/api/team/invites/decline", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `decline:${req.uid}`, 60)) return;
    try {
      await declineInvite(adminDb, whoOf(req), req.body?.teamId);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Declining an invitation");
    }
  });

  // ---- A team's admins ----

  app.post("/api/team/settings", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `settings:${req.uid}`, 60)) return;
    try {
      const body = req.body || {};
      await updateTeamSettings(adminDb, req.uid!, { name: body.name, joinOpen: body.joinOpen, newCode: body.newCode });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Changing a team");
    }
  });

  app.post("/api/team/invites", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `invite:${req.uid}`, 60)) return;
    try {
      res.json({ ok: true, ...(await inviteEmails(adminDb, req.uid!, req.body?.emails, Date.now())) });
    } catch (err) {
      sendError(res, err, "Inviting to a team");
    }
  });

  app.post("/api/team/invites/cancel", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `uninvite:${req.uid}`, 200)) return;
    try {
      await cancelInvite(adminDb, req.uid!, req.body?.email);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Withdrawing an invitation");
    }
  });

  app.post("/api/team/members/remove", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `remove:${req.uid}`, 200)) return;
    try {
      await removeMember(adminDb, req.uid!, req.body?.uid);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Removing a team member");
    }
  });

  app.post("/api/team/members/role", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `role:${req.uid}`, 200)) return;
    try {
      await setRole(adminDb, req.uid!, req.body?.uid, req.body?.role);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Changing a member's role");
    }
  });

  // The price to pay online, and what the checkout needs. The payment is
  // applied by /api/paystack/verify and the webhook (server/paystack.ts).
  app.post("/api/team/checkout", requireFirebaseAuth, async (req, res) => {
    if (!ready(res) || limited(res, `checkout:${req.uid}`, 30)) return;
    const publicKey = deps.paystackPublicKey();
    if (!publicKey) return res.status(503).json({ error: "Online payments aren't set up yet. Contact us to pay by invoice." });
    if (!req.email) return res.status(400).json({ error: "Your account needs an email address to pay online." });
    try {
      const body = req.body || {};
      const quote = await quoteFor(adminDb, req.uid!, { action: body.action, period: body.period, seats: body.seats, extra: body.extra }, Date.now());
      res.json({
        publicKey,
        email: req.email,
        amount: quote.amount,
        currency: quote.currency,
        seats: quote.seats,
        paidUntilAfter: quote.paidUntilAfter,
        metadata: { uid: req.uid, kind: TEAM_KIND, quoteId: quote.id, teamId: quote.teamId },
      });
    } catch (err) {
      sendError(res, err, "Pricing a team payment");
    }
  });

  // ---- Admin ----

  app.get("/api/admin/teams", requireAdmin, async (_req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ teams: await listTeams(adminDb, Date.now()), defaults: { seatPrice: DEFAULT_SEAT_PRICE, currency: DEFAULT_TEAM_CURRENCY, minSeats: MIN_SEATS } });
    } catch (err) {
      sendError(res, err, "Listing teams");
    }
  });

  app.post("/api/admin/teams", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      const team = await createTeam(adminDb, null, req.body || {}, Date.now());
      res.json({ team });
    } catch (err) {
      sendError(res, err, "Adding a team");
    }
  });

  app.get("/api/admin/teams/:id", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json(await teamDetail(adminDb, req.params.id, Date.now()));
    } catch (err) {
      sendError(res, err, "Loading a team");
    }
  });

  app.post("/api/admin/teams/:id", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ team: await adminUpdateTeam(adminDb, req.params.id, req.body || {}) });
    } catch (err) {
      sendError(res, err, "Changing a team");
    }
  });

  app.post("/api/admin/teams/:id/invoice", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json({ team: await recordInvoice(adminDb, req.params.id, req.body || {}, Date.now()) });
    } catch (err) {
      sendError(res, err, "Recording an invoice");
    }
  });

  app.post("/api/admin/teams/:id/invite", requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    try {
      res.json(await adminInvite(adminDb, req.params.id, req.body?.email, req.body?.role, Date.now()));
    } catch (err) {
      sendError(res, err, "Inviting to a team");
    }
  });
}
