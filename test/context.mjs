/**
 * The conversation is compacted when it fills its budget, and only then.
 * It used to be cut to the last 16 messages silently; now nothing is dropped
 * until the budget is nearly full, and then the older part is summarized
 * while the recent tail is kept word for word.
 */
import { planCompaction, estimateConversation, AUTOCOMPACT_AT, KEEP_RECENT_MESSAGES, transcriptOf } from "../server/context.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const msg = (i, chars) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x".repeat(chars) });
const convo = (n, chars) => Array.from({ length: n }, (_, i) => msg(i, chars));
const system = "s".repeat(3000);
const budget = 10000;

// 1. Twenty messages that fit: nothing is dropped (the old window cut to 16).
{
  const c = convo(20, 300);
  const p = planCompaction(system, c, budget);
  check(!p.compact, "a conversation under the budget is sent whole, even past 16 messages",
        `(est ${estimateConversation(system, c)} of ${budget})`);
}

// 2. Just under the threshold: still whole. At it: compacted.
{
  const under = convo(24, 1000);
  check(estimateConversation(system, under) < budget * AUTOCOMPACT_AT && !planCompaction(system, under, budget).compact,
        "just under 98% is not compacted");
  const over = convo(30, 1000);
  const p = planCompaction(system, over, budget);
  check(estimateConversation(system, over) >= budget * AUTOCOMPACT_AT && p.compact, "at 98% or more it is compacted");
  if (p.compact) {
    check(p.recent.length === KEEP_RECENT_MESSAGES, `the last ${KEEP_RECENT_MESSAGES} messages are kept word for word`);
    check(p.recent.at(-1).id === "m29", "the newest message is among them");
    check(p.older.length + p.recent.length === over.length && p.older.at(-1).id === "m23",
          "every older message goes into the summary, none lost, none duplicated");
  }
}

// 3. A few enormous messages: nothing older to fold, so no pointless compaction.
{
  const huge = convo(KEEP_RECENT_MESSAGES, 20000);
  check(!planCompaction(system, huge, budget).compact, "no compaction when only the recent tail exists");
}

// 4. A previous summary is carried into the next one, not lost.
{
  const t = transcriptOf([{ role: "assistant", content: "Board: Mega. LEDs on 16, 17.", isContextSummary: true }, msg(1, 5)]);
  check(t.startsWith("[Earlier summary]\nBoard: Mega. LEDs on 16, 17."), "an earlier summary is fed into the next compaction");
}

console.log(bad ? `\n${bad} failing case(s)` : "\nContext is compacted at 98%, and only then.");
process.exit(bad ? 1 : 0);
