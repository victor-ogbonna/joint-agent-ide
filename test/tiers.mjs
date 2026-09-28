/**
 * Who is on which plan, what each may use, and when a pause lifts.
 *
 * Every metered account works in 5-hour windows. Free: 5,000 tokens a window,
 * at most 10,000 a UTC day, 5,000-token replies, 8 compiles a window and 25 a
 * day. PRO: 50,000 a window (10x Free), a subscriber at most 600,000 a billing
 * cycle, 40,000-token replies, unlimited compiles. Both run on DeepSeek.
 */
import {
  tierOf, allowanceFor, compileAllowance, formatWait, utcDay, WINDOW_MS,
  tokenUsagePatch, spendCompile, refundPatch, noteAutoDebugRound, continueAutoDebugRun, AUTO_DEBUG_ROUNDS,
  FREE_WINDOW_TOKENS, FREE_DAILY_TOKENS, PRO_WINDOW_TOKENS, PAID_TOKEN_CAP,
  FREE_WINDOW_COMPILES, FREE_DAILY_COMPILES,
} from "../server/quota.ts";
import { modelFor, PRO_MODEL, FREE_MODEL, FREE_MAX_OUTPUT_TOKENS } from "../server/deepseek.ts";
import { attachedImages } from "../server/context.ts";
import * as shown from "../src/lib/plans.ts";
import { voiceNoteSeconds, voiceNoteTooLong, MAX_VOICE_NOTE_SECONDS } from "../server/voiceNote.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const doc = (o = {}) => ({
  lifetimeFreeTokensUsed: 0, cycleTokensUsed: 0, subscriptionStatus: "none",
  paystackCustomerCode: null, paystackSubscriptionCode: null, paystackEmailToken: null,
  currentPeriodEnd: null, windowStart: null, windowTokens: 0, tokenDay: null, dayTokens: 0,
  compileWindowStart: null, compileWindowCount: 0, compileDay: null, compileDayCount: 0, ...o,
});
// Noon UTC, so "today" and the next midnight are unambiguous.
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TODAY = utcDay(NOW);
const MIDNIGHT = Date.UTC(2026, 8, 29, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

// The plans
check(FREE_WINDOW_TOKENS === 5000 && FREE_DAILY_TOKENS === 10000, "Free: 5,000 a window, 10,000 a day");
check(PRO_WINDOW_TOKENS === 10 * FREE_WINDOW_TOKENS, "PRO gets 10x Free every window");
check(PAID_TOKEN_CAP === 600000, "PRO: up to 600,000 a billing cycle");
check(WINDOW_MS === 5 * HOUR, "windows last 5 hours");
check(FREE_WINDOW_COMPILES === 8 && FREE_DAILY_COMPILES === 25, "Free: 8 compiles a window, 25 a day");

// What the app shows must be what the server enforces.
check(shown.WINDOW_HOURS * HOUR === WINDOW_MS && shown.FREE_WINDOW_TOKENS === FREE_WINDOW_TOKENS &&
      shown.FREE_DAILY_TOKENS === FREE_DAILY_TOKENS && shown.PRO_WINDOW_TOKENS === PRO_WINDOW_TOKENS &&
      shown.PAID_TOKEN_CAP === PAID_TOKEN_CAP && shown.FREE_WINDOW_COMPILES === FREE_WINDOW_COMPILES &&
      shown.FREE_DAILY_COMPILES === FREE_DAILY_COMPILES,
      "the app's plan figures match the server's");
check(shown.FREE_MAX_REPLY_TOKENS === FREE_MAX_OUTPUT_TOKENS && shown.PRO_MAX_REPLY_TOKENS === PRO_MODEL.maxOutputTokens,
      "the app's reply limits match the server's");
check(shown.formatWait(NOW + (2 * 60 + 13) * 60000, NOW) === formatWait(NOW + (2 * 60 + 13) * 60000, NOW),
      "the app counts down the same way the server words it");

// Tiers
check(tierOf(doc(), "free") === "free", "a new account is on Free");
check(tierOf(doc({ lifetimeFreeTokensUsed: 50000 }), "free") === "free", "an old account past the former 50K is still Free, not locked out");
check(tierOf(doc({ subscriptionStatus: "active" }), "free") === "pro", "a subscriber is PRO");
check(tierOf(doc(), "pro") === "pro", "a granted PRO account is PRO");
check(tierOf(doc(), "unmetered") === "unmetered", "the owner is never metered");

// Free window
{
  const a = allowanceFor(doc(), "free", NOW);
  check(!a.blocked && a.windowUsed === 0 && a.windowCap === FREE_WINDOW_TOKENS && a.windowResetAt === null,
        "a fresh account has the whole window and no window open yet");
}
{
  const a = allowanceFor(doc({ windowStart: NOW - HOUR, windowTokens: 4999, tokenDay: TODAY, dayTokens: 4999 }), "free", NOW);
  check(!a.blocked && a.windowResetAt === NOW - HOUR + WINDOW_MS, "one token short of the window: still going, refill time known");
}
{
  const a = allowanceFor(doc({ windowStart: NOW - HOUR, windowTokens: 5000, tokenDay: TODAY, dayTokens: 5000 }), "free", NOW);
  check(a.blocked && a.reason === "window" && a.resetAt === NOW + 4 * HOUR, "window used: paused until it refills", `resetAt +${(a.resetAt - NOW) / HOUR} h`);
}
{
  const a = allowanceFor(doc({ windowStart: NOW - 5 * HOUR, windowTokens: 5000, tokenDay: TODAY, dayTokens: 5000 }), "free", NOW);
  check(!a.blocked && a.windowUsed === 0, "five hours later the window has refilled");
}
{
  const a = allowanceFor(doc({ windowStart: NOW + HOUR, windowTokens: 5000 }), "free", NOW);
  check(!a.blocked, "a window stamped in the future (clock change) does not pause anyone");
}

// Free day
{
  const a = allowanceFor(doc({ windowStart: NOW - HOUR, windowTokens: 100, tokenDay: TODAY, dayTokens: 10000 }), "free", NOW);
  check(a.blocked && a.reason === "day" && a.resetAt === MIDNIGHT, "10,000 today: paused until midnight UTC");
}
{
  const a = allowanceFor(doc({ windowStart: NOW - HOUR, windowTokens: 100, tokenDay: "2026-09-27", dayTokens: 10000 }), "free", NOW);
  check(!a.blocked && a.dayUsed === 0, "yesterday's tokens do not count today");
}
{
  const late = Date.UTC(2026, 8, 28, 22, 0, 0);
  const a = allowanceFor(doc({ windowStart: late - HOUR, windowTokens: 5000, tokenDay: TODAY, dayTokens: 10000 }), "free", late);
  check(a.blocked && a.resetAt === late + 4 * HOUR, "window and day both used: the later refill governs");
}

// PRO
{
  const a = allowanceFor(doc({ subscriptionStatus: "active", windowStart: NOW - HOUR, windowTokens: 49999, cycleTokensUsed: 100000 }), "pro", NOW);
  check(!a.blocked && a.windowCap === PRO_WINDOW_TOKENS && a.dayCap === null, "PRO has no daily cap, a 50,000 window");
}
{
  const a = allowanceFor(doc({ subscriptionStatus: "active", windowStart: NOW - HOUR, windowTokens: 50000, cycleTokensUsed: 100000 }), "pro", NOW);
  check(a.blocked && a.reason === "window" && a.resetAt === NOW + 4 * HOUR, "PRO window used: paused until it refills");
}
{
  const end = NOW + 3 * 24 * HOUR;
  const a = allowanceFor(doc({ subscriptionStatus: "active", cycleTokensUsed: 600000, currentPeriodEnd: { toMillis: () => end } }), "pro", NOW);
  check(a.blocked && a.reason === "cycle" && a.resetAt === end, "cycle used: paused until the next billing date");
}
{
  const a = allowanceFor(doc({ subscriptionStatus: "active", cycleTokensUsed: 600000, currentPeriodEnd: { toMillis: () => NOW - HOUR } }), "pro", NOW);
  check(a.blocked && a.resetAt === null, "a billing date already passed is not promised as the refill time");
}
{
  const a = allowanceFor(doc({ cycleTokensUsed: 999999 }), "pro", NOW);
  check(!a.blocked && a.cycleCap === null, "a granted PRO account has the window but no cycle cap (nothing resets it)");
}
check(!allowanceFor(doc({ windowStart: NOW, windowTokens: 1e9, tokenDay: TODAY, dayTokens: 1e9 }), "unmetered", NOW).blocked,
      "the owner is never paused");

// Compiles
{
  const c = compileAllowance(doc(), NOW);
  check(!c.blocked && c.left === FREE_WINDOW_COMPILES, "a fresh account has 8 compiles");
}
{
  const c = compileAllowance(doc({ compileWindowStart: NOW - HOUR, compileWindowCount: 8, compileDay: TODAY, compileDayCount: 8 }), NOW);
  check(c.blocked && c.left === 0 && c.resetAt === NOW + 4 * HOUR, "8 used this window: paused until it refills");
}
{
  const c = compileAllowance(doc({ compileWindowStart: NOW - HOUR, compileWindowCount: 2, compileDay: TODAY, compileDayCount: 24 }), NOW);
  check(!c.blocked && c.left === 1, "24 used today: one left, however much of the window remains");
}
{
  const c = compileAllowance(doc({ compileWindowStart: NOW - HOUR, compileWindowCount: 2, compileDay: TODAY, compileDayCount: 25 }), NOW);
  check(c.blocked && c.resetAt === MIDNIGHT, "25 today: paused until midnight UTC");
}
{
  const c = compileAllowance(doc({ compileWindowStart: NOW - 6 * HOUR, compileWindowCount: 8, compileDay: "2026-09-27", compileDayCount: 25 }), NOW);
  check(!c.blocked && c.left === FREE_WINDOW_COMPILES, "an old window and yesterday's count do not carry over");
}

// Counting tokens
{
  const p = tokenUsagePatch(doc(), { tier: "free", subscriptionStatus: "none" }, 600, NOW);
  check(p.windowStart === NOW && p.windowTokens === 600 && p.tokenDay === TODAY && p.dayTokens === 600 && p.lifetimeFreeTokensUsed === 600,
        "a first reply opens the window now and counts toward window, day and lifetime");
}
{
  const p = tokenUsagePatch(doc({ windowStart: NOW - HOUR, windowTokens: 1000, tokenDay: TODAY, dayTokens: 3000, lifetimeFreeTokensUsed: 9000 }),
    { tier: "free", subscriptionStatus: "none" }, 500, NOW);
  check(p.windowStart === NOW - HOUR && p.windowTokens === 1500 && p.dayTokens === 3500 && p.lifetimeFreeTokensUsed === 9500,
        "later replies add to the open window, the day and the lifetime total");
}
{
  const p = tokenUsagePatch(doc({ windowStart: NOW - 6 * HOUR, windowTokens: 5000, tokenDay: "2026-09-27", dayTokens: 10000 }),
    { tier: "free", subscriptionStatus: "none" }, 200, NOW);
  check(p.windowStart === NOW && p.windowTokens === 200 && p.dayTokens === 200, "after a refill, a new window and a new day start from this reply");
}
{
  const p = tokenUsagePatch(doc({ subscriptionStatus: "active", cycleTokensUsed: 1000 }), { tier: "pro", subscriptionStatus: "active" }, 700, NOW);
  check(p.cycleTokensUsed === 1700 && p.windowTokens === 700 && p.dayTokens === undefined && p.lifetimeFreeTokensUsed === undefined,
        "a subscriber's reply counts toward the window and the cycle, not a day or the free total");
}
{
  const p = tokenUsagePatch(doc(), { tier: "pro", subscriptionStatus: "none" }, 700, NOW);
  check(p.windowTokens === 700 && p.cycleTokensUsed === undefined, "a granted PRO reply counts toward the window only");
}

// Spending and refunding compiles
{
  const s1 = spendCompile(doc(), NOW);
  check(s1.allowed && s1.left === FREE_WINDOW_COMPILES - 1 && s1.patch.compileWindowStart === NOW && s1.patch.compileWindowCount === 1 && s1.patch.compileDayCount === 1,
        "the first compile opens a compile window and leaves 7");
  const after = doc(s1.patch);
  const r = refundPatch(after, s1.receipt);
  check(r && r.compileWindowCount === 0 && r.compileDayCount === 0, "a failed compile is handed back to its window and day");
}
{
  const s8 = spendCompile(doc({ compileWindowStart: NOW - HOUR, compileWindowCount: 7, compileDay: TODAY, compileDayCount: 7 }), NOW);
  check(s8.allowed && s8.left === 0, "the 8th compile of a window is allowed and leaves none");
  const s9 = spendCompile(doc({ compileWindowStart: NOW - HOUR, compileWindowCount: 8, compileDay: TODAY, compileDayCount: 8 }), NOW);
  check(!s9.allowed && s9.patch === null && s9.resetAt === NOW + 4 * HOUR, "the 9th is refused, with the refill time");
}
{
  const r = refundPatch(doc({ compileWindowStart: NOW, compileWindowCount: 3, compileDay: TODAY, compileDayCount: 3 }),
    { windowStart: NOW - 6 * HOUR, day: "2026-09-27" });
  check(r === null, "a refund never reaches into a newer window or day");
}
{
  const r = refundPatch(doc({ compileWindowStart: NOW, compileWindowCount: 0, compileDay: TODAY, compileDayCount: 0 }), { windowStart: NOW, day: TODAY });
  check(r === null, "counts never go below zero");
}

// A PRO auto-debug run that started inside the allowance finishes its rounds.
check(AUTO_DEBUG_ROUNDS === 5, "an auto-debug run is at most 5 rounds, as in Smart Flash");
check(!continueAutoDebugRun("u-a", "run1", NOW), "a paused account cannot start a run");
noteAutoDebugRound("u-a", "run1", NOW);
{
  let extra = 0;
  while (continueAutoDebugRun("u-a", "run1", NOW + 60e3)) extra++;
  check(extra === AUTO_DEBUG_ROUNDS - 1, "after its first round is admitted, a run gets its remaining 4 even when paused", `${extra}`);
}
noteAutoDebugRound("u-b", "run1", NOW);
noteAutoDebugRound("u-b", "run1", NOW + 1000);
{
  let extra = 0;
  while (continueAutoDebugRun("u-b", "run1", NOW + 60e3)) extra++;
  check(extra === AUTO_DEBUG_ROUNDS - 2, "rounds already admitted are not given twice", `${extra}`);
}
noteAutoDebugRound("u-c", "old", NOW);
noteAutoDebugRound("u-c", "new", NOW);
check(!continueAutoDebugRun("u-c", "old", NOW), "only the latest run per account is remembered");
check(continueAutoDebugRun("u-c", "new", NOW), "the latest run continues");
noteAutoDebugRound("u-d", "run1", NOW);
check(!continueAutoDebugRun("u-d", "run1", NOW + 16 * 60e3), "a run left hanging for 15 minutes is over");

// Waiting times
check(formatWait(NOW + (2 * 60 + 13) * 60000, NOW) === "2 h 13 min", "2 h 13 min");
check(formatWait(NOW + 13 * 60000, NOW) === "13 min", "13 min");
check(formatWait(NOW + 3 * HOUR, NOW) === "3 h", "3 h");
check(formatWait(NOW + (76 * 60 + 12) * 60000, NOW) === "3 days 4 h", "past a day it reads in days: 3 days 4 h");
check(formatWait(NOW + 24 * HOUR, NOW) === "1 day", "exactly a day: 1 day");
check(formatWait(NOW + 25 * HOUR, NOW) === "1 day 1 h", "a day and an hour: 1 day 1 h");
check(formatWait(NOW + (23 * 60 + 59) * 60000, NOW) === "23 h 59 min", "just under a day stays in hours");
for (const w of [30e3, 13 * 60e3, 3 * HOUR, 25 * HOUR, 76.2 * HOUR, 9 * 24 * HOUR]) {
  check(shown.formatWait(NOW + w, NOW) === formatWait(NOW + w, NOW), `the app words a ${Math.round(w / 60e3)}-minute wait like the server`);
}
check(formatWait(NOW + 20000, NOW) === "less than a minute", "less than a minute");
check(formatWait(null, NOW) === "your next billing date", "unknown refill: the next billing date");

// Models
check(PRO_MODEL.maxOutputTokens === 40000, "PRO replies may run to 40,000 tokens");
check(FREE_MAX_OUTPUT_TOKENS === 5000 && FREE_MODEL.maxOutputTokens === 5000, "Free replies are capped at 5,000 tokens");
check(FREE_MODEL.model === PRO_MODEL.model && FREE_MODEL.baseUrl === PRO_MODEL.baseUrl, "Free runs on the same DeepSeek model as PRO");
check(modelFor(false) === PRO_MODEL && modelFor(true) === FREE_MODEL, "each plan gets its own model profile");

// Voice notes: 2 minutes, measured from the WAV the app sends (16 kHz mono 16-bit).
const wav = (seconds, rate = 16000) => {
  const data = Math.round(seconds * rate) * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + data, 4); buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(data, 40);
  return buf.toString("base64");
};
check(MAX_VOICE_NOTE_SECONDS === 120, "voice notes are capped at 2 minutes");
check(Math.abs(voiceNoteSeconds(wav(45), "audio/wav") - 45) < 0.01, "a 45 s note measures 45 s");
check(!voiceNoteTooLong(wav(120.3), "audio/wav"), "a note the app stopped at 2:00 is accepted");
check(!voiceNoteTooLong(wav(125, 48000), "audio/wav"), "measured the same at 48 kHz, just past 2:00 is still within the grace");
check(voiceNoteTooLong(wav(180), "audio/wav"), "a 3-minute note is refused");
check(voiceNoteSeconds("bm90IGEgd2F2IGZpbGUgYXQgYWxsLCBqdXN0IHRleHQgcGFkZGVkIG91dCB0byBiZSBsb25nIGVub3VnaA==", "audio/wav") === null,
      "something that is not WAV cannot be measured");
check(!voiceNoteTooLong("A".repeat(1000), "audio/webm") && voiceNoteTooLong("A".repeat(17 * 1024 * 1024), "audio/webm"),
      "an unmeasurable note is bounded by size instead");

// Attached images
const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
check(attachedImages([jpeg])?.length === 1, "a JPEG data URL is accepted");
check(attachedImages([jpeg, jpeg, jpeg, jpeg, jpeg])?.length === 4, "at most four images per message");
check(attachedImages(["https://example.com/a.jpg"]) === undefined, "a remote URL is refused (only inline images)");
check(attachedImages(["data:text/html;base64,PGgxPg=="]) === undefined, "a non-image data URL is refused");
check(attachedImages("not an array") === undefined, "garbage is ignored");

console.log(bad ? `\n${bad} failing case(s)` : "\nPlans, windows, limits and image checks hold.");
process.exit(bad ? 1 : 0);
