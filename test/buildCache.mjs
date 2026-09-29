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
  damagedCacheFailure, reportDamagedCache, retireDamagedCache,
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

console.log("Libraries are reused too");
{
  // The script run as a compile runs it (one process per compile), against a
  // stand-in for PlatformIO's library builder: build_dir exactly as
  // PlatformIO defines it.
  const harness = `
import sys, types, os, hashlib, json
mod = types.ModuleType("piolib")
class LibBuilderBase:
    def __init__(self, path): self.path = path
    @property
    def build_dir(self):
        lib_hash = hashlib.sha1(self.path.encode("utf-8")).hexdigest()[:3]
        return os.path.join("$BUILD_DIR", "lib%s" % lib_hash, os.path.basename(self.path))
class ArduinoLibBuilder(LibBuilderBase): pass
mod.LibBuilderBase = LibBuilderBase
sys.modules["piolib"] = mod
class Env:
    def __init__(self, project): self.project = project; self.cache = "unset"
    def subst(self, s): return {"$PROJECT_DIR": self.project, "$BUILD_DIR": self.project + "/.pio/build/uno"}.get(s, s)
    def CacheDir(self, p): self.cache = p
    def NoCache(self, p): pass
script, project, framework_lib = sys.argv[1:4]
original = LibBuilderBase.__dict__["build_dir"]
env = Env(project)
for _ in range(2):
    exec(open(script).read(), {"Import": lambda name: None, "env": env})
now = LibBuilderBase.__dict__["build_dir"]
inner = now.fget.__closure__[0].cell_contents if now.fget.__closure__ else None
dht = project + "/.pio/libdeps/uno/DHT sensor library"
print(json.dumps({
    "cache": env.cache,
    "changed": now is not original,
    "wrapsOriginal": inner is original,
    "dht": ArduinoLibBuilder(dht).build_dir,
    "dhtBefore": original.fget(ArduinoLibBuilder(dht)),
    "imported": ArduinoLibBuilder(project + "/lib/Cfg").build_dir,
    "project": LibBuilderBase(project).build_dir,
    "projectBefore": original.fget(LibBuilderBase(project)),
    "framework": ArduinoLibBuilder(framework_lib).build_dir,
    "frameworkBefore": original.fget(ArduinoLibBuilder(framework_lib)),
}))
`;
  const script = (cacheParent) => {
    const f = path.join(tmp("proj"), SCRIPT_NAME);
    fs.writeFileSync(f, buildCacheScript(path.join(cacheParent, "fp")));
    return f;
  };
  const compile = (scriptFile) => {
    try {
      return JSON.parse(execFileSync("python3", ["-c", harness, scriptFile, tmp("proj"), "/opt/core/packages/framework-arduino-avr/libraries/Wire"]).toString());
    } catch (e) {
      return { error: String(e.stderr || e.message) };
    }
  };
  const on = script(tmp("cache"));
  const a = compile(on), b = compile(on);
  check(!a.error && !b.error, "the script runs", a.error || b.error || "");
  if (!a.error && !b.error) {
    check(a.cache.endsWith("/fp") && b.cache.endsWith("/fp"), "the cache is on");
    check(a.dht === b.dht && a.dht !== a.dhtBefore && /^\$BUILD_DIR\/lib[0-9a-f]{8}\/DHT sensor library$/.test(a.dht),
      "a downloaded library builds in the same folder in every compile", `${a.dht} / ${b.dht}`);
    check(a.imported === b.imported && a.imported !== a.dht && /^\$BUILD_DIR\/lib[0-9a-f]{8}\/Cfg$/.test(a.imported),
      "an imported library too, in a folder of its own", a.imported);
    check(/^\$BUILD_DIR\/lib[0-9a-f]{3}\/Wire$/.test(a.framework),
      "a library outside the compile's folder can't share a folder with one inside (different tag length)", a.framework);
    check(a.framework === a.frameworkBefore && a.framework.endsWith("/Wire"),
      "a library outside the compile's folder keeps PlatformIO's own folder", a.framework);
    check(a.project === a.projectBefore, "the project itself is left alone");
    check(a.changed && a.wrapsOriginal, "running the script twice changes it only once");
  }
  // With the cache folder unusable the cache is off, and PlatformIO is untouched.
  const off = compile(script("/nonexistent/place"));
  check(!off.error && off.cache === "unset" && !off.changed && off.dht === off.dhtBefore,
    "with the cache off, libraries are built exactly as before", off.error || off.dht);
}

console.log("A damaged file in the cache");
{
  const retrieved = "Retrieved `.pio/build/uno/libFrameworkArduino.a' from cache\nLinking .pio/build/uno/firmware.elf\n";
  check(damagedCacheFailure(retrieved + "ld: .pio/build/uno/libFrameworkArduino.a: file format not recognized; treating as linker script\ncollect2: error: ld returned 1 exit status"),
    "the linker rejecting a file taken from the cache is recognised");
  check(damagedCacheFailure(retrieved + "ld: .pio/build/uno/src/main.cpp.o: file truncated") && damagedCacheFailure(retrieved + "ar: malformed archive"),
    "so are a truncated file and a broken archive");
  check(!damagedCacheFailure(retrieved + "src/main.cpp:3:1: error: expected ';' before '}' token"), "a mistake in the code is not");
  check(!damagedCacheFailure(retrieved + "undefined reference to `setup'"), "nor a missing function");
  check(!damagedCacheFailure("Compiling .pio/build/uno/src/main.cpp.o\nld: libfoo.a: file format not recognized"),
    "nor a bad file when nothing came from the cache");

  const core = fakeCore();
  const current = path.join(buildCacheRoot(core), toolchainFingerprint(core));
  write(path.join(current, "AB/obj"), "x");
  check(retireDamagedCache(core) === null && fs.existsSync(current), "nothing is set aside unless a damaged file was reported");
  reportDamagedCache();
  const now = Date.now();
  const retired = retireDamagedCache(core, now);
  check(retired === `${current}.damaged-${now}` && !fs.existsSync(current) && fs.existsSync(path.join(retired, "AB/obj")),
    "after one, the cache folder is set aside and the next compile starts a fresh one");
  check(retireDamagedCache(core) === null, "once");
  reportDamagedCache();
  check(retireDamagedCache(core) === null, "no cache folder to set aside: nothing happens");
  const t = (now - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(retired, "AB/obj"), t, t);
  pruneBuildCache(buildCacheRoot(core), 10 * MB, toolchainFingerprint(core), now);
  check(!fs.existsSync(retired), "trimming deletes it once it has been unused for an hour");
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
