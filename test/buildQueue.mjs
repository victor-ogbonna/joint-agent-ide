/**
 * Builds take turns: a few at once, the rest wait in line, first come first
 * served. On a 2-core, 4 GB server that is 2 at a time.
 */
import { BuildQueue, ServerBusyError, defaultBuildSlots } from "../server/buildQueue.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const GB = 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("How many at once");
check(defaultBuildSlots(2, 3.8 * GB) === 2, "a 2-core, 4 GB server (as Linux reports it): 2");
check(defaultBuildSlots(2, 1.9 * GB) === 1, "a 2 GB server: 1, whatever its cores");
check(defaultBuildSlots(4, 7.7 * GB) === 4, "4 cores, 8 GB: 4");
check(defaultBuildSlots(8, 3.8 * GB) === 2, "memory caps it below the cores");
check(defaultBuildSlots(1, 0.5 * GB) === 1 && defaultBuildSlots(0, 16 * GB) === 1, "never fewer than 1");

console.log("Taking turns");
{
  const q = new BuildQueue(2, 5000, 50);
  let running = 0, peak = 0;
  const order = [];
  const job = (id, ms) => async () => {
    running++; peak = Math.max(peak, running); order.push(id);
    await sleep(ms);
    running--;
    return id;
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map((id) => q.run(job(id, 40))));
  check(peak === 2, "never more than 2 at once", `peak ${peak}`);
  check(order.join() === "1,2,3,4,5", "first come, first served", order.join());
  check(results.join() === "1,2,3,4,5", "each gets its own result");
  check(q.runningNow === 0 && q.waitingNow === 0, "the line is empty afterwards");
  check(q.waitedCount === 3 && q.longestWaitMs >= 30, "the waits are counted", `${q.waitedCount} waited, longest ${q.longestWaitMs} ms`);
}
{
  const q = new BuildQueue(1, 5000, 50);
  const failing = q.run(async () => { await sleep(10); throw new Error("compile error"); });
  const next = q.run(async () => "next ran");
  let err = null;
  try { await failing; } catch (e) { err = e; }
  check(err?.message === "compile error", "a failed build reports its own error");
  check(await next === "next ran", "and still hands its turn to the next");
}
{
  const q = new BuildQueue(1, 50, 50);
  const long = q.run(() => sleep(200).then(() => "done"));
  let busy = null;
  try { await q.run(async () => "never"); } catch (e) { busy = e; }
  check(busy instanceof ServerBusyError && /very busy/.test(busy.message), "a wait past the limit gives up with a plain message");
  check(await long === "done" && q.waitingNow === 0, "and leaves the line tidy");
}
{
  const q = new BuildQueue(1, 5000, 2);
  const a = q.run(() => sleep(60));
  const b = q.run(() => sleep(10));
  const c = q.run(() => sleep(10));
  let busy = null;
  try { await q.run(async () => "never"); } catch (e) { busy = e; }
  check(busy instanceof ServerBusyError, "a line that's too long turns new builds away at once");
  await Promise.all([a, b, c]);
  check(q.runningNow === 0, "everyone already in line still finished");
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
