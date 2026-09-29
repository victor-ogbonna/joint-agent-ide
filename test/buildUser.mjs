/**
 * Builds run under their own account when BUILD_USER names one that passes
 * the startup check, and exactly as before otherwise.
 */
import { lookupAccount, setUpBuildAccount, compilerOptions, buildIsolation, handOver } from "../server/buildUser.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const passwd = [
  "root:x:0:0:root:/root:/bin/bash",
  "node:x:1000:1000::/home/node:/bin/bash",
  "jabuild:x:999:999::/home/jabuild:/usr/sbin/nologin",
  "broken:x:abc:1::/x:/bin/sh",
  "",
].join("\n");
const acct = lookupAccount("jabuild", passwd);
check(acct && acct.uid === 999 && acct.gid === 999 && acct.home === "/home/jabuild", "an account is read from /etc/passwd", JSON.stringify(acct));
check(lookupAccount("jab", passwd) === null, "a name must match exactly, not by prefix");
check(lookupAccount("nobody-here", passwd) === null, "a missing account is none");
check(lookupAccount("broken", passwd) === null, "a malformed entry is none");

check(buildIsolation().isolated === false, "nothing is isolated before the check");
const before = await compilerOptions("/core");
check(before.uid === undefined && before.env.PLATFORMIO_CORE_DIR === "/core", "until then, builds run as before");

delete process.env.BUILD_USER;
await setUpBuildAccount({ coreDir: "/core", pioPath: "/core/penv/bin/pio", privatePaths: [] });
check(!buildIsolation().isolated && /not set/.test(buildIsolation().reason), "no BUILD_USER: not isolated, and nothing changes");

process.env.BUILD_USER = "no-such-account-here";
await setUpBuildAccount({ coreDir: "/core", pioPath: "/core/penv/bin/pio", privatePaths: [] });
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
check(!buildIsolation().isolated && (runningAsRoot ? /no account called/ : /isn't running as root/).test(buildIsolation().reason),
  "a BUILD_USER that can't be used leaves builds as they were", buildIsolation().reason);
const after = await compilerOptions("/core");
check(after.uid === undefined && after.gid === undefined && !("GEMINI_API_KEY" in after.env), "and they still get no secret keys");
delete process.env.BUILD_USER;
handOver("/definitely/not/a/folder");
check(true, "handing over a folder does nothing while not isolated");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
