/**
 * Who gets which model, and what the lite tier allows.
 *
 * A free user used to be refused outright once their free tokens were spent.
 * Now they drop to the lite tier: a cheaper, less capable model, a 5,000-token
 * reply cap, no auto-debug and 5 compiles a day, until they subscribe.
 */
import { tierOf, liteCompilesLeft, FREE_TOKEN_CAP, LITE_DAILY_COMPILES, utcDay } from "../server/quota.ts";
import { modelFor, PRO_MODEL, LITE_MODEL, LITE_MAX_OUTPUT_TOKENS } from "../server/deepseek.ts";
import { attachedImages } from "../server/context.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const doc = (o = {}) => ({
  lifetimeFreeTokensUsed: 0, cycleTokensUsed: 0, subscriptionStatus: "none",
  paystackCustomerCode: null, paystackSubscriptionCode: null, paystackEmailToken: null,
  currentPeriodEnd: null, liteTokensUsed: 0, liteCompileDay: null, liteCompileCount: 0, ...o,
});

// Tiers
check(tierOf(doc(), "free") === "free", "a new free user is on the full model");
check(tierOf(doc({ lifetimeFreeTokensUsed: FREE_TOKEN_CAP - 1 }), "free") === "free", "one token short of the cap: still full");
check(tierOf(doc({ lifetimeFreeTokensUsed: FREE_TOKEN_CAP }), "free") === "lite", "free tokens spent: lite");
check(tierOf(doc({ lifetimeFreeTokensUsed: FREE_TOKEN_CAP * 3, subscriptionStatus: "active" }), "free") === "pro",
      "a subscriber is Pro however many free tokens they once used");
check(tierOf(doc({ lifetimeFreeTokensUsed: FREE_TOKEN_CAP }), "pro") === "pro", "a granted Pro account is Pro");
check(tierOf(doc({ lifetimeFreeTokensUsed: FREE_TOKEN_CAP }), "unmetered") === "unmetered", "the owner is never lite");

// Daily compiles
const today = utcDay();
check(liteCompilesLeft(doc(), today) === LITE_DAILY_COMPILES, `a fresh day has ${LITE_DAILY_COMPILES} compiles`);
check(liteCompilesLeft(doc({ liteCompileDay: today, liteCompileCount: 3 }), today) === 2, "three used today leaves two");
check(liteCompilesLeft(doc({ liteCompileDay: today, liteCompileCount: 9 }), today) === 0, "never below zero");
check(liteCompilesLeft(doc({ liteCompileDay: "2000-01-01", liteCompileCount: 5 }), today) === LITE_DAILY_COMPILES,
      "yesterday's count does not carry over");

// Models
check(PRO_MODEL.maxOutputTokens === 40000, "Pro replies may run to 40,000 tokens");
check(LITE_MAX_OUTPUT_TOKENS === 5000 && LITE_MODEL.maxOutputTokens === 5000, "lite replies are capped at 5,000 tokens");
check(modelFor(false) === PRO_MODEL, "full tiers get the Pro model");
{
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test";
  check(modelFor(true) === LITE_MODEL, "lite gets the lite model when its key is set");
  delete process.env.GEMINI_API_KEY;
  const fallback = modelFor(true);
  check(fallback.model === PRO_MODEL.model && fallback.maxOutputTokens === 5000,
        "without a lite key, lite still gets the 5,000 cap (on the Pro model), not an error");
  if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
}

// Attached images
const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
check(attachedImages([jpeg])?.length === 1, "a JPEG data URL is accepted");
check(attachedImages([jpeg, jpeg, jpeg, jpeg, jpeg])?.length === 4, "at most four images per message");
check(attachedImages(["https://example.com/a.jpg"]) === undefined, "a remote URL is refused (only inline images)");
check(attachedImages(["data:text/html;base64,PGgxPg=="]) === undefined, "a non-image data URL is refused");
check(attachedImages("not an array") === undefined, "garbage is ignored");

console.log(bad ? `\n${bad} failing case(s)` : "\nTiers, limits and image checks hold.");
process.exit(bad ? 1 : 0);
