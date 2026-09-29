/**
 * The admin dashboard's figures: plans, sign-ups and activity, daily series,
 * boards, payments and the server verdict.
 */
import {
  planOf, buildUserRows, summarizeUsers, dayRange, buildSeries, totals, boardTotals, addStats,
  paymentRows, summarizePayments, serverVerdict,
} from "../server/adminMetrics.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const DAY = 864e5;
const GB = 1024 ** 3;
const NOW = Date.UTC(2026, 8, 29, 15, 0, 0);
const lists = { ownerEmails: ["owner@x.com"], proAccessEmails: ["vc@x.com"], earlyAccessEmails: ["early@x.com"] };
const user = (o) => ({ uid: "u", email: null, name: null, providers: ["google.com"], verified: true, disabled: false, createdAt: NOW - 40 * DAY, lastSignInAt: null, lastRefreshAt: null, ...o });

console.log("Plans");
check(planOf(user({ email: "owner@x.com" }), undefined, lists, NOW) === "owner", "the owner");
check(planOf(user({ email: "owner@x.com", verified: false }), undefined, lists, NOW) === "free", "an unverified owner address is not the owner");
check(planOf(user({ email: "a@x.com" }), { subscriptionStatus: "active" }, lists, NOW) === "pro", "a subscriber");
check(planOf(user({ email: "a@x.com" }), { subscriptionStatus: "canceled", currentPeriodEnd: NOW + DAY }, lists, NOW) === "pro", "cancelled, still in the paid month");
check(planOf(user({ email: "a@x.com" }), { subscriptionStatus: "canceled", currentPeriodEnd: NOW - DAY }, lists, NOW) === "free", "cancelled, after it");
check(planOf(user({ email: "vc@x.com" }), undefined, lists, NOW) === "granted", "granted PRO");
check(planOf(user({ email: "a@x.com" }), undefined, lists, NOW) === "free", "everyone else");

console.log("Users");
const users = [
  user({ uid: "owner", email: "owner@x.com", createdAt: NOW - 100 * DAY, lastRefreshAt: NOW - 3600e3 }),
  user({ uid: "pro1", email: "p@x.com", createdAt: NOW - 20 * DAY, providers: ["password"], verified: false }),
  user({ uid: "free1", email: "f@x.com", createdAt: NOW - 2 * 3600e3 }),
  user({ uid: "free2", email: "early@x.com", createdAt: NOW - 3 * DAY, lastSignInAt: NOW - 10 * DAY }),
  user({ uid: "vc", email: "vc@x.com", createdAt: NOW - 60 * DAY, disabled: true }),
];
const docs = new Map([
  ["pro1", { subscriptionStatus: "active", currentPeriodEnd: NOW + 12 * DAY, compilesTotal: 40, aiMessagesTotal: 90, lastActiveAt: NOW - 2 * DAY }],
  ["free1", { subscriptionStatus: "none", compilesTotal: 3, lastActiveAt: NOW - 1000 }],
  ["free2", { subscriptionStatus: "past_due", currentPeriodEnd: NOW - DAY, pastDueAt: NOW - DAY }],
]);
const projects = new Map([["pro1", 12], ["free1", 6], ["free2", 5]]);
const rows = buildUserRows(users, docs, projects, lists, NOW, 5);
const by = Object.fromEntries(rows.map((r) => [r.uid, r]));
check(rows[0].uid === "free1", "newest first");
check(by.pro1.plan === "pro" && by.pro1.renewsAt === NOW + 12 * DAY && by.pro1.proUntil === null, "a renewing subscriber, with the renewal date");
check(by.free1.overLimit && !by.free2.overLimit && !by.pro1.overLimit, "only a Free account over 5 projects is flagged");
check(by.free2.plan === "free" && by.free2.subscriptionStatus === "past_due" && by.free2.early, "a failed payment shows as Free, past due; early access is marked");
check(by.owner.lastActiveAt === NOW - 3600e3, "last active: the latest of the app's own record and Firebase's");
check(by.pro1.compilesTotal === 40 && by.pro1.aiMessagesTotal === 90, "per-user totals");
const sum = summarizeUsers(rows, NOW);
check(sum.total === 5 && sum.verified === 4 && sum.disabled === 1, "totals: all, verified, disabled");
check(sum.providers["google.com"] === 4 && sum.providers.password === 1, "sign-in methods");
check(sum.signups.today === 1 && sum.signups.d7 === 2 && sum.signups.d30 === 3, "sign-ups today, 7 and 30 days", JSON.stringify(sum.signups));
check(sum.active.d1 === 2 && sum.active.d7 === 3 && sum.active.d30 === 4, "active today, 7 and 30 days", JSON.stringify(sum.active));
check(sum.plans.pro === 1 && sum.plans.proRenewing === 1 && sum.plans.granted === 1 && sum.plans.owner === 1 && sum.plans.free === 2, "plans", JSON.stringify(sum.plans));
check(sum.pastDue === 1 && sum.freeOverLimit === 1 && sum.withProjects === 3, "past due, over the project limit, with projects");

console.log("Days");
const range = dayRange(7, NOW);
check(range.length === 7 && range[6] === "2026-09-29" && range[0] === "2026-09-23", "the last 7 days, ending today");
const stats = new Map([
  ["2026-09-28", { compiles_ok: 8, compiles_failed: 2, compile_ms_total: 200000, compile_ms_count: 10, compile_ms_max: 61000, ai_chat: 5, ai_debug: 2, ai_free: 4, ai_pro: 3, active_users: 6, page_views: 40, api_requests: 900, compile_waits: 2, compile_wait_ms_total: 9000, boards: { uno: 6, esp32dev: 4 } }],
  ["2026-09-29", { compiles_ok: 2, compile_ms_total: 60000, compile_ms_count: 2, boards: { uno: 1, megaatmega2560: 1 } }],
]);
const series = buildSeries(range, stats, [NOW - 1000, NOW - DAY, NOW - 30 * DAY], [NOW - DAY, NOW - DAY]);
const y = series.find((r) => r.day === "2026-09-28");
check(y.compilesOk === 8 && y.compilesFailed === 2 && y.avgCompileMs === 20000 && y.maxCompileMs === 61000, "a day's compiles and their times");
check(y.aiMessages === 7 && y.activeUsers === 6 && y.avgWaitMs === 4500 && y.signups === 1 && y.projectsCreated === 2, "and its AI messages, users, waits, sign-ups and projects");
check(series.find((r) => r.day === "2026-09-25").compilesOk === 0, "a quiet day is zero, not missing");
const t = totals(series);
check(t.compilesOk === 10 && t.compileSuccessRate === 83 && t.signups === 2 && t.peakActiveUsers === 6, "totals over the range", JSON.stringify({ ok: t.compilesOk, rate: t.compileSuccessRate }));
check(t.avgCompileMs === Math.round(260000 / 12), "average compile time: all compile time over all compiles", String(t.avgCompileMs));
const boards = boardTotals(range, stats);
check(boards[0].id === "uno" && boards[0].count === 7 && boards.length === 3, "builds per board, most first");
const merged = addStats({ compiles_ok: 3, boards: { uno: 1 }, compile_ms_max: 5 }, { add: { compiles_ok: 2 }, boards: { uno: 2, esp32dev: 1 }, max: { compile_ms_max: 9 } });
check(merged.compiles_ok === 5 && merged.boards.uno === 3 && merged.boards.esp32dev === 1 && merged.compile_ms_max === 9, "saved and not-yet-saved counts add up");

console.log("Payments");
const pay = paymentRows([
  { id: 1, status: "success", amount: 1050000, currency: "NGN", paid_at: "2026-09-02T10:00:00Z", customer: { email: "p@x.com" }, channel: "card" },
  { id: 2, status: "success", amount: 1050000, currency: "NGN", paid_at: "2026-08-02T10:00:00Z", customer: { email: "p@x.com" } },
  { id: 3, status: "failed", amount: 1050000, currency: "NGN", created_at: "2026-09-10T10:00:00Z" },
  { id: 4, status: "success", amount: 700, currency: "USD", paid_at: "2026-09-12T10:00:00Z" },
]);
check(pay[0].id === "4" && pay[0].amount === 7, "newest first, in whole units (kobo and cents divided by 100)");
const ps = summarizePayments(pay, NOW);
check(ps.byCurrency.NGN.allTime === 21000 && ps.byCurrency.NGN.thisMonth === 10500 && ps.byCurrency.NGN.lastMonth === 10500, "revenue per currency: all time, this month, last month");
check(ps.byCurrency.USD.thisMonth === 7 && ps.failed === 1 && ps.successful === 3, "failed payments counted apart");
check(ps.byCurrency.NGN.failed === 1 && ps.byCurrency.USD.failed === 0, "failed payments counted per currency too");
check(ps.byMonth.length === 12 && ps.byMonth[11].month === "2026-09" && ps.byMonth[11].amounts.NGN === 10500, "the last 12 months");

console.log("The server");
const base = { cores: 2, load1: 0.4, memTotal: 4 * GB, memAvailable: 2.5 * GB, diskTotal: 40 * GB, diskFree: 25 * GB, slots: 2, running: 1, waiting: 0, longestWaitMs: 0, busyToday: 0 };
check(serverVerdict(base).level === "ok" && serverVerdict(base).reasons.length === 0, "quiet: OK");
const busy = serverVerdict({ ...base, waiting: 2, load1: 2.2 });
check(busy.level === "busy" && busy.reasons.some((r) => /2 compiles are waiting/.test(r)) && /bigger server/.test(busy.advice), "compiles waiting: Busy, with advice", busy.reasons.join("; "));
const over = serverVerdict({ ...base, memAvailable: 0.2 * GB });
check(over.level === "overloaded" && over.reasons.some((r) => /memory is 95% used/.test(r)), "memory nearly full: Overloaded", over.reasons.join("; "));
check(serverVerdict({ ...base, busyToday: 1 }).level === "overloaded", "a compile turned away today: Overloaded");
const disk = serverVerdict({ ...base, diskFree: 4 * GB });
check(disk.level === "busy" && /disk space/.test(disk.advice), "disk filling up: says so", disk.advice);

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
