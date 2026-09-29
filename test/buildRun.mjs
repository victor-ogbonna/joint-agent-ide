/**
 * Compiles have a time limit, and when it passes the whole build stops: the
 * build tool and every process it started. A build gets empty input, so it
 * can never wait on it. File paths in #include are refused.
 */
import { execFileSync } from "child_process";
import os from "os";
import { runBuild, fileSystemInclude, COMPILE_TIMEOUT_MS } from "../server/buildRun.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = (marker) => {
  try { return execFileSync("ps", ["-eo", "args"]).toString().split("\n").filter((l) => l.includes(marker) && !l.includes("ps -eo")).length; }
  catch { return 0; }
};
const cwd = os.tmpdir();

console.log("Like execFile when all goes well or badly");
{
  const r = await runBuild("sh", ["-c", "echo hello; echo warn >&2; pwd"], { cwd, timeoutMs: 5000 });
  check(r.stdout.startsWith("hello\n") && r.stderr === "warn\n", "output and errors come back separately");
  check(r.stdout.trim().endsWith(cwd), "it runs in the folder it's given");
  let err = null;
  try { await runBuild("sh", ["-c", "echo partial; echo broke >&2; exit 3"], { cwd, timeoutMs: 5000 }); } catch (e) { err = e; }
  check(err && err.code === 3 && err.stdout === "partial\n" && err.stderr === "broke\n" && /^Command failed: sh -c/.test(err.message) && err.message.includes("broke"),
    "a failed build rejects with its code, output and message, as before");
  let missing = null;
  try { await runBuild("/nonexistent/pio", ["run"], { cwd, timeoutMs: 5000 }); } catch (e) { missing = e; }
  check(missing && missing.code === "ENOENT", "a missing build tool rejects instead of hanging");
}

console.log("Nothing can wait for input");
{
  const t0 = Date.now();
  const r = await runBuild("sh", ["-c", "cat; echo done"], { cwd, timeoutMs: 5000 });
  check(r.stdout === "done\n" && Date.now() - t0 < 3000, "reading input finds it empty at once");
}

console.log("A build that runs too long is stopped, all of it");
{
  const marker = "31.4159";
  const t0 = Date.now();
  let err = null;
  try { await runBuild("sh", ["-c", `sleep ${marker} & sleep ${marker}; wait`], { cwd, timeoutMs: 400 }); } catch (e) { err = e; }
  const took = Date.now() - t0;
  check(err && err.timedOut === true && /took longer than/.test(err.message), "it rejects saying it took too long", err?.message);
  check(took < 3000, "right at the limit", `${took} ms`);
  await sleep(200);
  check(running(marker) === 0, "and every process it started is gone too", `${running(marker)} left`);
}

console.log("Runaway output is stopped");
{
  let err = null;
  try { await runBuild("sh", ["-c", "yes | head -c 500000; sleep 5"], { cwd, timeoutMs: 5000, maxBuffer: 10000 }); } catch (e) { err = e; }
  check(err && /too much output/.test(err.message), "past the output limit it stops", err?.message);
}

console.log("The limit");
check(COMPILE_TIMEOUT_MS === 8 * 60 * 1000, "8 minutes: well past the slowest honest ESP32 build");

console.log("File paths in #include are refused");
for (const [code, expected] of [
  ['#include "/dev/zero"', "/dev/zero"],
  ["#include </etc/passwd>", "/etc/passwd"],
  ['#include "~/.ssh/id_rsa"', "~/.ssh/id_rsa"],
  ['#include "../secret.h"', "../secret.h"],
  ['#include "lib/../../x.h"', "lib/../../x.h"],
  ['#include "a\\b.h"', "a\\b.h"],
  ['  #  include   "/proc/self/environ"', "/proc/self/environ"],
]) {
  check(fileSystemInclude(`#include <Arduino.h>\n${code}\nvoid setup(){}`) === expected, `refused: ${code.trim()}`);
}
check(fileSystemInclude('#include <Arduino.h>\n#include <avr/io.h>\n#include "config.h"\n#include <esp32/rom/rtc.h>\n#include <Adafruit_GFX.h>\n') === null, "ordinary headers, with or without folders, are fine");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
