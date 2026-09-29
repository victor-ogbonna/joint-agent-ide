/**
 * The build cache: off means every compile is exactly as before; on, each
 * compile gets a small build script pointing at a cache kept per set of
 * installed compilers, and the cache is trimmed to its limit.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  useBuildCache, buildCacheScript, toolchainFingerprint, pruneBuildCache, readyBuildCache,
  buildCacheEnabled, buildCacheMaxBytes, buildCacheRoot, buildCacheSize, SCRIPT_NAME,
} from "../server/buildCache.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const made = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `bc_${name}_`)); made.push(d); return d; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const MB = 1024 * 1024;

/** A PlatformIO folder with an AVR platform and two packages. */
function fakeCore() {
  const core = tmp("core");
  write(path.join(core, "platforms/atmelavr/.piopm"), JSON.stringify({ name: "atmelavr", version: "5.1.0" }));
  write(path.join(core, "packages/toolchain-atmelavr/.piopm"), JSON.stringify({ name: "toolchain-atmelavr", version: "1.70300.191015" }));
  write(path.join(core, "packages/framework-arduino-avr/package.json"), JSON.stringify({ name: "framework-arduino-avr", version: "5.2.0" }));
  return core;
}

console.log("Switched off (the default)");
{
  check(buildCacheEnabled({}) === false, "off when BUILD_CACHE isn't set");
  check(buildCacheEnabled({ BUILD_CACHE: "off" }) === false && buildCacheEnabled({ BUILD_CACHE: "1" }) === false, "off for anything but \"on\"");
  check(buildCacheEnabled({ BUILD_CACHE: "on" }) && buildCacheEnabled({ BUILD_CACHE: " ON " }), "on with BUILD_CACHE=on");
  const project = tmp("proj");
  const line = useBuildCache(project, fakeCore(), {});
  check(line === "", "adds nothing to platformio.ini");
  check(fs.readdirSync(project).length === 0, "writes nothing into the compile's folder");

  // The compile route's platformio.ini, as the server builds it.
  const base = "\n[env:uno]\nplatform = atmelavr\nboard = uno\nframework = arduino\nlib_deps =\n  Servo\n";
  check(base + useBuildCache(project, fakeCore(), {}) === base, "so platformio.ini is byte for byte what it was");
}

console.log("Switched on");
{
  const core = fakeCore();
  const project = tmp("proj");
  const line = useBuildCache(project, core, { BUILD_CACHE: "on" });
  const script = path.join(project, SCRIPT_NAME);
  check(line === `extra_scripts = pre:${script}\n`, "adds one line: run the cache script before the build", JSON.stringify(line));
  check(fs.existsSync(script), "the script is in the compile's own folder");
  const text = fs.readFileSync(script, "utf8");
  const expectedDir = path.join(buildCacheRoot(core), toolchainFingerprint(core));
  check(text.includes(`CACHE_DIR = ${JSON.stringify(expectedDir)}`), "it points at this compiler set's cache", expectedDir);
  check(/env\.NoCache\(.*\n?/.test(text) && text.includes('"firmware.elf", "firmware.hex", "firmware.bin"'), "the finished firmware is never taken from the cache");
  check(/except Exception:\n    env\.CacheDir\(None\)/.test(text), "any cache problem turns the cache off and the compile carries on");
  check(text.includes("os.access(folder, os.W_OK | os.X_OK)"), "only used when the build account can write to it");
  const ini = "\n[env:uno]\nplatform = atmelavr\nboard = uno\nframework = arduino\nlib_deps =\n" + line;
  check(/lib_deps =\nextra_scripts = pre:\/.+\/build_cache\.py\n$/.test(ini), "platformio.ini: the line follows an empty lib_deps cleanly");
  try {
    execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", script]);
    check(true, "the script is valid Python");
  } catch (e) {
    check(false, "the script is valid Python", String(e.stderr || e.message));
  }
  const odd = buildCacheScript('/a "quoted" \\ path/é');
  try {
    const out = execFileSync("python3", ["-c", "import ast,sys; t=ast.parse(sys.stdin.read()); print([n.value.value for n in t.body if isinstance(n, ast.Assign)][0])"], { input: odd }).toString().trim();
    check(out === '/a "quoted" \\ path/é', "any folder name is written into the script exactly", out);
  } catch (e) {
    check(false, "any folder name is written into the script exactly", String(e.stderr || e.message));
  }
  const unwritable = useBuildCache("/nonexistent/folder", core, { BUILD_CACHE: "on" });
  check(unwritable === "", "if the script can't be written, the compile goes ahead without the cache");
}

console.log("One cache per set of compilers");
{
  const core = fakeCore();
  const a = toolchainFingerprint(core);
  check(a === toolchainFingerprint(core) && /^[0-9a-f]{16}$/.test(a), "the same installed set always gives the same cache", a);
  write(path.join(core, "packages/toolchain-atmelavr/.piopm"), JSON.stringify({ name: "toolchain-atmelavr", version: "1.70300.999999" }));
  const b = toolchainFingerprint(core);
  check(b !== a, "a compiler update gives a new, empty cache");
  write(path.join(core, "platforms/espressif32/.piopm"), JSON.stringify({ name: "espressif32", version: "6.9.0" }));
  const c = toolchainFingerprint(core);
  check(c !== b, "installing another platform gives a new cache too");
  fs.mkdirSync(path.join(core, "packages/_tmp_installing-abc"), { recursive: true });
  fs.mkdirSync(path.join(core, "packages/.cache"), { recursive: true });
  check(toolchainFingerprint(core) === c, "half-finished installs and hidden folders don't count");
  check(/^[0-9a-f]{16}$/.test(toolchainFingerprint("/nonexistent")), "no PlatformIO folder at all still gives a name");
}

console.log("Size limit");
{
  check(buildCacheMaxBytes({}) === 2048 * MB, "2 GB unless set");
  check(buildCacheMaxBytes({ BUILD_CACHE_MAX_MB: "500" }) === 500 * MB, "BUILD_CACHE_MAX_MB sets it");
  check(buildCacheMaxBytes({ BUILD_CACHE_MAX_MB: "5" }) === 2048 * MB && buildCacheMaxBytes({ BUILD_CACHE_MAX_MB: "lots" }) === 2048 * MB, "nonsense or tiny values are ignored");
}

console.log("Trimming");
{
  const root = tmp("root");
  const now = Date.now();
  const put = (rel, bytes, ageMs) => {
    const f = path.join(root, rel);
    write(f, "x".repeat(bytes));
    const t = (now - ageMs) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };
  const H = 60 * 60 * 1000;
  // The current compilers' cache: 10 files of 100 KB, oldest first.
  const current = [];
  for (let i = 0; i < 10; i++) current.push(put(`cur/AB${i}/obj${i}`, 100 * 1024, (10 - i) * H));
  const config = put("cur/config", 20, 100 * H);
  const tag = put("cur/CACHEDIR.TAG", 40, 100 * H);
  // An old compilers' cache, unused for a day, and one used a minute ago.
  put("old/AA/obj", 300 * 1024, 24 * H);
  put("recent/AA/obj", 50 * 1024, 60 * 1000);

  check(buildCacheSize(root) === 10 * 100 * 1024 + 60 + 350 * 1024, "measures every file", String(buildCacheSize(root)));

  // Under the limit: only the unused old cache goes.
  let r = pruneBuildCache(root, 10 * MB, "cur", now);
  check(!fs.existsSync(path.join(root, "old")), "an old compilers' cache unused for an hour is deleted");
  check(fs.existsSync(path.join(root, "recent/AA/obj")), "one used in the last hour is kept for now");
  check(current.every((f) => fs.existsSync(f)), "nothing else goes while the cache is under its limit");
  check(r.after === 10 * 100 * 1024 + 60 + 50 * 1024, "reports what's left", String(r.after));

  // Over the limit: least recently used first, down to three quarters.
  const limit = 800 * 1024;
  r = pruneBuildCache(root, limit, "cur", now);
  check(r.after <= limit * 0.75, "trimmed to three quarters of the limit", `${r.after} <= ${limit * 0.75}`);
  check(!fs.existsSync(current[0]) && !fs.existsSync(current[1]), "the least recently used went first");
  check(fs.existsSync(current[9]) && fs.existsSync(current[8]), "the most recently used stayed");
  check(fs.existsSync(config) && fs.existsSync(tag), "the cache's own settings file is never deleted");
  check(fs.statSync(path.join(root, "cur/AB0")).isDirectory(), "folders are left in place (a compile may be about to write there)");
  check(pruneBuildCache(path.join(root, "missing"), limit, "cur", now).before === 0, "no cache yet: nothing to do");
}

console.log("Ready for the build account");
{
  const core = fakeCore();
  const saved = process.env.BUILD_CACHE;
  process.env.BUILD_CACHE = "on";
  readyBuildCache(core);
  check(fs.statSync(buildCacheRoot(core)).isDirectory(), "the cache folder is made");
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const root = buildCacheRoot(core);
    write(path.join(root, toolchainFingerprint(core), "AB/obj"), "x");
    readyBuildCache(core, 54321, 54321);
    const owned = [root, path.join(root, toolchainFingerprint(core)), path.join(root, toolchainFingerprint(core), "AB/obj")]
      .every((p) => fs.lstatSync(p).uid === 54321 && fs.lstatSync(p).gid === 54321);
    check(owned, "everything in it is handed to the build account");
    fs.lchownSync(path.join(root, toolchainFingerprint(core), "AB/obj"), 0, 0);
    readyBuildCache(core, 54321, 54321);
    check(fs.lstatSync(path.join(root, toolchainFingerprint(core), "AB/obj")).uid === 0, "checked once per server start, not on every compile");
  } else {
    console.log("  skip  ownership (needs root)");
  }
  if (saved === undefined) delete process.env.BUILD_CACHE; else process.env.BUILD_CACHE = saved;
  const off = fakeCore();
  readyBuildCache(off);
  check(!fs.existsSync(buildCacheRoot(off)), "with the cache off, no folder is made");
}

for (const d of made) fs.rmSync(d, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
