import { spawn } from "child_process";

/**
 * Running a compile.
 *
 * execFile ran the compiler with no time limit, with an open input the
 * build could wait on forever, and a timeout on it would only have stopped
 * the top process, leaving the compiler it started running. Each stuck
 * compile held one of the server's few build slots for good.
 *
 * runBuild behaves like execFile otherwise (the same result, the same error
 * shape), but:
 *   - the build gets empty input, so nothing in it can wait for input;
 *   - it runs in its own process group, and on a timeout the whole group is
 *     stopped: the build tool and every compiler it started;
 *   - it stops after `timeoutMs`, with an error saying so (timedOut: true).
 */

/** Long enough for the slowest honest ESP32 build on a busy 2-core server. */
export const COMPILE_TIMEOUT_MS = 8 * 60 * 1000;

export interface BuildOutput {
  stdout: string;
  stderr: string;
}

export interface BuildOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  timeoutMs: number;
  /** Most output kept from stdout and stderr together, like execFile's maxBuffer. */
  maxBuffer?: number;
}

export function runBuild(file: string, args: string[], opts: BuildOptions): Promise<BuildOutput> {
  return new Promise((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? 50 * 1024 * 1024;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        uid: opts.uid,
        gid: opts.gid,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group (and session), so it can be stopped as a whole.
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const stopGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxBuffer) { overflow = true; stopGroup(); return; }
      into.push(chunk);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(errOut));

    const timer = setTimeout(() => { timedOut = true; stopGroup(); }, opts.timeoutMs);
    const text = (parts: Buffer[]) => Buffer.concat(parts).toString("utf8");
    // The group is only ever stopped while the build is still running (on a
    // timeout or runaway output): once it has exited, its number may belong
    // to someone else's build.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on("error", (err: any) => finish(() => reject(Object.assign(err, { stdout: text(out), stderr: text(errOut) }))));
    child.on("close", (code, signal) => finish(() => {
      const stdout = text(out);
      const stderr = text(errOut);
      if (timedOut) {
        const minutes = Math.round(opts.timeoutMs / 60000);
        reject(Object.assign(new Error(`The compile took longer than ${minutes} minutes and was stopped.`), { timedOut: true, stdout, stderr }));
      } else if (overflow) {
        reject(Object.assign(new Error("The compile printed too much output and was stopped."), { stdout, stderr }));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(`Command failed: ${[file, ...args].join(" ")}\n${stderr}`), { code, signal, stdout, stderr }));
      }
    }));
  });
}

/**
 * An #include naming a file on the server rather than a library header:
 * an absolute path, a home folder, or a step up out of the project. No
 * sketch needs one; some would hang or flood the compiler. The first found.
 */
export function fileSystemInclude(code: string): string | null {
  for (const m of code.matchAll(/#\s*include\s*[<"]([^>"\r\n]*)[>"]/g)) {
    const target = m[1].trim();
    if (target.startsWith("/") || target.startsWith("~") || target.includes("\\") || target.split("/").includes("..")) {
      return target;
    }
  }
  return null;
}
