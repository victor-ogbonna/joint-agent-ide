import fs from "fs";
import path from "path";
import util from "util";
import { execFile } from "child_process";
import { buildEnv } from "./buildEnv";

const execFilePromise = util.promisify(execFile);

/**
 * Builds run under their own account, never the server's.
 *
 * The server runs as root, and everything secret is readable by root: its
 * keys (in its own environment, /proc/1/environ) and its settings and users'
 * libraries (in ADMIN_CONFIG_DIR). A build compiles code a user wrote, with
 * libraries other people wrote, and a C compiler will happily #include any
 * file it can read and print it back in an error. Run as a separate,
 * unprivileged account (BUILD_USER; the Docker image makes "jabuild", which
 * owns the compiler's folder), a build can read none of that.
 *
 * Checked once at startup: if the account is missing or can't run the
 * compiler, builds carry on exactly as before and the log says why, so a
 * setup problem never stops anyone compiling. /api/status reports which.
 */

export interface BuildAccount {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** An account from /etc/passwd ("name:x:uid:gid:gecos:home:shell"). */
export function lookupAccount(name: string, passwd?: string): BuildAccount | null {
  let text = passwd;
  if (text === undefined) {
    try { text = fs.readFileSync("/etc/passwd", "utf8"); } catch { return null; }
  }
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length < 7 || f[0] !== name) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) return null;
    return { name, uid, gid, home: f[5] || "/tmp" };
  }
  return null;
}

let account: BuildAccount | null = null;
let state = { isolated: false, reason: "not checked yet" };
let ready: Promise<void> = Promise.resolve();

/** Whether builds are running under their own account, and if not, why. */
export function buildIsolation(): { isolated: boolean; reason: string } {
  return { ...state };
}

/** How to launch the compiler: its environment and, once isolated, the account to run as. */
export async function compilerOptions(coreDir: string): Promise<{ env: NodeJS.ProcessEnv; uid?: number; gid?: number }> {
  await ready;
  const env = buildEnv(coreDir);
  if (!account) return { env };
  return { env: { ...env, HOME: account.home, USER: account.name, LOGNAME: account.name }, uid: account.uid, gid: account.gid };
}

/** Give a build folder to the build account, so the build can work in it. */
export function handOver(dir: string): void {
  if (!account) return;
  const { uid, gid } = account;
  const walk = (p: string) => {
    fs.lchownSync(p, uid, gid);
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
  };
  walk(dir);
}

/**
 * Check the build account and, if it is fit to use, switch every build to
 * it. `privatePaths` are made readable by the server alone first.
 */
export function setUpBuildAccount(opts: { coreDir: string; pioPath: string; privatePaths: string[] }): Promise<void> {
  ready = (async () => {
    const name = String(process.env.BUILD_USER || "").trim();
    const fail = (reason: string) => {
      account = null;
      state = { isolated: false, reason };
      if (name) console.error(`[Build account] Builds are NOT isolated: ${reason}. They run as before.`);
    };
    if (!name) return fail("BUILD_USER is not set");
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return fail("the server isn't running as root, so it can't switch accounts");
    const acct = lookupAccount(name);
    if (!acct) return fail(`there is no account called "${name}"`);
    if (acct.uid === 0) return fail(`"${name}" is root`);

    for (const p of opts.privatePaths) {
      try {
        if (!fs.existsSync(p)) continue;
        fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600);
      } catch (err: any) {
        return fail(`${p} couldn't be made private (${err?.message || err})`);
      }
    }

    const as = {
      uid: acct.uid,
      gid: acct.gid,
      env: { ...buildEnv(opts.coreDir), HOME: acct.home, USER: acct.name, LOGNAME: acct.name },
      timeout: 120000,
    };
    const probe = async (script: string, args: string[]) => {
      try { await execFilePromise("/bin/sh", ["-c", script, "sh", ...args], as); return true; } catch { return false; }
    };
    // What the account must be able to do…
    if (!(await probe('test -w "$1" && test -x "$2"', [opts.coreDir, opts.pioPath]))) {
      return fail(`"${name}" can't use the compiler in ${opts.coreDir}`);
    }
    for (const sub of ["packages", "platforms", "penv", ".cache", "appstate.json"]) {
      const p = path.join(opts.coreDir, sub);
      if (fs.existsSync(p) && !(await probe('test -w "$1"', [p]))) return fail(`"${name}" can't write ${p}`);
    }
    // …and what it must not.
    if (await probe('test -r "$1"', [`/proc/${process.pid}/environ`])) return fail(`"${name}" can read the server's environment`);
    for (const p of opts.privatePaths) {
      if (fs.existsSync(p) && await probe('test -r "$1" || test -x "$1"', [p])) return fail(`"${name}" can still read ${p}`);
    }
    try {
      await execFilePromise(opts.pioPath, ["--version"], { ...as, cwd: "/tmp" });
    } catch (err: any) {
      return fail(`the compiler doesn't start as "${name}" (${String(err?.stderr || err?.message || err).trim().split("\n").pop()})`);
    }

    account = acct;
    state = { isolated: true, reason: `builds run as "${name}"` };
    console.log(`[Build account] Builds run as "${name}" (uid ${acct.uid}), away from the server's keys and data.`);
  })();
  return ready;
}
