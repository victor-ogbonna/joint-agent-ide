/**
 * Creator codes, start to finish: a creator is added, a person takes the code
 * and gets the free trial, pays the discounted first month, then renews; the
 * creator earns their rate on each payment for twelve months, counted once
 * however many times a payment is reported, and is marked paid.
 *
 * Runs against an in-memory stand-in for Firestore with the calls the code
 * uses (documents, merges, simple queries, transactions).
 */
import { Timestamp } from "firebase-admin/firestore";
import {
  normalizeCode, validRate, canUseCode, claimRefusal, firstMonthOfferUntil, firstMonthOfferOpensAt, discountedAmount, firstMonthPeriod,
  commissionFor, inCommissionWindow, summarize, isOnTrial, TRIAL_MS, FIRST_MONTH_KIND, DEFAULT_COMMISSION_PCT,
} from "../server/referrals.ts";
import {
  addCreator, updateCreator, claimCode, applyFirstMonthPayment, recordCommission, paymentFacts, markPaid,
  listCreators, creatorDetail, creatorsForEmail, earningId, CreatorError,
} from "../server/creators.ts";
import { readUserDoc, tierOf, allowanceFor, allowanceMonth, tokenUsagePatch, PAID_TOKEN_CAP } from "../server/quota.ts";
import { hasPaidPro, paysForPro } from "../server/billing.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const throwsWith = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return e instanceof CreatorError && re.test(e.message); }
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
  async get() { return this._snap(); }
  async set(data, opts) { this._write(data, opts); }
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
      const [col, id] = key.split("/");
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
    const tx = {
      get: async (r) => r._snap(),
      set: (ref, data, opts) => writes.push(() => ref._write(data, opts)),
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  }
  doc(path) { const [c, id] = path.split("/"); return new DocRef(this, c, id); }
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const plain = { referralCode: null, trialStartedAt: null, trialEndsAt: null, subscriptionStatus: "none", lastPaymentAt: null, firstMonthReference: null };

console.log("Codes and rates");
check(normalizeCode(" tobi20 ") === "TOBI20" && normalizeCode("ab") === null && normalizeCode("a b c") === null && normalizeCode("-ABC") === null && normalizeCode(42) === null,
  "a code is 3-24 letters/digits/-/_, stored upper case");
check(validRate(20) === 20 && validRate("12.5") === 12.5 && validRate(-1) === null && validRate(101) === null && validRate("x") === null, "a rate is 0 to 100");
check(DEFAULT_COMMISSION_PCT === 20, "the default rate is 20%");

console.log("Who can take a code");
const owner = { active: true, email: "tobi@creator.com" };
const newbie = { email: "ada@x.com", emailVerified: true, level: "none" };
check(canUseCode(plain, "none") && claimRefusal(plain, "TOBI20", owner, newbie) === null, "someone new to PRO, with a verified email");
check(/isn't valid/.test(claimRefusal(plain, "TOBI20", null, newbie)) && /isn't valid/.test(claimRefusal(plain, "TOBI20", { ...owner, active: false }, newbie)), "not an unknown or switched-off code");
check(/verify your email/i.test(claimRefusal(plain, "TOBI20", owner, { ...newbie, emailVerified: false })), "not before the email is verified");
check(/own code/.test(claimRefusal(plain, "TOBI20", owner, { ...newbie, email: "TOBI@creator.com" })), "not the creator themself");
check(/already has a creator code/.test(claimRefusal({ ...plain, referralCode: "OTHER" }, "TOBI20", owner, newbie)), "not a second code");
check(/new to PRO/.test(claimRefusal({ ...plain, lastPaymentAt: NOW - 100 * DAY, subscriptionStatus: "canceled" }, "TOBI20", owner, newbie)), "not someone who has paid before");
check(/new to PRO/.test(claimRefusal({ ...plain, trialStartedAt: NOW - 50 * DAY }, "TOBI20", owner, newbie)), "not someone who had a trial");
check(/already has PRO/.test(claimRefusal(plain, "TOBI20", owner, { ...newbie, level: "pro" })), "not an account given PRO");

console.log("The offer and the money");
const trialEnds = NOW + TRIAL_MS;
const coded = { ...plain, referralCode: "TOBI20", trialStartedAt: NOW, trialEndsAt: trialEnds };
check(firstMonthOfferUntil(coded, NOW) === null && firstMonthOfferOpensAt(coded, NOW) === trialEnds, "no discount during the trial: it opens when the trial ends");
check(firstMonthOfferUntil(coded, trialEnds) === trialEnds + 30 * DAY && firstMonthOfferOpensAt(coded, trialEnds) === null, "then the first-month offer lasts 30 days");
check(firstMonthOfferUntil(coded, trialEnds + 31 * DAY) === null, "gone 30 days after the trial");
check(firstMonthOfferUntil({ ...coded, lastPaymentAt: NOW }, trialEnds + DAY) === null && firstMonthOfferUntil(plain, trialEnds + DAY) === null, "not after paying, nor without a code");
check(discountedAmount(700) === 560 && discountedAmount(500000) === 400000, "20% off: $7.00 -> $5.60, ₦5,000 -> ₦4,000");
const during = firstMonthPeriod(NOW + DAY, trialEnds);
const after = firstMonthPeriod(trialEnds + 3 * DAY, trialEnds);
check(during.start === trialEnds && after.start === trialEnds + 3 * DAY, "paid during the trial, the month starts when it ends; after, when paid");
check(new Date(after.end).getUTCMonth() === (new Date(after.start).getUTCMonth() + 1) % 12, "and lasts a calendar month");
check(commissionFor(560, 20) === 112 && commissionFor(701, 20) === 140 && commissionFor(700, 0) === 0, "commission: the rate of what was paid, rounded down");
check(inCommissionWindow(NOW, NOW + 330 * DAY) && !inCommissionWindow(NOW, NOW + 366 * DAY), "for twelve months after the first payment");
const sum = summarize([{ currency: "usd", commission: 112, payoutId: null }, { currency: "USD", commission: 140, payoutId: "p1" }, { currency: "NGN", commission: 8000, payoutId: null }]);
check(JSON.stringify(sum) === JSON.stringify([{ currency: "NGN", earned: 8000, paid: 0, owed: 8000 }, { currency: "USD", earned: 252, paid: 140, owed: 112 }]), "earned, paid and owed, per currency");

console.log("Start to finish");
const db = new FakeDb();
const creator = await addCreator(db, { code: "tobi20", name: "Tobi Tech", email: "Tobi@Creator.com", ratePct: "20" }, NOW);
check(creator.code === "TOBI20" && creator.email === "tobi@creator.com" && creator.ratePct === 20 && creator.active, "a creator is added");
check(await throwsWith(() => addCreator(db, { code: "TOBI20", name: "Again" }, NOW), /already taken/), "the same code can't be added twice");
check(await throwsWith(() => addCreator(db, { code: "x", name: "Bad" }, NOW), /3 to 24/), "a bad code is refused");
check(await throwsWith(() => addCreator(db, { code: "OKAY1", name: "Bad", email: "nope" }, NOW), /email/), "a bad email is refused");
await addCreator(db, { code: "QUIET", name: "Paused One" }, NOW);
await updateCreator(db, "quiet", { active: false });

// Ada takes Tobi's code.
db.doc("users/ada").set({ subscriptionStatus: "none" });
const claimed = await claimCode(db, "ada", " tobi20 ", newbie, NOW);
let ada = readUserDoc((await db.doc("users/ada").get()).data());
check(claimed.trialEndsAt === NOW + 7 * DAY && ada.referralCode === "TOBI20" && ada.trialEndsAt === NOW + 7 * DAY, "taking the code: 7 days of PRO");
check(tierOf(ada, "none", NOW + DAY) === "pro" && tierOf(ada, "none", NOW + 8 * DAY) === "free", "PRO during the trial, Free after it");
check(isOnTrial(ada, NOW + DAY) && allowanceFor(ada, "pro", NOW + DAY).cycleCap === null, "metered like granted PRO during the trial");
check((await db.doc("creators/TOBI20").get()).data().signups === 1, "the creator's sign-ups count it");
check(await throwsWith(() => claimCode(db, "ada", "TOBI20", newbie, NOW), /already on your account/), "taking it again is refused");
db.doc("users/bo").set({ subscriptionStatus: "none" });
check(await throwsWith(() => claimCode(db, "bo", "QUIET", { ...newbie, email: "bo@x.com" }, NOW), /isn't valid/), "a switched-off code is refused");
check(await throwsWith(() => claimCode(db, "bo", "NOPE99", { ...newbie, email: "bo@x.com" }, NOW), /isn't valid/), "an unknown code is refused");
check(await throwsWith(() => claimCode(db, "tobi-acct", "TOBI20", { email: "tobi@creator.com", emailVerified: true, level: "none" }, NOW), /own code/), "the creator can't take their own code");
check((await db.doc("creators/TOBI20").get()).data().signups === 1, "refusals don't count as sign-ups");

// Ada buys the first month at 20% off, three days after her trial ends.
const plan = { code: "PLN_pro", amount: 700, currency: "USD" };
const started = [];
const deps = { plan, startSubscription: async (a) => { started.push(a); return true; } };
const paidAt = trialEnds + 3 * DAY;
const pay = (over = {}) => ({
  status: "success", reference: "T_first_1", amount: 560, currency: "USD", paid_at: new Date(paidAt).toISOString(),
  metadata: { uid: "ada", kind: FIRST_MONTH_KIND }, customer: { customer_code: "CUS_ada", email: "ada@x.com" },
  authorization: { authorization_code: "AUTH_ada", reusable: true }, ...over,
});
check(await throwsWith(() => applyFirstMonthPayment(db, "ada", pay({ currency: "NGN" }), deps, paidAt), /wrong currency/), "a payment in another currency doesn't count");
check(await throwsWith(() => applyFirstMonthPayment(db, "ada", pay({ amount: 559 }), deps, paidAt), /less than/), "nor one below the first month's price");
check(await throwsWith(() => applyFirstMonthPayment(db, "ada", pay({ metadata: { uid: "bo", kind: FIRST_MONTH_KIND } }), deps, paidAt), /doesn't belong/), "nor someone else's payment");
check(await throwsWith(() => applyFirstMonthPayment(db, "bo", pay({ metadata: { uid: "bo", kind: FIRST_MONTH_KIND } }), deps, paidAt), /doesn't have the first-month offer/), "nor one from an account without the offer");
const first = await applyFirstMonthPayment(db, "ada", pay(), deps, paidAt);
ada = readUserDoc((await db.doc("users/ada").get()).data());
const end = firstMonthPeriod(paidAt, trialEnds).end;
check(first.applied && first.renews && first.proUntil === end, "the first month is applied, and will renew");
check(started.length === 1 && started[0].authorization === "AUTH_ada" && started[0].customer === "CUS_ada" && started[0].startDate === end,
  "the normal subscription starts on her card when the month ends");
check(ada.subscriptionStatus === "active" && ada.paystackPlanCode === "PLN_pro" && ada.currentPeriodEnd.toMillis() === end && ada.firstMonthReference === "T_first_1",
  "her account: PRO, renewing, paid through the month's end");
check(hasPaidPro({ subscriptionStatus: "active", currentPeriodEnd: end, lastPaymentAt: paidAt, pastDueAt: null }, end - DAY) && tierOf(ada, "none", paidAt + DAY) === "pro", "she's PRO");
check(firstMonthOfferUntil(ada, paidAt + DAY) === null, "the offer is used up");
const again = await applyFirstMonthPayment(db, "ada", pay(), deps, paidAt + 1000);
check(!again.applied && again.already && started.length === 1, "the same payment reported again (the webhook) changes nothing");

// A card that can't be charged again: PRO for the month, no renewal.
db.doc("users/cy").set({ subscriptionStatus: "none" });
await claimCode(db, "cy", "TOBI20", { ...newbie, email: "cy@x.com" }, NOW);
const cyTry = NOW + 2 * DAY;   // during the trial: no offer yet
const cyPay = (at) => pay({ reference: "T_cy", metadata: { uid: "cy", kind: FIRST_MONTH_KIND }, authorization: { reusable: false }, paid_at: new Date(at).toISOString() });
check(await throwsWith(() => applyFirstMonthPayment(db, "cy", cyPay(cyTry), deps, cyTry), /doesn't have the first-month offer/), "the discount can't be bought during the trial");
const cyPaid = trialEnds + DAY;
const cy = await applyFirstMonthPayment(db, "cy", cyPay(cyPaid), deps, cyPaid);
const cyDoc = readUserDoc((await db.doc("users/cy").get()).data());
check(cy.applied && !cy.renews && started.length === 1, "paid by transfer after the trial: PRO for the month, nothing starts on a card");
check(cyDoc.subscriptionStatus === "canceled" && cyDoc.currentPeriodEnd.toMillis() === firstMonthPeriod(cyPaid, trialEnds).end, "won't renew; the month runs from the payment");

console.log("Commission");
const facts = (ref, amount, at) => paymentFacts({ reference: ref, amount, currency: "USD", paid_at: new Date(at).toISOString() }, at);
const c1 = await recordCommission(db, "ada", facts("T_first_1", 560, paidAt), "ada@x.com", paidAt);
const c1again = await recordCommission(db, "ada", facts("T_first_1", 560, paidAt), "ada@x.com", paidAt);
check(c1.recorded && c1.commission === 112 && !c1again.recorded, "20% of the $5.60 she paid: $1.12, counted once");
check((await db.doc("creators/TOBI20").get()).data().payingUsers === 1, "she counts as a paying user");
const renewal = await recordCommission(db, "ada", facts("T_renew_1", 700, end + 1000), "ada@x.com", end);
check(renewal.recorded && renewal.commission === 140, "her first renewal at $7: $1.40");
const late = await recordCommission(db, "ada", facts("T_renew_13", 700, paidAt + 370 * DAY), "ada@x.com", paidAt + 370 * DAY);
check(!late.recorded, "nothing after twelve months");
db.doc("users/dee").set({ subscriptionStatus: "active" });
check(!(await recordCommission(db, "dee", facts("T_dee", 700, NOW), null, NOW)).recorded, "nothing for a payer who came without a code");
check((await db.doc("creators/TOBI20").get()).data().payingUsers === 1, "renewals don't count her twice");
check(earningId("a/b") === "a_b", "a reference with a slash still makes a valid record id");
check(paymentFacts({ reference: "x", amount: 0, currency: "USD" }, NOW) === null && paymentFacts({ reference: "x", amount: 5, currency: "US" }, NOW) === null, "a payment without a real amount or currency isn't counted");

console.log("Paying the creator");
let list = await listCreators(db);
const tobi = list.find((c) => c.code === "TOBI20");
check(tobi && tobi.money.length === 1 && tobi.money[0].owed === 252 && tobi.money[0].paid === 0, "owed: $2.52", JSON.stringify(tobi?.money));
const payout = await markPaid(db, "tobi20", NOW + 60 * DAY, "Bank transfer");
check(payout.totals[0].amount === 252 && payout.count === 2 && payout.left === 0, "marked paid: $2.52 for two payments");
check(await throwsWith(() => markPaid(db, "TOBI20", NOW + 61 * DAY), /Nothing is owed/), "nothing left to mark paid");
list = await listCreators(db);
const after2 = list.find((c) => c.code === "TOBI20").money[0];
check(after2.paid === 252 && after2.owed === 0, "paid $2.52, owed nothing");
const detail = await creatorDetail(db, "TOBI20");
check(detail.earnings.length === 2 && detail.earnings.every((e) => e.payoutId === payout.id) && detail.payouts.length === 1, "the admin page sees each payment and the payout");

console.log("The creator's own page");
const mine = await creatorsForEmail(db, "TOBI@creator.com");
check(mine.length === 1 && mine[0].code === "TOBI20" && mine[0].signups === 2 && mine[0].payingUsers === 1, "Tobi sees his code, sign-ups and paying users");
check(mine[0].money[0].paid === 252 && mine[0].earnings.length === 2 && mine[0].payouts.length === 1, "and what he's earned and been paid");
check(!JSON.stringify(mine).includes("ada") && !JSON.stringify(mine).includes("@x.com"), "but no one's email or account");
check((await creatorsForEmail(db, "someone@else.com")).length === 0, "anyone else sees nothing");

console.log("Changing a creator");
const changed = await updateCreator(db, "TOBI20", { ratePct: 25, name: "Tobi T." });
check(changed.ratePct === 25 && changed.name === "Tobi T." && changed.signups === 2, "rate and name change; counts stay");
check(await throwsWith(() => updateCreator(db, "TOBI20", {}), /Nothing to change/) && await throwsWith(() => updateCreator(db, "NOPE99", { active: true }), /No such creator/),
  "an empty change, or an unknown code, is refused");
const nextRenewal = await recordCommission(db, "ada", facts("T_renew_2", 700, end + 31 * DAY), "ada@x.com", end + 31 * DAY);
check(nextRenewal.commission === 175, "a new rate applies to payments from then on (25% of $7 = $1.75)");

console.log("The yearly plan");
check(paysForPro("PLN_year", ["PLN_month", "PLN_year"], null) && paysForPro("PLN_month", ["PLN_month", "PLN_year"], null), "a payment for the monthly or the yearly plan is PRO");
check(!paysForPro("PLN_other", ["PLN_month", null], null) && paysForPro("PLN_old", ["PLN_month", null], "PLN_old"), "nothing else, except the plan the account already renews on");
const yStart = Date.UTC(2026, 0, 31, 9, 0, 0);
const yearly = readUserDoc({
  subscriptionStatus: "active", planInterval: "annually", cycleStartedAt: yStart, cycleMonth: 0,
  cycleTokensUsed: PAID_TOKEN_CAP, lastPaymentAt: yStart, currentPeriodEnd: Timestamp.fromMillis(Date.UTC(2027, 0, 31, 9)),
});
const m0 = allowanceMonth(yearly, yStart + DAY);
const m1 = allowanceMonth(yearly, Date.UTC(2026, 2, 5));
check(m0.key === 0 && m1.key === 1 && allowanceMonth(yearly, Date.UTC(2027, 0, 30)).key === 11, "a yearly plan has twelve allowance months");
check(allowanceMonth({ planInterval: "monthly", cycleStartedAt: yStart }, yStart) === null, "a monthly plan refills with its payments instead");
const usedUp = allowanceFor(yearly, "pro", yStart + 2 * DAY);
check(usedUp.blocked && usedUp.reason === "cycle" && usedUp.resetAt === m0.resetAt, "a yearly subscriber who used the month's allowance waits for the next month, not the next year");
const nextMonth = allowanceFor(yearly, "pro", Date.UTC(2026, 2, 5));
check(!nextMonth.blocked && nextMonth.cycleUsed === 0 && nextMonth.cycleCap === PAID_TOKEN_CAP, "and in the next month the full allowance is back");
const patch = tokenUsagePatch(yearly, { tier: "pro", subscriptionStatus: "active" }, 1000, Date.UTC(2026, 2, 5));
check(patch.cycleTokensUsed === 1000 && patch.cycleMonth === 1, "use in a new month starts its count afresh");
const same = tokenUsagePatch({ ...yearly, cycleMonth: 1, cycleTokensUsed: 5000 }, { tier: "pro", subscriptionStatus: "active" }, 1000, Date.UTC(2026, 2, 6));
check(same.cycleTokensUsed === 6000 && same.cycleMonth === 1, "and adds up within the month");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
