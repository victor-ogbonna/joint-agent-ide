/**
 * Like Claude's plans: PRO renews by charging the saved card each period; a
 * cancelled subscription keeps PRO until the paid period ends; a failed
 * renewal ends PRO with the period paid for (no grace period, as Claude
 * publishes none). Free holds 5 projects at once.
 */
import {
  GRACE_DAYS, GRACE_MS, addInterval, paidThrough, graceEndsAt, paidProUntil, hasPaidPro, standing,
  periodEndFrom, paymentTime, isCurrentSubscription, eventSubscriptionCode,
} from "../server/billing.ts";
import { tierOf, allowanceFor, tokenUsagePatch, subscriptionStanding, PAID_TOKEN_CAP } from "../server/quota.ts";
import { Timestamp } from "firebase-admin/firestore";
import * as shown from "../src/lib/plans.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const END = NOW + 10 * DAY;
const state = (o = {}) => ({ subscriptionStatus: "active", currentPeriodEnd: END, lastPaymentAt: END - 30 * DAY, pastDueAt: null, ...o });

console.log("Periods");
check(new Date(addInterval(Date.UTC(2026, 0, 15))).toISOString().startsWith("2026-02-15"), "monthly: the same day next month");
check(new Date(addInterval(Date.UTC(2026, 0, 15), "annually")).toISOString().startsWith("2027-01-15"), "annually: the same day next year");
check(addInterval(NOW, "weekly") === NOW + 7 * DAY, "weekly: seven days");
check(paidThrough(state()) === END, "the paid period ends on the date on file");
check(paidThrough(state({ currentPeriodEnd: null, lastPaymentAt: Date.UTC(2026, 8, 1) })) === Date.UTC(2026, 9, 1), "or, without one, a month after the last payment");
check(paidThrough(state({ currentPeriodEnd: null, lastPaymentAt: null })) === null, "or unknown");

console.log("Renewing");
check(paidProUntil(state(), NOW) === Infinity && hasPaidPro(state(), NOW), "active: PRO, renewing");
check(hasPaidPro(state({ currentPeriodEnd: NOW - DAY }), NOW), "active past its date (the renewal is on its way): still PRO");
const renewing = standing(state(), NOW);
check(renewing.renewsAt === END && renewing.proUntil === null, "shows when it renews");

console.log("Cancelled: PRO until the paid period ends");
check(paidProUntil(state({ subscriptionStatus: "canceled" }), NOW) === END, "PRO until the end of the paid month");
check(!hasPaidPro(state({ subscriptionStatus: "canceled" }), END + 1), "Free after it");
const cancelled = standing(state({ subscriptionStatus: "canceled" }), NOW);
check(cancelled.renewsAt === null && cancelled.proUntil === END, "shows when PRO ends, and no renewal");
check(!hasPaidPro(state({ subscriptionStatus: "canceled", currentPeriodEnd: null, lastPaymentAt: null }), NOW), "no known paid period: Free");

console.log("A failed renewal: no grace period");
check(GRACE_DAYS === 0 && GRACE_MS === 0, "no grace period, as Claude publishes none");
const failedAt = END;
const pastDue = state({ subscriptionStatus: "past_due", pastDueAt: failedAt });
check(graceEndsAt(pastDue) === END, "PRO ends when the paid period ends");
check(!hasPaidPro(pastDue, failedAt + 1), "Free as soon as the renewal fails");
check(graceEndsAt(state({ subscriptionStatus: "past_due", pastDueAt: END - 5 * DAY })) === END, "never less than the period already paid for");
check(hasPaidPro(state({ subscriptionStatus: "past_due", pastDueAt: END - 5 * DAY }), END - DAY), "so an early failure keeps the days already paid for");
check(graceEndsAt(state({ subscriptionStatus: "past_due", pastDueAt: null })) === END, "an older unpaid account: PRO ends with its period");

console.log("The account's plan");
const doc = (o = {}) => ({
  lifetimeFreeTokensUsed: 0, cycleTokensUsed: 0, subscriptionStatus: "none",
  paystackCustomerCode: null, paystackSubscriptionCode: null, paystackEmailToken: null,
  currentPeriodEnd: Timestamp.fromMillis(END), lastPaymentAt: null, pastDueAt: null,
  windowStart: null, windowTokens: 0, tokenDay: null, dayTokens: 0,
  compileWindowStart: null, compileWindowCount: 0, compileDay: null, compileDayCount: 0, ...o,
});
check(tierOf(doc({ subscriptionStatus: "active" }), "normal", NOW) === "pro", "active subscription: PRO");
check(tierOf(doc({ subscriptionStatus: "canceled" }), "normal", NOW) === "pro", "cancelled, within the paid month: PRO");
check(tierOf(doc({ subscriptionStatus: "canceled" }), "normal", END + 1) === "free", "cancelled, after it: Free");
check(tierOf(doc({ subscriptionStatus: "past_due", pastDueAt: END }), "normal", END + 1) === "free", "renewal failed: Free");
check(tierOf(doc({ subscriptionStatus: "past_due", pastDueAt: END - DAY }), "normal", END - 1) === "pro", "but not before the paid month ends");
check(tierOf(doc({ subscriptionStatus: "none" }), "pro", NOW) === "pro" && tierOf(doc(), "unmetered", NOW) === "unmetered", "granted PRO and the owner are unchanged");
check(tierOf(doc(), "normal", NOW) === "free", "no subscription: Free");
const cancelledDoc = doc({ subscriptionStatus: "canceled", cycleTokensUsed: PAID_TOKEN_CAP });
const a = allowanceFor(cancelledDoc, "pro", NOW);
check(a.cycleCap === PAID_TOKEN_CAP && a.blocked && a.reason === "cycle", "the month's allowance still applies until PRO ends");
const patch = tokenUsagePatch(doc({ subscriptionStatus: "canceled", cycleTokensUsed: 100 }), { tier: "pro", subscriptionStatus: "canceled" }, 50, NOW);
check(patch.cycleTokensUsed === 150, "and its use is still counted");
const st = subscriptionStanding(doc({ subscriptionStatus: "canceled" }), NOW);
check(st.proUntil === END && st.renewsAt === null, "the app is told when PRO ends");

console.log("Reading Paystack");
check(periodEndFrom({ next_payment_date: "2026-10-29T12:00:00.000Z" }, NOW) === Date.UTC(2026, 9, 29, 12), "the next payment date, when given");
check(periodEndFrom({ subscription: { next_payment_date: "2026-11-01T00:00:00Z" } }, NOW) === Date.UTC(2026, 10, 1), "including inside a subscription");
check(periodEndFrom({ paid_at: "2026-09-01T00:00:00Z", plan: { interval: "monthly" } }, NOW) === Date.UTC(2026, 9, 1), "otherwise one interval after payment");
check(periodEndFrom({ paid_at: "2026-09-01T00:00:00Z", plan_object: { interval: "annually" } }, NOW) === Date.UTC(2027, 8, 1), "by the plan's own interval");
check(periodEndFrom({}, NOW) === addInterval(NOW), "never blank");
check(paymentTime({ paid_at: "not a date" }, NOW) === NOW, "an unreadable payment time is now");
check(eventSubscriptionCode({ subscription: { subscription_code: "SUB_x" } }) === "SUB_x", "the subscription an event is about");
check(isCurrentSubscription("SUB_new", { subscription_code: "SUB_new" }), "an event about the current subscription applies");
check(!isCurrentSubscription("SUB_new", { subscription_code: "SUB_old" }), "one about a replaced subscription doesn't");
check(isCurrentSubscription("SUB_new", {}) && isCurrentSubscription(null, { subscription_code: "SUB_x" }), "one that doesn't say, or before any is on file, applies");

console.log("Projects");
check(shown.FREE_PROJECT_LIMIT === 5, "Free holds 5 projects at once");
check(typeof shown.formatDay(NOW) === "string" && shown.formatDay(NOW).length > 0, "dates read as a day");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
