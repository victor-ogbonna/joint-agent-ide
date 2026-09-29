import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Reusing compiled files between compiles.
 *
 * Every compile starts in a new, empty folder, so the Arduino core (and any
 * library) is compiled from scratch each time, although it is the same for
 * everyone on the same board. With the cache on, the build system files each
 * compiled piece under a fingerprint of everything that went into it: the
 * source, every header it includes, and the compiler flags. The next compile
 * that needs exactly the same piece copies it instead of compiling it again.
 * Anything that differs, however slightly, gets its own entry, so a user's
 * own code is always compiled from their own code.
 *
 * Libraries are reused too, both downloaded ones and ones a user imported:
 * see the build script below.
 *
 * Kept safe by:
 * - a separate cache for each set of installed compilers and board packages,
 *   so after an update nothing made by the old compiler is ever reused;
 * - the finished firmware (.elf, .hex, .bin) is never taken from the cache:
 *   every compile links its own;
 * - any problem with the cache folder only switches the cache off for that
 *   compile, which then runs exactly as it would without a cache;
 * - a file in the cache damaged on disk makes the linker reject it; the
 *   server then compiles again without the cache and sets that cache aside
 *   (damagedCacheFailure, retireDamagedCache);
 * - old entries are deleted when the cache outgrows its limit, and only while
 *   no compile is running.
 *
 * Off unless BUILD_CACHE=on. BUILD_CACHE_MAX_MB sets the limit (2048).
 */

export const SCRIPT_NAME = "build_cache.py";
const DEFAULT_MAX_MB = 2048;
/** Files SCons keeps in each cache folder for itself. */
const CACHE_OWN_FILES = new Set(["config", "config.lock", "CACHEDIR.TAG"]);

export function buildCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.BUILD_CACHE || "").trim().toLowerCase() === "on";
}

export function buildCacheMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.BUILD_CACHE_MAX_MB);
  return (Number.isFinite(mb) && mb >= 100 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}

export function buildCacheRoot(coreDir: string): string {
  return path.join(coreDir, "build-cache");
}

function versionOf(dir: string): string {
  for (const file of [".piopm", "package.json", "platform.json"]) {
    try {
      const version = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))?.version;
      if (version) return String(version);
    } catch { /* try the next file */ }
  }
  return "unknown";
}

/**
 * A short name for the compilers and board packages installed right now.
 * Any update, addition or removal gives a new name, and so a fresh cache.
 */
export function toolchainFingerprint(coreDir: string): string {
  const lines: string[] = [];
  for (const kind of ["platforms", "packages"]) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(coreDir, kind)); } catch { /* nothing installed */ }
    for (const name of names.filter((n) => !n.startsWith(".") && !n.startsWith("_")).sort()) {
      lines.push(`${kind}/${name}@${versionOf(path.join(coreDir, kind, name))}`);
    }
  }
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * The build script that turns the cache on for one compile. It runs inside
 * the build before anything is compiled; if the folder can't be used, the
 * compile goes ahead without the cache.
 *
 * It also names the build folder of each library inside the compile's own
 * folder (downloaded ones in .pio/libdeps, imported ones in lib/) after the
 * library's path inside the project. PlatformIO names it after the library's
 * full path, which includes the compile's temporary folder, and the build
 * system files each cached piece under its folder too, so without this no
 * compile could reuse another's library pieces. A piece is still only reused
 * when everything that went into it is the same. PlatformIO defines that
 * name in one place (LibBuilderBase.build_dir); if it ever changes shape,
 * libraries are simply compiled as before.
 */
export function buildCacheScript(cacheDir: string): string {
  return [
    "# Written by the server for this compile: reuse files compiled by earlier compiles.",
    "# Any problem with the cache folder switches the cache off for this compile only.",
    'Import("env")',
    "import os",
    "",
    `CACHE_DIR = ${JSON.stringify(cacheDir)}`,
    "cache_on = False",
    "",
    "try:",
    "    folder = CACHE_DIR if os.path.isdir(CACHE_DIR) else os.path.dirname(CACHE_DIR)",
    "    if os.path.isdir(folder) and os.access(folder, os.W_OK | os.X_OK):",
    "        env.CacheDir(CACHE_DIR)",
    "        # The finished firmware is always linked fresh, never taken from the cache.",
    '        for name in ("firmware.elf", "firmware.hex", "firmware.bin"):',
    '            env.NoCache(os.path.join(env.subst("$BUILD_DIR"), name))',
    "        cache_on = True",
    "except Exception:",
    "    env.CacheDir(None)",
    "",
    "# Libraries in this compile's folder: build them in a folder named after their",
    "# path inside the project, not after this compile's temporary folder, so their",
    "# pieces can be reused. The tag is longer than PlatformIO's own (3), so these",
    "# folders can't clash with those of libraries outside the project, or with",
    "# each other. Any problem leaves PlatformIO as it is.",
    "if cache_on:",
    "    try:",
    "        import hashlib",
    "        import sys",
    "",
    '        project_dir = os.path.realpath(env.subst("$PROJECT_DIR"))',
    "",
    "        def same_folder_every_compile(original):",
    "            def build_dir(self):",
    "                try:",
    "                    lib_path = os.path.realpath(self.path)",
    "                    if lib_path != project_dir and os.path.commonpath([project_dir, lib_path]) == project_dir:",
    '                        inside = os.path.relpath(lib_path, project_dir).replace(os.sep, "/")',
    '                        tag = hashlib.sha1(inside.encode("utf-8")).hexdigest()[:8]',
    '                        return os.path.join("$BUILD_DIR", "lib" + tag, os.path.basename(self.path))',
    "                except Exception:",
    "                    pass",
    "                return original.fget(self)",
    "            build_dir.same_folder_every_compile = True",
    "            return property(build_dir)",
    "",
    "        for module in list(sys.modules.values()):",
    "            try:",
    '                builder = getattr(module, "LibBuilderBase", None)',
    '                named = builder.__dict__.get("build_dir") if isinstance(builder, type) else None',
    '                if isinstance(named, property) and not getattr(named.fget, "same_folder_every_compile", False):',
    "                    builder.build_dir = same_folder_every_compile(named)",
    "            except Exception:",
    "                pass",
    "    except Exception:",
    "        pass",
    "",
  ].join("\n");
}

// What the GNU linker and archiver say about a file they can't read. A
// mistake in the code never produces these; a damaged object file does.
const DAMAGED_FILE = /file format not recognized|file truncated|malformed archive|file in wrong format|archive has no index/i;

/**
 * Whether a compile failed because a file taken from the cache was damaged
 * (a disk fault, say): the build took files from the cache, and the linker
 * or archiver rejected a file as unreadable.
 */
export function damagedCacheFailure(output: string): boolean {
  return /^Retrieved `/m.test(output) && DAMAGED_FILE.test(output);
}

let damagedCacheSeen = false;

/** Notes that the current cache gave a compile a damaged file. */
export function reportDamagedCache(): void {
  damagedCacheSeen = true;
}

/**
 * Sets aside the cache that gave a compile a damaged file: renames this
 * compiler set's cache folder, so the next compile starts a fresh one, and
 * trimming deletes the old one once it has been unused for an hour. Call
 * only while no other compile is running, as one might be reading from it.
 * Returns the new name, or null if there was nothing to set aside.
 */
export function retireDamagedCache(coreDir: string, now = Date.now()): string | null {
  if (!damagedCacheSeen) return null;
  damagedCacheSeen = false;
  const current = path.join(buildCacheRoot(coreDir), toolchainFingerprint(coreDir));
  const retired = `${current}.damaged-${now}`;
  try {
    fs.renameSync(current, retired);
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.error("[Build cache] couldn't set the damaged cache aside:", err?.message || err);
    return null;
  }
  console.warn(`[Build cache] set aside a cache that held a damaged file: ${retired}`);
  return retired;
}

/**
 * Sets up the cache for one compile in `projectDir`: writes the script and
 * returns the line to add to platformio.ini's environment. Returns "" and
 * writes nothing when the cache is off, so the compile is exactly as before.
 */
export function useBuildCache(projectDir: string, coreDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!buildCacheEnabled(env)) return "";
  try {
    const cacheDir = path.join(buildCacheRoot(coreDir), toolchainFingerprint(coreDir));
    const script = path.join(projectDir, SCRIPT_NAME);
    fs.writeFileSync(script, buildCacheScript(cacheDir));
    return `extra_scripts = pre:${script}\n`;
  } catch (err: any) {
    console.error("[Build cache] off for this compile:", err?.message || err);
    return "";
  }
}

const readied = new Set<string>();

/**
 * Makes sure the cache folder exists and belongs to the account that runs
 * the builds (server/buildUser.ts), so builds can write to it. Only walks
 * the folder when its owner is wrong, e.g. after builds switched accounts.
 */
export function readyBuildCache(coreDir: string, uid?: number, gid?: number): void {
  if (!buildCacheEnabled()) return;
  const root = buildCacheRoot(coreDir);
  const current = path.join(root, toolchainFingerprint(coreDir));
  const key = `${current}:${uid ?? ""}`;
  if (readied.has(key)) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    if (uid !== undefined && gid !== undefined) {
      const wrong = [root, current].some((p) => {
        try { return fs.statSync(p).uid !== uid; } catch { return false; }
      });
      if (wrong) chownTree(root, uid, gid);
    }
    readied.add(key);
  } catch (err: any) {
    // The build script sees the folder isn't usable and compiles without it.
    console.error("[Build cache] couldn't prepare the cache folder:", err?.message || err);
  }
}

function chownTree(p: string, uid: number, gid: number): void {
  fs.lchownSync(p, uid, gid);
  const stat = fs.lstatSync(p);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(p)) chownTree(path.join(p, entry), uid, gid);
}

interface CacheFile { file: string; size: number; mtimeMs: number }

function walk(dir: string, out: CacheFile[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() || e.isSymbolicLink()) {
      try { const s = fs.lstatSync(p); out.push({ file: p, size: s.size, mtimeMs: s.mtimeMs }); } catch { /* gone */ }
    }
  }
}

/** How much space the cache takes, in bytes. */
export function buildCacheSize(root: string): number {
  const files: CacheFile[] = [];
  walk(root, files);
  return files.reduce((a, f) => a + f.size, 0);
}

/**
 * Keeps the cache under `maxBytes`. Caches for compilers that are no longer
 * installed go first (once unused for an hour), then the entries used least
 * recently, until the cache is down to three quarters of the limit. The
 * build system marks an entry as used each time it reuses it, so what
 * compiles need most stays. Call only while no compile is running.
 */
export function pruneBuildCache(root: string, maxBytes: number, keep: string, now = Date.now()) {
  const result = { before: 0, after: 0, removed: 0 };
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return result; }

  const files: CacheFile[] = [];
  for (const name of dirs) {
    const dir = path.join(root, name);
    const own: CacheFile[] = [];
    walk(dir, own);
    const size = own.reduce((a, f) => a + f.size, 0);
    result.before += size;
    const newest = own.reduce((a, f) => Math.max(a, f.mtimeMs), 0);
    if (name !== keep && now - newest > 60 * 60 * 1000) {
      try { fs.rmSync(dir, { recursive: true, force: true }); result.removed += own.length; continue; } catch { /* keep counting it */ }
    }
    files.push(...own);
  }

  let total = files.reduce((a, f) => a + f.size, 0);
  if (total > maxBytes) {
    const target = maxBytes * 0.75;
    const oldestFirst = files.filter((f) => !CACHE_OWN_FILES.has(path.basename(f.file))).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of oldestFirst) {
      if (total <= target) break;
      try { fs.unlinkSync(f.file); total -= f.size; result.removed += 1; } catch { /* already gone */ }
    }
  }
  result.after = total;
  return result;
}

let lastSize: { at: number; bytes: number } | null = null;

/** What the admin dashboard shows about the cache. */
export function buildCacheStatus(coreDir: string) {
  const enabled = buildCacheEnabled();
  if (enabled && (!lastSize || Date.now() - lastSize.at > 5 * 60_000)) {
    lastSize = { at: Date.now(), bytes: buildCacheSize(buildCacheRoot(coreDir)) };
  }
  return { enabled, bytes: enabled ? lastSize?.bytes ?? 0 : 0, maxBytes: buildCacheMaxBytes() };
}

/**
 * Trims the cache every 10 minutes, whenever no compile is running or
 * waiting, after setting aside a damaged cache that couldn't be set aside
 * straight away. The trim runs start to finish without yielding, so no
 * compile can start while it is deleting.
 */
export function startBuildCachePruning(coreDir: string, idle: () => boolean): void {
  if (!buildCacheEnabled()) return;
  const trim = () => {
    if (!idle()) return;
    retireDamagedCache(coreDir);
    try {
      const r = pruneBuildCache(buildCacheRoot(coreDir), buildCacheMaxBytes(), toolchainFingerprint(coreDir));
      lastSize = { at: Date.now(), bytes: r.after };
      if (r.removed) console.log(`[Build cache] trimmed ${r.removed} files (${Math.round(r.before / 1048576)} MB -> ${Math.round(r.after / 1048576)} MB)`);
    } catch (err: any) {
      console.error("[Build cache] trim failed:", err?.message || err);
    }
  };
  setTimeout(trim, 60_000).unref();
  setInterval(trim, 10 * 60_000).unref();
}
