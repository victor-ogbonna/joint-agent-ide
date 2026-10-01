/**
 * Builds take turns: a few at once, the rest wait in line, first come first
 * served. Each account has one build running at a time.
 */
import { BuildQueue, ServerBusyError, defaultBuildSlots, PER_ACCOUNT_RUNNING, PER_ACCOUNT_WAITING } from "../server/buildQueue.ts";

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

console.log("Five at once, one per account");
check(PER_ACCOUNT_RUNNING === 1 && PER_ACCOUNT_WAITING === 3, "the server's rule: 1 running and up to 3 waiting per account");
{
  // Six people press Compile at the same moment.
  const q = new BuildQueue(5, 5000, 60);
  let running = 0, peak = 0;
  const started = [];
  const job = (id, ms) => async () => { running++; peak = Math.max(peak, running); started.push(id); await sleep(ms); running--; return id; };
  const all = ["A", "B", "C", "D", "E", "F"].map((who) => q.run(job(who, 60), undefined, who));
  await sleep(10);
  check(q.runningNow === 5 && q.waitingNow === 1, "six people at once: five compile, the sixth waits", `${q.runningNow} running, ${q.waitingNow} waiting`);
  const results = await Promise.all(all);
  check(peak === 5, "never more than five at once", `peak ${peak}`);
  check(started.at(-1) === "F" && results.join() === "A,B,C,D,E,F", "the sixth goes when a slot frees, and everyone gets their own result");
}
{
  // One person presses Compile three times, then someone else presses once.
  const q = new BuildQueue(5, 5000, 60);
  const mine = [];
  let mineAtOnce = 0, minePeak = 0;
  const myJob = (id) => async () => { mineAtOnce++; minePeak = Math.max(minePeak, mineAtOnce); mine.push(id); await sleep(40); mineAtOnce--; return id; };
  const a = [1, 2, 3].map((n) => q.run(myJob(n), undefined, "alice"));
  await sleep(5);
  let bobStartedAt = -1;
  const t0 = Date.now();
  const b = q.run(async () => { bobStartedAt = Date.now() - t0; return "bob"; }, undefined, "bob");
  check(await b === "bob" && bobStartedAt >= 0 && bobStartedAt < 30, "someone else starts at once, without waiting behind her line", `${bobStartedAt} ms`);
  const mineResults = await Promise.all(a);
  check(minePeak === 1, "one account's compiles run one at a time", `peak ${minePeak}`);
  check(mine.join() === "1,2,3" && mineResults.join() === "1,2,3", "in the order she pressed them");
}
{
  // Two slots. A1 and B1 run; A2 then C1 wait. When B1 ends, C1 goes ahead of
  // A2, whose account is still busy; A2 goes when A1 ends.
  const q = new BuildQueue(2, 5000, 60);
  const order = [];
  const job = (id, ms) => async () => { order.push(id); await sleep(ms); return id; };
  const a1 = q.run(job("A1", 80), undefined, "A");
  const b1 = q.run(job("B1", 20), undefined, "B");
  const a2 = q.run(job("A2", 10), undefined, "A");
  const c1 = q.run(job("C1", 10), undefined, "C");
  await Promise.all([a1, b1, a2, c1]);
  check(order.join() === "A1,B1,C1,A2", "a waiting compile whose account is busy doesn't hold up the next person", order.join());
  check(q.runningNow === 0 && q.waitingNow === 0, "the line is empty afterwards");
}
{
  // A script sending many at once from one account.
  const q = new BuildQueue(5, 5000, 60);
  const runs = [0, 1, 2, 3].map(() => q.run(() => sleep(30), undefined, "script"));
  let refused = null;
  try { await q.run(async () => "never", undefined, "script"); } catch (e) { refused = e; }
  check(refused instanceof ServerBusyError && /already have compiles waiting/.test(refused.message),
    "a fifth from one account (1 running, 3 waiting) is turned away, with its own message");
  const other = await q.run(async () => "other person", undefined, "someone-else");
  check(other === "other person", "while anyone else still compiles at once");
  await Promise.all(runs);
}
{
  // A failed compile still frees its account for the next one.
  const q = new BuildQueue(5, 5000, 60);
  const failing = q.run(async () => { await sleep(10); throw new Error("compile error"); }, undefined, "A");
  const next = q.run(async () => "next ran", undefined, "A");
  let err = null;
  try { await failing; } catch (e) { err = e; }
  check(err?.message === "compile error" && await next === "next ran", "after a failed compile, the same account's next one runs");
}
{
  // A wait that gives up must not leave the account counted as busy.
  const q = new BuildQueue(1, 40, 60);
  const long = q.run(() => sleep(120), undefined, "A");
  let gaveUp = null;
  try { await q.run(async () => "never", undefined, "B"); } catch (e) { gaveUp = e; }
  await long;
  check(gaveUp instanceof ServerBusyError, "a wait past the limit still gives up");
  check(await q.run(async () => "fresh", undefined, "B") === "fresh" && q.runningNow === 0, "and that account can compile again afterwards");
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
