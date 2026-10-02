/**
 * Team and school licenses, start to finish: prices and seats, starting a
 * team, joining by code and by invitation, paying online against the price
 * shown (counted once however often it's reported), invoices from the admin
 * page, the 7 grace days, PRO and its monthly allowance for members, and
 * leaving or being removed.
 *
 * Runs against an in-memory stand-in for Firestore with the calls the code
 * uses (documents, merges, deletes, simple queries, transactions).
 */
import {
  DEFAULT_SEAT_PRICE, DEFAULT_TEAM_CURRENCY, SEAT_PRICES, normalSeatPrice, MIN_SEATS, MAX_SEATS, GRACE_DAYS, graceMs, paidForMonths,
  PERIODS, TEAM_KIND, isPeriod,
  validSeats, renewalPrice, addSeatsPrice, renewedUntil, licenseStanding, teamGivesPro, emailList,
  newJoinCode, normalizeJoinCode, teamMonthKey, nextTeamMonthStart, addMonths,
} from "../server/teamRules.ts";
import {
  createTeam, joinByCode, acceptInvites, leaveTeam, removeMember, setRole, updateTeamSettings, inviteEmails,
  cancelInvite, declineInvite, quoteFor, applyTeamPayment, recordInvoice, adminUpdateTeam, adminInvite,
  teamDetail, teamPage, teamForStatus, listTeams, TeamError, inviteId, backfillPaidFor,
} from "../server/teams.ts";
import { readUserDoc, tierOf, allowanceFor, tokenUsagePatch, onTeamPro, PAID_TOKEN_CAP } from "../server/quota.ts";
import { planOf } from "../server/adminMetrics.ts";
import { TEAM_PRICES, PERIOD_MONTHS, teamSavings, teamMoney, lockOf, renewalPrice as shownRenewalPrice, addSeatsPrice as shownAddSeatsPrice } from "../src/lib/teams.ts";
import { PRO_PRICE, PRO_MONTHLY, formatMoney, nairaToDollars, showPrice, nairaNote } from "../src/lib/plans.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const throwsWith = async (fn, re, reason) => {
  try { await fn(); return false; } catch (e) { return e instanceof TeamError && re.test(e.message) && (reason === undefined || e.reason === reason); }
};

// ---- An in-memory Firestore ----
class Snap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this._d === undefined ? undefined : { ...this._d }; }
  get(f) { return this._d?.[f]; }
}
class DocRef {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; this.key = `${col}/${id}`; }
  _snap() { return new Snap(this, this.db.store.get(this.key)); }
  _write(data, opts) {
    const cur = this.db.store.get(this.key);
    this.db.store.set(this.key, opts?.merge && cur ? { ...cur, ...data } : { ...data });
  }
  _delete() { this.db.store.delete(this.key); }
  async get() { return this._snap(); }
  async set(data, opts) { this._write(data, opts); }
  async delete() { this._delete(); }
}
class Query {
  constructor(db, col, filters = []) { this.db = db; this.col = col; this.filters = filters; }
  where(field, op, value) {
    if (op !== "==") throw new Error("only == in the stand-in");
    return new Query(this.db, this.col, [...this.filters, [field, value]]);
  }
  _snap() {
    const docs = [];
    for (const [key, d] of this.db.store) {
      const at = key.indexOf("/");
      const col = key.slice(0, at);
      const id = key.slice(at + 1);
      if (col !== this.col) continue;
      if (this.filters.every(([f, v]) => d[f] === v)) docs.push(new Snap(new DocRef(this.db, col, id), d));
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }
  async get() { return this._snap(); }
}
class Col extends Query {
  doc(id) { return new DocRef(this.db, this.col, id ?? `auto${++this.db.auto}`); }
}
class FakeDb {
  constructor() { this.store = new Map(); this.auto = 0; }
  collection(name) { return new Col(this, name); }
  async runTransaction(fn) {
    const writes = [];
    let wrote = false;
    const tx = {
      get: async (r) => { if (wrote) throw new Error("a read after a write in a transaction"); return r._snap(); },
      set: (ref, data, opts) => { wrote = true; writes.push(() => ref._write(data, opts)); },
      delete: (ref) => { wrote = true; writes.push(() => ref._delete()); },
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  }
  doc(path) { const at = path.indexOf("/"); return new DocRef(this, path.slice(0, at), path.slice(at + 1)); }
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
// Joining codes from a fixed sequence, so tests are repeatable.
let seed = 0;
const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

console.log("Prices and seats");
check(DEFAULT_SEAT_PRICE === 664300 && DEFAULT_TEAM_CURRENCY === "NGN" && MIN_SEATS === 5, "new teams: ₦6,643 a seat a month, at least 5 seats");
check(Math.round(5 * 9300 / 7) * 100 === DEFAULT_SEAT_PRICE, "₦6,643 is $5 at ₦9,300 to $7 (PRO's own rate), to the naira");
check(SEAT_PRICES.USD === 500 && normalSeatPrice("USD") === 500 && normalSeatPrice("GHS") === null && normalSeatPrice("toString") === null,
  "teams priced in dollars before keep $5; other currencies have no normal price");
check(renewalPrice(5, 664300, "month") === 3321500 && renewalPrice(5, 664300, "year") === 36536500, "5 seats: ₦33,215 a month, ₦365,365 a year (12 months for 11)");
check(Object.keys(PERIODS).join() === "month,year" && PERIODS.month.months === 1 && PERIODS.month.chargedMonths === 1 && PERIODS.year.months === 12 && PERIODS.year.chargedMonths === 11,
  "a month, or a year charged as 11 months; no school term");
check(isPeriod("month") && isPeriod("year") && !isPeriod("term") && !isPeriod(undefined), "a period is a month or a year");
check(validSeats(5) === 5 && validSeats("30") === 30 && validSeats(4) === null && validSeats(MAX_SEATS + 1) === null && validSeats(5.5) === null && validSeats("x") === null,
  "seats: whole numbers from 5 to the most");
check(validSeats(6, 8) === null && validSeats(8, 8) === 8, "never fewer seats than the team has members");
check(addSeatsPrice(2, 500, NOW + 15 * DAY, NOW) === 500, "2 seats for the 15 days left: $5.00 (by the day)");
check(addSeatsPrice(1, 500, NOW + 3600000, NOW) === 17, "at least a day is charged");
check(addSeatsPrice(2, 500, null, NOW) === 0 && addSeatsPrice(2, 500, NOW - DAY, NOW) === 0 && addSeatsPrice(0, 500, NOW + DAY, NOW) === 0,
  "nothing to add for when nothing is paid");
check(renewedUntil(NOW + 10 * DAY, NOW, 1) === addMonths(NOW + 10 * DAY, 1), "renewing early carries on from the current end");
check(renewedUntil(NOW - 3 * DAY, NOW, 4) === addMonths(NOW, 4) && renewedUntil(null, NOW, 12) === addMonths(NOW, 12), "renewing late (or first) starts when paid");

console.log("What the /team page shows");
check(TEAM_PRICES.seatPrice === DEFAULT_SEAT_PRICE && TEAM_PRICES.currency === DEFAULT_TEAM_CURRENCY && TEAM_PRICES.minSeats === MIN_SEATS && TEAM_PRICES.maxSeats === MAX_SEATS,
  "the prices shown before signing in are the server's");
check(Object.keys(PERIOD_MONTHS).join() === Object.keys(PERIODS).join()
  && Object.keys(PERIODS).every((k) => PERIOD_MONTHS[k].months === PERIODS[k].months && PERIOD_MONTHS[k].chargedMonths === PERIODS[k].chargedMonths)
  && shownRenewalPrice(6, 500, "month") === renewalPrice(6, 500, "month") && shownRenewalPrice(6, 500, "year") === renewalPrice(6, 500, "year"),
  "and its month and year prices are the server's");
check(PRO_MONTHLY.kobo === 930000 && PRO_MONTHLY.cents === 700 && PRO_PRICE === `$${PRO_MONTHLY.cents / 100}/month`,
  "PRO on your own: the $7 the app lists, ₦9,300 a month on Paystack");

console.log("Prices shown in dollars, charged in naira");
const usd = (c) => formatMoney(c, "USD");
check(nairaToDollars(930000) === 700 && nairaToDollars(8928000) === 6720 && nairaToDollars(744000) === 560 && nairaToDollars(664300) === 500,
  "₦9,300 is $7; the yearly ₦89,280 is $67.20; the first month at 20% off, ₦7,440, is $5.60; a ₦6,643 seat is $5");
check(showPrice(930000, "NGN") === usd(700) && showPrice(930000, "ngn") === usd(700) && showPrice(700, "USD") === usd(700) && showPrice(400000, "GHS") === formatMoney(400000, "GHS"),
  "a naira price shows in dollars; a dollar price as it is; another currency as it is");
check(nairaNote(930000, "NGN", "a month") === `Charged in naira at checkout: ${formatMoney(930000, "NGN")} a month.` && nairaNote(700, "USD") === null,
  "the line under a pay button says the naira Paystack charges (none for a price in dollars)");
const m = teamMoney(664300, "NGN");
const exact = [];
for (let seats = 5; seats <= 2000; seats++) for (const p of ["month", "year"]) {
  if (m.show(shownRenewalPrice(seats, 664300, p)) !== usd(shownRenewalPrice(seats, 500, p))) exact.push(`${seats}/${p}`);
}
check(m.seat === 500 && m.currency === "USD" && m.show(664300) === usd(500) && exact.length === 0,
  "a team: $5 a seat, and every month or year total from 5 to 2,000 seats exactly $5 a seat (6 seats for a year: $330, not $330.01)", exact.slice(0, 5).join(" "));
check(m.naira(shownRenewalPrice(6, 664300, "month")) === formatMoney(3985800, "NGN") && m.naira(shownRenewalPrice(6, 664300, "year")) === formatMoney(43843800, "NGN"),
  "and what Paystack charges: ₦39,858 for 6 seats a month, ₦438,438 for a year");
const extraNaira = shownAddSeatsPrice(2, 664300, NOW + 10 * DAY, NOW);
check(m.show(extraNaira) === usd(Math.round((extraNaira * 500) / 664300)), "added seats for the days left: the naira price in proportion to the seat");
const dollarTeam = teamMoney(500, "USD");
check(dollarTeam.show(3000) === usd(3000) && dollarTeam.naira(3000) === null && teamMoney(400000, "GHS").show(400000) === formatMoney(400000, "GHS"),
  "a team priced in dollars (or with a special price in another currency): as it is, with no naira line");
const saved = teamSavings(5, m.seat, m.currency, [null, { amount: PRO_MONTHLY.cents, currency: "USD" }]);
check(saved?.pro === 700 && saved.perSeat === 200 && saved.teamPays === 2500 && saved.onTheirOwn === 3500 && saved.saved === 1000,
  "5 seats: $5 each instead of $7, $25 a month instead of $35: $10 saved");
check(teamSavings(5, 500, "USD", [{ amount: nairaToDollars(1000000), currency: "USD" }, { amount: 700, currency: "USD" }])?.pro === 753, "PRO's price from Paystack counts (in dollars: ₦10,000 is $7.53) when it can be read");
check(teamSavings(5, 500, "USD", [{ amount: 800, currency: "GHS" }, { amount: 700, currency: "USD" }])?.pro === 700, "in another currency, the listed $7 counts");
check(teamSavings(5, 700, "USD", [null, { amount: 700, currency: "USD" }]) === null && teamSavings(5, 400000, "GHS", [null, { amount: 700, currency: "USD" }]) === null,
  "nothing shown when a seat costs no less, or the prices can't be compared");
check(lockOf("unpaid") === "unpaid" && lockOf("ended") === "ended" && lockOf("active") === null && lockOf("grace") === null,
  "the join link, invitations and team projects: locked before the first payment and after a license ends; open while paid or in grace");

console.log("The license's standing and the grace days");
check(licenseStanding(null, NOW).state === "unpaid" && !teamGivesPro(null, NOW), "unpaid: no PRO");
const paid = licenseStanding(NOW + DAY, NOW, "month");
check(paid.state === "active" && paid.graceUntil === NOW + 3 * DAY && GRACE_DAYS.month === 2 && graceMs("month") === 2 * DAY, "paid for a month: active, with 2 grace days after it ends");
check(licenseStanding(NOW - DAY, NOW, "month").state === "grace" && teamGivesPro(NOW - DAY, NOW, "month"), "a month that ended yesterday: in grace, still PRO");
check(licenseStanding(NOW - 2 * DAY, NOW, "month").state === "ended" && !teamGivesPro(NOW - 2 * DAY, NOW, "month"), "2 days after a month ended: PRO ends");
check(licenseStanding(NOW - 29 * DAY, NOW, "year").state === "grace" && teamGivesPro(NOW - 29 * DAY, NOW, "year") && GRACE_DAYS.year === 30, "a year that ended 29 days ago: still in grace");
check(licenseStanding(NOW - 30 * DAY, NOW, "year").state === "ended" && !teamGivesPro(NOW - 30 * DAY, NOW, "year"), "30 days after a year ended: PRO ends");
check(graceMs(null) === 2 * DAY && licenseStanding(NOW - 2 * DAY, NOW).state === "ended", "no record of what it was paid for (paid before this was kept): as a month");
check(paidForMonths(1) === "month" && paidForMonths(6) === "month" && paidForMonths(12) === "year" && paidForMonths(24) === "year", "an invoice for 12 months or more counts as a year; fewer, as a month");

console.log("Join codes and email lists");
const code = newJoinCode(random);
check(/^[A-HJ-KM-NP-Z2-9]{8}$/.test(code) && normalizeJoinCode(code.toLowerCase()) === code, "a code: 8 easy-to-read characters, any case");
check(normalizeJoinCode("ABCDEFG0") === null && normalizeJoinCode("ABCDEFGO") === null && normalizeJoinCode("ABCDEFG1") === null && normalizeJoinCode(12345678) === null,
  "never 0, O, 1, I or L");
const list = emailList("Ada@X.com, ada@x.com; ben@y.org\nnot-an-email  chi@z.ng");
check(JSON.stringify(list.emails) === JSON.stringify(["ada@x.com", "ben@y.org", "chi@z.ng"]) && JSON.stringify(list.invalid) === JSON.stringify(["not-an-email"]),
  "pasted addresses: lower case, each once, the bad ones listed");
check(teamMonthKey(Date.UTC(2026, 0, 31)) + 1 === teamMonthKey(Date.UTC(2026, 1, 1)) && nextTeamMonthStart(Date.UTC(2026, 11, 15)) === Date.UTC(2027, 0, 1),
  "the allowance runs by calendar month");

console.log("PRO and its allowance for members");
const member = (fields) => ({ ...readUserDoc({ teamId: "t1", ...fields }), teamPaidUntil: fields.teamPaidUntil ?? null, teamPaidFor: fields.teamPaidFor ?? null });
check(readUserDoc({ teamId: "t1", teamPaidUntil: NOW + DAY, teamPaidFor: "year" }).teamPaidUntil === null && readUserDoc({ teamPaidFor: "year" }).teamPaidFor === null,
  "the paid-until date and what it was for are never read from the account itself");
check(tierOf(member({ teamPaidUntil: NOW + DAY }), "none", NOW) === "pro", "a member of a paid team has PRO");
check(tierOf(member({ teamPaidUntil: NOW - DAY, teamPaidFor: "month" }), "none", NOW) === "pro" && tierOf(member({ teamPaidUntil: NOW - 20 * DAY, teamPaidFor: "year" }), "none", NOW) === "pro",
  "and during the grace days (2 after a month, 30 after a year)");
check(tierOf(member({ teamPaidUntil: NOW - 2 * DAY, teamPaidFor: "month" }), "none", NOW) === "free" && tierOf(member({ teamPaidUntil: NOW - 30 * DAY, teamPaidFor: "year" }), "none", NOW) === "free"
  && tierOf(member({}), "none", NOW) === "free", "not after them, nor while unpaid");
check(!onTeamPro({ teamId: null, teamPaidUntil: NOW + DAY }, NOW), "no team, no team PRO");
const fresh = allowanceFor(member({ teamPaidUntil: NOW + DAY }), "pro", NOW);
check(fresh.cycleCap === PAID_TOKEN_CAP && fresh.cycleUsed === 0 && !fresh.blocked, "the same monthly allowance as a PRO subscriber");
const spent = member({ teamPaidUntil: NOW + DAY, teamMonth: teamMonthKey(NOW), teamMonthTokens: PAID_TOKEN_CAP });
const spentAllowance = allowanceFor(spent, "pro", NOW);
check(spentAllowance.blocked && spentAllowance.reason === "cycle" && spentAllowance.resetAt === nextTeamMonthStart(NOW), "used up: paused until the 1st of next month");
check(!allowanceFor({ ...spent, teamMonth: teamMonthKey(NOW) - 1 }, "pro", NOW).blocked, "last month's use doesn't count");
const patch = tokenUsagePatch(member({ teamPaidUntil: NOW + DAY, teamMonth: teamMonthKey(NOW) - 1, teamMonthTokens: 999 }), { tier: "pro", subscriptionStatus: "none" }, 100, NOW);
check(patch.teamMonth === teamMonthKey(NOW) && patch.teamMonthTokens === 100 && patch.cycleTokensUsed === undefined, "use is counted against this month, from zero");
const subscriber = { ...member({ teamPaidUntil: NOW + DAY }), subscriptionStatus: "active", cycleTokensUsed: 10 };
const subPatch = tokenUsagePatch(subscriber, { tier: "pro", subscriptionStatus: "active" }, 100, NOW);
check(subPatch.cycleTokensUsed === 110 && subPatch.teamMonthTokens === undefined, "someone also paying for PRO themself uses their own allowance");

const lists = { ownerEmails: [], proAccessEmails: ["granted@x.com"], earlyAccessEmails: [] };
const someone = { email: "m@x.com", verified: true };
check(planOf(someone, { teamId: "t1", teamPaidUntil: NOW + DAY }, lists, NOW) === "team" && planOf(someone, { teamId: "t1", teamPaidUntil: NOW - 8 * DAY }, lists, NOW) === "free",
  "the admin page shows team members as Team PRO, and Free once the grace days are over");
check(planOf({ email: "granted@x.com", verified: true }, { teamId: "t1", teamPaidUntil: NOW + DAY }, lists, NOW) === "granted"
  && planOf(someone, { teamId: "t1", teamPaidUntil: NOW + DAY, subscriptionStatus: "active" }, lists, NOW) === "pro",
  "paying or granted PRO is shown as that");

console.log("Starting a team");
const db = new FakeDb();
const ada = { uid: "ada", email: "Ada@School.ng", emailVerified: true };
const ben = { uid: "ben", email: "ben@school.ng", emailVerified: true };
const chi = { uid: "chi", email: "chi@school.ng", emailVerified: true };
const dee = { uid: "dee", email: "dee@school.ng", emailVerified: false };
for (const p of [ada, ben, chi, dee]) await db.doc(`users/${p.uid}`).set({ subscriptionStatus: "none" });
check(await throwsWith(() => createTeam(db, ada, { name: "Lagos Robotics", seats: 4 }, NOW, random), /5 to 2000 seats/), "fewer than 5 seats is refused");
check(await throwsWith(() => createTeam(db, ada, { name: " ", seats: 5 }, NOW, random), /name/), "a team needs a name");
const team = await createTeam(db, ada, { name: "  Lagos   Robotics ", kind: "school", seats: 5, seatPrice: 1, currency: "NGN" }, NOW, random);
check(team.name === "Lagos Robotics" && team.kind === "school" && team.seats === 5 && team.paidUntil === null && team.memberCount === 1,
  "started: unpaid, 5 seats, its maker on it");
check(team.seatPrice === null && team.currency === "NGN", "at the normal price, in naira: a special one is the admin page's to set");
check((await db.doc(`teamMembers/ada`).get()).data().role === "admin" && (await db.doc("users/ada").get()).data().teamId === team.id, "its maker is its admin");
check(normalizeJoinCode(team.joinCode) === team.joinCode, "it has a join code");
check(await throwsWith(() => createTeam(db, ada, { name: "Second", seats: 5 }, NOW, random), /already on a team/, "on_team"), "one team per account");

console.log("Joining and invitations: only while the license is paid");
const license = (paidUntil, paidFor = null) => db.doc(`teams/${team.id}`).set({ paidUntil, paidFor }, { merge: true });
check(await throwsWith(() => joinByCode(db, ben, team.joinCode, NOW), /license isn't paid yet, so nobody can join it\. Ask its admin to pay for it first\./, "unpaid"), "nobody joins by code before the first payment");
check(await throwsWith(() => inviteEmails(db, "ada", "chi@school.ng", NOW), /^Pay for the license first\. Then you can invite people\.$/, "unpaid"), "nor is anyone invited");
await license(NOW - 3 * DAY, "month");
check(await throwsWith(() => joinByCode(db, ben, team.joinCode, NOW), /license has ended, so nobody can join it until it's renewed/, "unpaid")
  && await throwsWith(() => inviteEmails(db, "ada", "chi@school.ng", NOW), /^The license has ended\. Renew it first, then invite people\.$/, "unpaid"),
  "nor once a license has ended, until it's renewed");
check(!(await db.doc("teamMembers/ben").get()).exists && (await db.doc(`teams/${team.id}`).get()).data().memberCount === 1, "nothing changed");
// In its grace days (1 day after a month ended): open, as below.
await license(NOW - DAY, "month");

console.log("Joining by code");
check(await throwsWith(() => joinByCode(db, ben, "ZZZZZZZZ", NOW), /isn't valid/), "an unknown code is refused");
check(await throwsWith(() => joinByCode(db, ben, "nope", NOW), /8 letters/), "a malformed code is refused");
const joined = await joinByCode(db, ben, team.joinCode.toLowerCase(), NOW);
check(joined.id === team.id && (await db.doc(`teams/${team.id}`).get()).data().memberCount === 2, "Ben joins: 2 members");
check((await db.doc("teamMembers/ben").get()).data().role === "member" && (await db.doc("users/ben").get()).data().teamId === team.id, "as a member");
check(await throwsWith(() => joinByCode(db, ben, team.joinCode, NOW), /already on this team/, "on_team"), "joining twice is refused");
await updateTeamSettings(db, "ada", { joinOpen: false });
check(await throwsWith(() => joinByCode(db, chi, team.joinCode, NOW), /switched off/), "not while joining by code is off");
check(await throwsWith(() => updateTeamSettings(db, "ben", { joinOpen: true }), /Only the team's admins/, "not_admin"), "only an admin changes that");
await updateTeamSettings(db, "ada", { joinOpen: true });
const renamed = await updateTeamSettings(db, "ada", { newCode: true, name: "Lagos Robotics Club" }, random);
check(renamed.joinCode !== team.joinCode && renamed.name === "Lagos Robotics Club", "a new code and name");
check(await throwsWith(() => joinByCode(db, chi, team.joinCode, NOW), /isn't valid/), "the old code stops working");

console.log("Invitations");
const inv = await inviteEmails(db, "ada", "chi@school.ng, CHI@school.ng; dee@school.ng bad-address ben@school.ng", NOW);
check(JSON.stringify(inv.invited) === JSON.stringify(["chi@school.ng", "dee@school.ng"]) && JSON.stringify(inv.already) === JSON.stringify(["ben@school.ng"]) && inv.invalid[0] === "bad-address",
  "pasted list: new addresses invited, members skipped, bad ones listed");
check(await throwsWith(() => inviteEmails(db, "ada", "e1@x.com e2@x.com", NOW), /1 seat is free/, "full"), "never more invitations than free seats");
check(await throwsWith(() => inviteEmails(db, "ben", "e1@x.com", NOW), /Only the team's admins/), "only admins invite");
check(await throwsWith(() => inviteEmails(db, "ada", "", NOW), /at least one/), "an empty list is refused");
check((await acceptInvites(db, dee, NOW)) === null && !(await db.doc("teamMembers/dee").get()).exists, "an unverified address isn't joined");
const chiTeam = await acceptInvites(db, chi, NOW);
check(chiTeam?.id === team.id && (await db.doc(`teams/${team.id}`).get()).data().memberCount === 3, "Chi opens the app: joined, 3 members");
check(!(await db.doc(`teamInvites/${inviteId(team.id, "chi@school.ng")}`).get()).exists, "the invitation is used up");
await cancelInvite(db, "ada", "dee@school.ng");
check(!(await db.doc(`teamInvites/${inviteId(team.id, "dee@school.ng")}`).get()).exists, "an invitation can be withdrawn");
check(await throwsWith(() => cancelInvite(db, "ada", "dee@school.ng"), /isn't invited/), "and only once");
const eve = { uid: "eve", email: "eve@school.ng", emailVerified: true };
await db.doc("users/eve").set({ subscriptionStatus: "none" });
await inviteEmails(db, "ada", "eve@school.ng", NOW);
await license(NOW - 3 * DAY, "month");
check((await acceptInvites(db, eve, NOW)) === null && (await db.doc(`teamInvites/${inviteId(team.id, "eve@school.ng")}`).get()).exists && !(await db.doc("teamMembers/eve").get()).exists,
  "an invitation to a team whose license has ended waits, kept, until it's renewed");
const evePage = await teamPage(db, eve, NOW);
check(evePage.team === null && evePage.invites.length === 1 && evePage.invites[0].teamId === team.id && evePage.invites[0].state === "ended",
  "and Eve's Team page says what it waits for");
await license(NOW - DAY, "month");
check((await teamPage(db, eve, NOW)).team?.id === team.id, "renewed (here, back in its grace days): she's on the team");
await leaveTeam(db, "eve");
// Unpaid again, for paying for it below.
await license(null);

console.log("Paying online");
check(await throwsWith(() => quoteFor(db, "ben", { action: "renew", period: "month" }, NOW), /Only the team's admins/), "only an admin pays");
check(await throwsWith(() => quoteFor(db, "ada", { action: "renew", period: "term" }, NOW), /a month or a year/), "a school term can't be bought (a page from before still open)");
check(await throwsWith(() => quoteFor(db, "ada", { action: "renew", period: "week" }, NOW), /a month or a year/), "nor anything else");
const yearQuote = await quoteFor(db, "ada", { action: "renew", period: "year", seats: 6 }, NOW);
check(yearQuote.amount === 43843800 && yearQuote.currency === "NGN" && yearQuote.months === 12 && yearQuote.paidUntilAfter === addMonths(NOW, 12), "a year for 6 seats: ₦438,438 (11 months), paid for 12 months");
check(await throwsWith(() => quoteFor(db, "ada", { action: "renew", period: "month", seats: 2 }, NOW), /5 to 2000 seats/), "never fewer than 5 seats");
check(await throwsWith(() => quoteFor(db, "ada", { action: "add_seats", extra: 2 }, NOW), /while the license is paid/), "seats are added to a paid license only");
const quote = await quoteFor(db, "ada", { action: "renew", period: "month", seats: 6 }, NOW);
check(quote.amount === 3985800 && quote.currency === "NGN" && quote.seats === 6 && quote.months === 1 && quote.paidUntilAfter === addMonths(NOW, 1), "a month for 6 seats: ₦39,858, paid for 1 month");
const payment = (over = {}) => ({
  reference: "T-1", amount: 3985800, currency: "NGN", paid_at: new Date(NOW + 60000).toISOString(),
  customer: { email: "ada@school.ng" }, metadata: { uid: "ada", kind: TEAM_KIND, quoteId: quote.id }, ...over,
});
check(await throwsWith(() => applyTeamPayment(db, "ben", payment(), NOW), /doesn't belong/), "someone else's payment is refused");
check(await throwsWith(() => applyTeamPayment(db, "ada", payment({ amount: 3985799 }), NOW), /less than the price/), "less than the price is refused");
check(await throwsWith(() => applyTeamPayment(db, "ada", payment({ currency: "USD" }), NOW), /wrong currency/), "another currency is refused");
check(await throwsWith(() => applyTeamPayment(db, "ada", payment({ metadata: { uid: "ada", kind: TEAM_KIND, quoteId: "nope" } }), NOW), /couldn't find the price/), "an unknown price is refused");
const applied = await applyTeamPayment(db, "ada", payment(), NOW);
const paidUntil = addMonths(NOW + 60000, 1);
check(applied.applied && applied.paidUntil === paidUntil && applied.seats === 6, "paid: a month from the payment, 6 seats");
check((await db.doc(`teams/${team.id}`).get()).data().paidFor === "month", "kept: it was paid for a month (its grace days follow)");
const again = await applyTeamPayment(db, "ada", payment(), NOW);
check(again.already && !again.applied && again.paidUntil === paidUntil, "reported again (the app's check and the webhook): counted once");
check(await throwsWith(() => applyTeamPayment(db, "ada", payment({ reference: "T-2" }), NOW), /paid already/), "one price can't be paid for twice");
const rows = (await teamDetail(db, team.id, NOW)).payments;
check(rows.length === 1 && rows[0].kind === "online" && rows[0].amount === 3985800 && rows[0].period === "month" && rows[0].months === 1, "the payment is listed");

console.log("Members have PRO");
const benDoc = { ...readUserDoc((await db.doc("users/ben").get()).data()), teamPaidUntil: paidUntil, teamPaidFor: "month" };
check(tierOf(benDoc, "none", NOW + DAY) === "pro", "Ben has PRO while it's paid");
check(tierOf(benDoc, "none", paidUntil + 2 * DAY - 1) === "pro" && tierOf(benDoc, "none", paidUntil + 2 * DAY) === "free", "for 2 days after a month ends, then Free");
check(tierOf({ ...benDoc, teamPaidFor: "year" }, "none", paidUntil + 29 * DAY) === "pro" && tierOf({ ...benDoc, teamPaidFor: "year" }, "none", paidUntil + 30 * DAY) === "free", "for 30 days after a year ends");
check(onTeamPro({ teamId: team.id, teamPaidUntil: paidUntil, teamPaidFor: null }, paidUntil + DAY) && !onTeamPro({ teamId: team.id, teamPaidUntil: paidUntil, teamPaidFor: null }, paidUntil + 2 * DAY), "paid before this was kept: as a month");
const status = await teamForStatus(db, ben, { teamId: team.id }, NOW + DAY);
check(status?.state === "active" && status.role === "member" && status.graceUntil === paidUntil + 2 * DAY, "the app's status shows the license and when PRO ends");
const graceStatus = await teamForStatus(db, ben, { teamId: team.id }, paidUntil + DAY);
check(graceStatus?.state === "grace", "and shows the grace days once it has ended");

console.log("Adding seats part-way");
const addQuote = await quoteFor(db, "ada", { action: "add_seats", extra: 2 }, NOW + DAY);
check(addQuote.amount === addSeatsPrice(2, 664300, paidUntil, NOW + DAY) && addQuote.seats === 8 && addQuote.months === 0, "2 seats for the days left");
const added = await applyTeamPayment(db, "ada", { ...payment({ reference: "T-3", amount: addQuote.amount }), metadata: { uid: "ada", kind: TEAM_KIND, quoteId: addQuote.id } }, NOW + DAY);
check(added.seats === 8 && added.paidUntil === paidUntil, "8 seats, the same end date");

console.log("Roles, leaving and removing");
check(await throwsWith(() => leaveTeam(db, "ada"), /another member an admin/), "the last admin can't leave while others are on it");
check(await throwsWith(() => setRole(db, "ada", "ada", "member"), /Another admin/), "nobody changes their own role");
check(await throwsWith(() => setRole(db, "ben", "chi", "admin"), /Only the team's admins/), "a member can't make admins");
await setRole(db, "ada", "ben", "admin");
check((await db.doc("teamMembers/ben").get()).data().role === "admin", "Ben is made an admin");
await leaveTeam(db, "ada");
check(!(await db.doc("teamMembers/ada").get()).exists && (await db.doc("users/ada").get()).data().teamId === null && (await db.doc(`teams/${team.id}`).get()).data().memberCount === 2,
  "Ada leaves: off the team, 2 members");
check(await throwsWith(() => removeMember(db, "ben", "ada"), /isn't on your team/), "someone not on the team can't be removed");
check(await throwsWith(() => removeMember(db, "ben", "ben"), /Leave team/), "nor yourself");
await removeMember(db, "ben", "chi");
const chiDoc = readUserDoc((await db.doc("users/chi").get()).data());
check(chiDoc.teamId === null && tierOf({ ...chiDoc, teamPaidUntil: paidUntil }, "none", NOW + DAY) === "free", "Chi is removed: back on Free");
check((await teamForStatus(db, chi, { teamId: team.id }, NOW)) === null && (await db.doc("users/chi").get()).data().teamId === null,
  "an account pointing at a team it isn't on is corrected");

console.log("Teams from the admin page, paid by invoice");
const school = await createTeam(db, null, { name: "Kings College", kind: "school", seats: 40, seatPrice: "30000", currency: "ngn", ownerEmail: "Head@Kings.edu.ng" }, NOW, random);
check(school.seatPrice === 30000 && school.currency === "NGN" && school.memberCount === 0 && school.ownerEmail === "head@kings.edu.ng", "a school at a special price: ₦300 a seat");
check(await throwsWith(() => createTeam(db, null, { name: "No owner", seats: 5 }, NOW, random), /email/), "it needs its admin's address");
const head = { uid: "head", email: "head@kings.edu.ng", emailVerified: true };
await db.doc("users/head").set({ subscriptionStatus: "none" });
const headPage = await teamPage(db, head, NOW);
check(headPage.team?.id === school.id && headPage.team.role === "admin", "its admin signs in: joined as its admin");
check(Array.isArray(headPage.team.members) && headPage.team.joinCode === school.joinCode, "and sees the members and join code");
const benPage = await teamPage(db, ben, NOW + DAY);
check(benPage.team?.role === "admin", "Ben (now an admin) sees his team");
await joinByCode(db, dee, renamed.joinCode, NOW);
const deePage = await teamPage(db, dee, NOW + DAY);
check(deePage.team?.role === "member" && deePage.team.members === undefined && deePage.team.joinCode === undefined && deePage.team.admins.includes("ben@school.ng"),
  "a member sees the license and whom to ask, not the members or the code");
const invoiced = await recordInvoice(db, school.id, { months: 12, amount: 1200000, note: "Bank transfer, INV-7" }, NOW);
check(invoiced.paidUntil === addMonths(NOW, 12) && invoiced.seats === 40, "an invoice paid: a year");
check((await teamDetail(db, school.id, NOW)).payments[0].kind === "invoice", "listed as an invoice");
check(invoiced.paidFor === "year" && (await teamDetail(db, school.id, NOW)).graceUntil === invoiced.paidUntil + 30 * DAY, "an invoice for a year: 30 grace days after it");
const monthInvoice = await recordInvoice(db, school.id, { months: 1 }, NOW);
check(monthInvoice.paidFor === "month" && monthInvoice.paidUntil === addMonths(invoiced.paidUntil, 1) && (await teamDetail(db, school.id, NOW)).graceUntil === monthInvoice.paidUntil + 2 * DAY,
  "then one for a month: 2 grace days after it");
check(await throwsWith(() => recordInvoice(db, school.id, { months: 0 }, NOW), /1 to 36 months/), "an invoice pays for 1 to 36 months");
check(await throwsWith(() => adminUpdateTeam(db, team.id, { seats: 1 }), /5 to 2000 seats/), "seats can't go below 5");
const repriced = await adminUpdateTeam(db, school.id, { seatPrice: "", paidUntil: null });
check(repriced.seatPrice === null && repriced.paidUntil === null, "the special price and the paid date can be cleared");
check(await throwsWith(() => adminUpdateTeam(db, "bad/id", { name: "x y" }), /No such team/), "an odd team id is refused");
const adminInvited = await adminInvite(db, school.id, "deputy@kings.edu.ng", "admin", NOW);
check(adminInvited.invited[0] === "deputy@kings.edu.ng" && (await teamDetail(db, school.id, NOW)).invites[0].role === "admin", "the admin page can invite another admin");
const teams = await listTeams(db, NOW);
check(teams.length === 2 && teams.every((t) => typeof t.state === "string"), "every team is listed, with its standing");

console.log("Invitations that can't be taken up yet");
const small = await createTeam(db, null, { name: "Tiny Team", seats: 5, ownerEmail: "boss@tiny.io" }, NOW, random);
await db.doc(`teams/${small.id}`).set({ memberCount: 5 }, { merge: true });
const busy = { uid: "busy", email: "boss@tiny.io", emailVerified: true };
await db.doc("users/busy").set({ subscriptionStatus: "none" });
check((await acceptInvites(db, busy, NOW)) === null && (await db.doc(`teamInvites/${inviteId(small.id, "boss@tiny.io")}`).get()).exists, "for a full team: it waits for a seat");
await db.doc(`teams/${small.id}`).set({ memberCount: 0 }, { merge: true });
const page = await teamPage(db, busy, NOW);
check(page.team?.id === small.id, "and is taken up once there is one");
await db.doc(`teamInvites/${inviteId("gone", "lost@x.io")}`).set({ teamId: "gone", email: "lost@x.io", role: "member", invitedAt: NOW });
check((await acceptInvites(db, { uid: "lost", email: "lost@x.io", emailVerified: true }, NOW)) === null && !(await db.doc(`teamInvites/${inviteId("gone", "lost@x.io")}`).get()).exists,
  "one for a team that's gone is cleared");
await db.doc(`teamInvites/${inviteId(school.id, "nah@x.io")}`).set({ teamId: school.id, email: "nah@x.io", role: "member", invitedAt: NOW });
await declineInvite(db, { uid: "nah", email: "nah@x.io", emailVerified: true }, school.id);
check(!(await db.doc(`teamInvites/${inviteId(school.id, "nah@x.io")}`).get()).exists, "an invitation can be turned down");

console.log("Paid for a year online: 30 grace days");
const yan = { uid: "yan", email: "yan@school.ng", emailVerified: true };
await db.doc("users/yan").set({ subscriptionStatus: "none" });
const yTeam = await createTeam(db, yan, { name: "Yearly Club", seats: 5 }, NOW, random);
const yQuote = await quoteFor(db, "yan", { action: "renew", period: "year", seats: 5 }, NOW);
const yPaid = await applyTeamPayment(db, "yan", {
  reference: "Y-1", amount: yQuote.amount, currency: "NGN", paid_at: new Date(NOW).toISOString(),
  customer: { email: "yan@school.ng" }, metadata: { uid: "yan", kind: TEAM_KIND, quoteId: yQuote.id },
}, NOW);
const yStatus = await teamForStatus(db, yan, { teamId: yTeam.id }, NOW);
check(yQuote.amount === 36536500 && yPaid.paidUntil === addMonths(NOW, 12) && (await db.doc(`teams/${yTeam.id}`).get()).data().paidFor === "year" && yStatus?.graceUntil === yPaid.paidUntil + 30 * DAY,
  "5 seats for a year, ₦365,365: PRO for 30 days after it ends");

console.log("Other currencies need a special price");
check(await throwsWith(() => createTeam(db, null, { name: "Accra Coders", seats: 5, currency: "GHS", ownerEmail: "a@coders.gh" }, NOW, random), /^A team at the normal price pays in NGN\. To charge it in GHS, set a special price for it\.$/), "a team in cedis without a price is refused");
const accra = await createTeam(db, null, { name: "Accra Coders", seats: 5, currency: "GHS", seatPrice: "8000", ownerEmail: "a@coders.gh" }, NOW, random);
check(accra.currency === "GHS" && accra.seatPrice === 8000, "with a special price, it's made");
check(await throwsWith(() => adminUpdateTeam(db, accra.id, { seatPrice: "" }), /pays in NGN\. To charge it in GHS/), "and its price can't be cleared while it's in cedis");
check(await throwsWith(() => adminUpdateTeam(db, accra.id, { seatPrice: "", currency: "USD" }), /pays in NGN\. To charge it in USD/), "nor in dollars: the normal price is in naira, what Paystack takes");
const special = await adminUpdateTeam(db, accra.id, { seatPrice: "500", currency: "USD" });
check(special.currency === "USD" && special.seatPrice === 500, "dollars with a special price: as set");
const normal = await adminUpdateTeam(db, accra.id, { seatPrice: "", currency: "NGN" });
check(normal.currency === "NGN" && normal.seatPrice === null && (await db.doc(`teams/${accra.id}`).get()).data().currency === "NGN", "back to the normal price, in naira");

console.log("Teams paid before what a license is paid for was kept");
const put = (path, data) => db.doc(path).set(data);
await put("teams/oldYear", { name: "Paid a year", kind: "school", seats: 5, seatPrice: null, currency: "NGN", paidUntil: NOW + 200 * DAY, joinCode: "OLDY2345", memberCount: 1, createdAt: NOW - 165 * DAY });
await put("teamPayments/oy1", { teamId: "oldYear", kind: "online", action: "renew", period: "year", months: 12, seats: 5, amount: 1, currency: "NGN", paidAt: NOW - 165 * DAY });
await put("teamPayments/oy2", { teamId: "oldYear", kind: "online", action: "add_seats", period: null, months: 0, seats: 6, extra: 1, amount: 1, currency: "NGN", paidAt: NOW - 10 * DAY });
await put("teams/oldTerm", { name: "Paid a term", kind: "school", seats: 5, seatPrice: null, currency: "NGN", paidUntil: NOW + 20 * DAY, joinCode: "OLDT2345", memberCount: 1, createdAt: NOW - 100 * DAY });
await put("teamPayments/ot1", { teamId: "oldTerm", kind: "online", action: "renew", period: "term", months: 4, seats: 5, amount: 1, currency: "NGN", paidAt: NOW - 100 * DAY });
await put("teams/oldInvoice", { name: "Invoiced a year", kind: "school", seats: 5, seatPrice: null, currency: "NGN", paidUntil: NOW + 30 * DAY, joinCode: "OLDI2345", memberCount: 1, createdAt: NOW - 400 * DAY });
await put("teamPayments/oi1", { teamId: "oldInvoice", kind: "invoice", action: "renew", period: null, months: 1, seats: 5, amount: 0, currency: "NGN", paidAt: NOW - 400 * DAY });
await put("teamPayments/oi2", { teamId: "oldInvoice", kind: "invoice", action: "renew", period: null, months: 12, seats: 5, amount: 0, currency: "NGN", paidAt: NOW - 335 * DAY });
await put("teams/oldByHand", { name: "Set by hand", kind: "team", seats: 5, seatPrice: null, currency: "NGN", paidUntil: NOW + 5 * DAY, joinCode: "OLDH2345", memberCount: 1, createdAt: NOW - 5 * DAY });
const yearBefore = (await db.doc(`teams/${yTeam.id}`).get()).data().paidFor;
const backfilled = await backfillPaidFor(db);
const pf = async (id) => (await db.doc(`teams/${id}`).get()).data().paidFor;
check(await pf("oldYear") === "year" && (await teamDetail(db, "oldYear", NOW)).graceUntil === NOW + 230 * DAY, "paid for a year before: its 30 grace days (added seats don't change it)");
check(await pf("oldTerm") === "month", "a school term from before (4 months): as a month, 2 grace days");
check(await pf("oldInvoice") === "year", "invoices: the latest counts (12 months: a year)");
check(await pf("oldByHand") === undefined, "no payment recorded (set by hand): left as it is");
check(await pf(yTeam.id) === yearBefore && backfilled === 3, "teams that have it already are left alone", String(backfilled));
check(await backfillPaidFor(db) === 0, "run again: nothing left to do");

console.log("A team made in dollars before teams were priced in naira");
await db.doc("teams/legacy").set({ name: "Old Dollar Team", kind: "team", seats: 5, seatPrice: null, currency: "USD", paidUntil: null, joinCode: "LEGA2345", joinOpen: true, memberCount: 1, createdAt: NOW - 30 * DAY, ownerEmail: "old@x.io" });
await db.doc("teamMembers/old").set({ teamId: "legacy", role: "admin", email: "old@x.io", emailVerified: true, joinedAt: NOW - 30 * DAY });
const legacyView = await teamDetail(db, "legacy", NOW);
check(legacyView.currency === "NGN" && legacyView.seatPrice === 664300, "it's priced in naira now: ₦6,643 a seat (the same $5), what Paystack takes");
const legacyQuote = await quoteFor(db, "old", { action: "renew", period: "month", seats: 5 }, NOW);
check(legacyQuote.currency === "NGN" && legacyQuote.amount === 3321500, "and pays ₦33,215 for 5 seats a month, not dollars a naira account can't take");
const renamedLegacy = await adminUpdateTeam(db, "legacy", { name: "Old Dollar Team 2" });
check(renamedLegacy.currency === "NGN" && (await db.doc("teams/legacy").get()).data().currency === "NGN", "an edit on the admin page stores it in naira");

console.log(bad ? `\n${bad} check(s) failed.` : "\nAll team checks passed.");
process.exit(bad ? 1 : 0);
