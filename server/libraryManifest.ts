import { cleanArchivePath, type ArchiveEntry } from "./archive";

/**
 * What a library may bring into a build, decided without touching the
 * network or the disk (server/libraries.ts does both), so every rule here is
 * testable on its own.
 *
 * The compiler's build tool is a program in its own right: a library's
 * manifest can name a script for it to run, hand it a flag that begins with
 * "!" (which it runs as a shell command), or use "${...}" (which it evaluates
 * as code), and every file it compiles is named on a command line run by a
 * shell. So, for anything a library brings:
 *   - scripts never come in: dropped from an import, refused from the catalogue;
 *   - build settings are allowed only in forms that cannot run anything;
 *   - a file that reaches the compiler must have a plain name.
 */

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

/** Code and headers: all an import keeps, besides the manifests and a readme. */
export const CODE_FILE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|ipp|tpp|inl|inc|s|sx)$/i;
export const HEADER_FILE = /\.(h|hh|hpp|hxx|h\+\+)$/i;
/** Files the build names on a command line. */
const COMPILED_FILE = /\.(c|cc|cpp|cxx|c\+\+|s|sx|spp|ino|pde)$/i;
const MANIFESTS = new Set(["library.json", "library.properties"]);
const ROOT_TEXT_FILE = /^(keywords\.txt|readme(\.(md|txt|adoc|rst))?|licen[cs]e(\.(md|txt))?|copying(\.(md|txt))?)$/i;
/** Folders a build never compiles; left out of an import altogether. */
const SKIPPED_DIRS = new Set(["examples", "example", "extras", "test", "tests", "docs", "doc", "documentation"]);
/** A file or folder name that is safe on a shell command line (spaces are quoted by the build). */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_+\-. ]*$/;

export const isSkippedDir = (segment: string) => segment.startsWith(".") || SKIPPED_DIRS.has(segment.toLowerCase());
export const isSafeFilePath = (path: string) => path.split("/").every((s) => SAFE_SEGMENT.test(s));

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);

/** The key the build uses to recognise a header: what follows the last "/", minus a ".h". */
export function headerKey(includePath: string): string {
  return includePath.replace(/\.h$/, "").split("/").pop() || "";
}

/** The headers a piece of code includes, as header keys. */
export function includedHeaderKeys(code: string): string[] {
  const keys = new Set<string>();
  for (const m of code.matchAll(/#\s*include\s*[<"]([^>"\n]+)[>"]/g)) {
    const key = headerKey(m[1].trim());
    if (key) keys.add(key);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Where the library is inside an archive
// ---------------------------------------------------------------------------

function singleTopFolder(paths: string[]): string | null {
  const tops = new Set(paths.map((p) => (p.includes("/") ? p.split("/")[0] : "")));
  return tops.size === 1 && !tops.has("") ? [...tops][0] : null;
}

/**
 * The folder that is the library: the shallowest one holding a manifest, or
 * failing that, the first folder with more than a single folder in it, as
 * long as it has headers. `subpath` narrows it to one folder of a repository
 * (from a GitHub link to a folder), with or without the download's own top
 * folder in front.
 */
export function findLibraryRoot(paths: string[], subpath?: string | null): string {
  let base = "";
  if (subpath) {
    const clean = cleanArchivePath(subpath);
    if (!clean) throw new LibraryError("That folder path isn't valid.");
    const top = singleTopFolder(paths);
    base = top && clean !== top && !clean.startsWith(`${top}/`) ? `${top}/${clean}` : clean;
    if (!paths.some((p) => p.startsWith(`${base}/`))) throw new LibraryError(`There's no folder "${subpath}" in it.`);
  }
  const under = base ? paths.filter((p) => p.startsWith(`${base}/`)).map((p) => p.slice(base.length + 1)) : paths;

  const manifestDirs = [...new Set(
    under
      .filter((p) => MANIFESTS.has(basename(p)) && !dirname(p).split("/").filter(Boolean).some(isSkippedDir))
      .map(dirname),
  )];
  if (manifestDirs.length) {
    const depth = (d: string) => (d ? d.split("/").length : 0);
    const min = Math.min(...manifestDirs.map(depth));
    const shallowest = manifestDirs.filter((d) => depth(d) === min);
    if (shallowest.length > 1) {
      const names = shallowest.slice(0, 4).map((d) => basename(d) || d).join(", ");
      throw new LibraryError(`It holds ${shallowest.length} libraries (${names}${shallowest.length > 4 ? ", …" : ""}). Add them one at a time, using a link to each one's folder.`);
    }
    return join(base, shallowest[0]);
  }

  // No manifest: step down through folders that only hold one folder.
  let dir = "";
  for (;;) {
    const inside = under.filter((p) => !dir || p.startsWith(`${dir}/`)).map((p) => (dir ? p.slice(dir.length + 1) : p));
    const subdirs = new Set(inside.filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
    if (inside.some((p) => !p.includes("/")) || subdirs.size !== 1) break;
    dir = join(dir, [...subdirs][0]);
  }
  const hasHeader = under.some((p) => {
    if (dir && !p.startsWith(`${dir}/`)) return false;
    const rel = dir ? p.slice(dir.length + 1) : p;
    return HEADER_FILE.test(p) && !dirname(rel).split("/").filter(Boolean).some(isSkippedDir);
  });
  if (!hasHeader) throw new LibraryError("There's no library in it: no header (.h) files were found.");
  return join(base, dir);
}

/** A folder name for the library on disk: letters, digits, "_", "-" and "." only. */
export function folderNameFor(name: string): string {
  const slug = String(name || "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 60);
  return slug || "library";
}

/** A readable name from a download's folder: "DHT-sensor-library-HEAD" -> "DHT-sensor-library". */
export function nameFromFolder(folder: string): string {
  return String(folder || "")
    .replace(/-(master|main|head|develop|dev|release)$/i, "")
    .replace(/-v?\d+(\.\d+){0,3}$/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Build settings
// ---------------------------------------------------------------------------

/**
 * A "$" is only ever a plain variable ("$PROJECT_DIR"). "${...}", "$(...)",
 * "$x.y" and "$$" are all evaluated by the build tool, so none are allowed.
 */
export function isSubstSafe(s: string): boolean {
  return !/\$(?![A-Za-z_]\w*(?![\w.[{(]))/.test(s);
}

const SAFE_PATH = /^[A-Za-z0-9_.\/+\- $]+$/;
function isSafeRelPath(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim()) return false;
  const s = v.trim();
  return SAFE_PATH.test(s) && isSubstSafe(s) && !s.startsWith("/") && !s.split("/").includes("..");
}

const FLAG_RULES: RegExp[] = [
  /^-D[A-Za-z_]\w*(=[\w.,:+\-\/"%@=]*)?$/,
  /^-U[A-Za-z_]\w*$/,
  /^-(I|L)(?!\/)[\w.\/+\-$]+$/,
  /^-std=[\w+]+$/,
  /^-O[0-3sgz]?$/,
  /^-g[0-3]?$/,
  /^-W(?![lap],)[\w=+\-]+$/,
  /^-f(?!plugin|use-ld|profile|auto-profile|debug-prefix|file-prefix|macro-prefix)[a-z0-9+_-]+(=[\w.+\-]+)?$/,
  /^-m[a-z0-9+_-]+(=[\w.+\-]+)?$/,
  /^-l[\w.+\-]+$/,
];

/** One compiler flag, allowed only in a form that can do nothing but set up the compiler. */
export function isSafeFlag(flag: string): boolean {
  if (!flag || !isSubstSafe(flag) || flag.includes("..")) return false;
  return FLAG_RULES.some((rule) => rule.test(flag));
}

/** Flags as the manifest gives them (a string, or a list of strings), split into single flags; null when neither. */
function splitFlags(v: unknown): string[] | null {
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.flatMap((x) => x.split(/\s+/)).filter(Boolean);
  return null;
}

export function areSafeFlags(v: unknown): boolean {
  const flags = splitFlags(v);
  return flags !== null && flags.every(isSafeFlag);
}

function isSafeSrcFilter(v: unknown): boolean {
  const items = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
  return !!items && items.every((x) => typeof x === "string" && /^[\w.\/+\-<>*? \[\]$]*$/.test(x) && isSubstSafe(x) && !x.includes(".."));
}

const LDF_MODES = ["off", "chain", "deep", "chain+", "deep+"];
const COMPAT_MODES = ["off", "soft", "strict"];
const isMode = (v: unknown, modes: string[]) =>
  (typeof v === "string" && modes.includes(v.trim().toLowerCase())) || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < modes.length);

const PLAIN = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max && !/[\x00-\x1f$`]/.test(v);
const LIST_OF = (v: unknown, item: RegExp) =>
  (typeof v === "string" && v.split(",").every((x) => item.test(x.trim()))) ||
  (Array.isArray(v) && v.every((x) => typeof x === "string" && item.test(x.trim())));

// ---------------------------------------------------------------------------
// Dependencies (catalogue packages)
// ---------------------------------------------------------------------------

export interface DependencySpec {
  owner?: string;
  name: string;
  requirement?: string;
}

/** A requirement that is a place to download from, rather than a version. */
const isExternalSpec = (s: string) => /:\/\/|^git[@+]|^file:|^symlink:|\.git$|\.(zip|tar\.gz|tgz)$/i.test(s.trim());

/** The dependencies a library.json declares, in every shape its format allows. */
function jsonDependencies(raw: unknown, refuse: (why: string) => void): DependencySpec[] {
  const out: DependencySpec[] = [];
  const add = (fullName: unknown, version: unknown, owner?: unknown) => {
    if (typeof fullName !== "string" || !fullName.trim()) { refuse("declares a dependency it doesn't name"); return; }
    let name = fullName.trim();
    let o = typeof owner === "string" ? owner.trim() : undefined;
    if (!o && name.includes("/") && !isExternalSpec(name)) [o, name] = name.split("/", 2) as [string, string];
    const requirement = typeof version === "string" ? version.trim() : undefined;
    if (isExternalSpec(name) || (requirement && isExternalSpec(requirement))) {
      refuse(`downloads "${name}" from outside the catalogue`);
      return;
    }
    out.push({ owner: o || undefined, name, requirement: requirement || undefined });
  };
  if (!raw) return out;
  if (typeof raw === "object" && !Array.isArray(raw) && "name" in (raw as any)) raw = [raw];
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (typeof d === "string") add(d, undefined);
      else if (d && typeof d === "object") add((d as any).name, (d as any).version, (d as any).owner);
      else refuse("declares a dependency in a form that isn't understood");
    }
  } else if (typeof raw === "object") {
    for (const [name, version] of Object.entries(raw as Record<string, unknown>)) add(name, version);
  } else {
    refuse("declares its dependencies in a form that isn't understood");
  }
  return out;
}

/** library.properties' "depends=A, B (>=1.2)". */
function propertiesDependencies(depends: string): DependencySpec[] {
  return depends.split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
    const m = /^(.*?)\s*\(([^)]*)\)$/.exec(item);
    return m ? { name: m[1].trim(), requirement: m[2].trim() || undefined } : { name: item };
  });
}

function parseProperties(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) props.set(m[1].trim(), m[2].trim());
  }
  return props;
}

function hasScriptKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => /script/i.test(k) || hasScriptKey(v, depth + 1));
}

// ---------------------------------------------------------------------------
// Catalogue: accept or refuse a package exactly as the build would get it
// ---------------------------------------------------------------------------

export interface PackageAudit {
  /** Why it can't be used; empty when it can. */
  refusals: string[];
  dependencies: DependencySpec[];
}

/**
 * A catalogue package goes to the build untouched, so it is used only if
 * nothing in it would run: no scripts, only safe build settings, only plain
 * file names, and no dependency fetched from outside the catalogue.
 */
export function auditPackage(allPaths: string[], manifests: { json?: string | null; properties?: string | null }, root: string): PackageAudit {
  const refusals: string[] = [];
  const refuse = (why: string) => { if (!refusals.includes(why)) refusals.push(why); };
  let dependencies: DependencySpec[] = [];

  const prefix = root ? `${root}/` : "";
  if (allPaths.some((p) => p.startsWith(prefix) && COMPILED_FILE.test(p) && !isSafeFilePath(p.slice(prefix.length)))) {
    refuse("has code files with names that aren't allowed");
  }

  if (manifests.json != null) {
    let data: any;
    try { data = JSON.parse(manifests.json.replace(/^﻿/, "")); } catch { refuse("has a library.json that can't be read"); }
    if (data && typeof data === "object") {
      if (hasScriptKey(data)) refuse("runs a build script of its own");
      const build = data.build && typeof data.build === "object" ? data.build : {};
      if (build.builder !== undefined && !["PlatformIOLibBuilder", "ArduinoLibBuilder"].includes(build.builder)) refuse("uses a custom builder");
      if (build.flags !== undefined && !areSafeFlags(build.flags)) refuse("uses build settings that aren't allowed");
      if (build.unflags !== undefined && !areSafeFlags(build.unflags)) refuse("uses build settings that aren't allowed");
      for (const key of ["includeDir", "srcDir"]) {
        if (build[key] !== undefined && !isSafeRelPath(build[key])) refuse("uses build settings that aren't allowed");
      }
      if (build.srcFilter !== undefined && !isSafeSrcFilter(build.srcFilter)) refuse("uses build settings that aren't allowed");
      if (data.name !== undefined && !PLAIN(data.name)) refuse("has a name that isn't allowed");
      dependencies = jsonDependencies(data.dependencies, refuse);
    }
  }

  if (manifests.properties != null) {
    const props = parseProperties(manifests.properties);
    const ldflags = props.get("ldflags");
    if (ldflags && !ldflags.split(/\s+/).filter(Boolean).every((f) => /^-l[\w.+\-]+$/.test(f))) refuse("uses link settings that aren't allowed");
    // library.json wins when both are present; the build reads that one.
    if (manifests.json == null && props.get("depends")) dependencies = propertiesDependencies(props.get("depends")!);
  }

  for (const d of dependencies) {
    if (!PLAIN(d.name, 100) || (d.owner && !/^[A-Za-z0-9_.\-]{1,64}$/.test(d.owner))) refuse("depends on a library with a name that isn't allowed");
  }
  return { refusals, dependencies };
}

// ---------------------------------------------------------------------------
// Imports: keep the code, rewrite the manifests
// ---------------------------------------------------------------------------

const USES_OTHERS = "It uses other libraries. Well-known ones are added automatically; if a build says one is missing, add it under Libraries too.";

/** library.json, reduced to what describes the library and safe build settings. */
export function sanitizeLibraryJson(text: string): { json: string | null; name?: string; version?: string; includeDir?: string; srcDir?: string; notes: string[] } {
  const notes: string[] = [];
  let data: any;
  try { data = JSON.parse(text.replace(/^﻿/, "")); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { json: null, notes: ["Its library.json couldn't be read, so it was left out."] };
  }
  const out: Record<string, unknown> = {};
  if (PLAIN(data.name, 100)) out.name = data.name;
  if (PLAIN(data.version, 40)) out.version = data.version;
  if (PLAIN(data.description, 1000)) out.description = data.description;
  if (PLAIN(data.license, 100)) out.license = data.license;
  if (LIST_OF(data.keywords, /^[\w .+\-]{0,60}$/)) out.keywords = data.keywords;
  if (LIST_OF(data.frameworks, /^[\w*\-]{1,40}$/)) out.frameworks = data.frameworks;
  if (LIST_OF(data.platforms, /^[\w*\-]{1,40}$/)) out.platforms = data.platforms;
  if (LIST_OF(data.headers, /^[\w.\/+\-]{1,100}$/)) out.headers = data.headers;

  const build = data.build && typeof data.build === "object" ? data.build : null;
  if (build) {
    const safe: Record<string, unknown> = {};
    let dropped = false;
    for (const key of ["flags", "unflags"]) {
      if (build[key] === undefined) continue;
      if (areSafeFlags(build[key])) safe[key] = build[key]; else dropped = true;
    }
    for (const key of ["includeDir", "srcDir"]) {
      if (build[key] === undefined) continue;
      if (isSafeRelPath(build[key])) safe[key] = build[key].trim(); else dropped = true;
    }
    if (build.srcFilter !== undefined) {
      if (isSafeSrcFilter(build.srcFilter)) safe.srcFilter = build.srcFilter; else dropped = true;
    }
    if (typeof build.libArchive === "boolean") safe.libArchive = build.libArchive;
    if (build.libLDFMode !== undefined && isMode(build.libLDFMode, LDF_MODES)) safe.libLDFMode = build.libLDFMode;
    if (build.libCompatMode !== undefined && isMode(build.libCompatMode, COMPAT_MODES)) safe.libCompatMode = build.libCompatMode;
    if (hasScriptKey(build)) notes.push("Its build script was left out: scripts never run here.");
    else if (dropped) notes.push("Some of its build settings were left out.");
    if (Object.keys(safe).length) out.build = safe;
  }
  if (data.dependencies) notes.push(USES_OTHERS);
  return {
    json: JSON.stringify(out, null, 2),
    name: out.name as string | undefined,
    version: out.version as string | undefined,
    includeDir: (out.build as any)?.includeDir,
    srcDir: (out.build as any)?.srcDir,
    notes,
  };
}

const KEPT_PROPERTIES = ["name", "version", "author", "maintainer", "sentence", "paragraph", "category", "url", "architectures", "includes", "dot_a_linkage"];

/** library.properties without the entries that link files or fetch other libraries. */
export function sanitizeLibraryProperties(text: string): { text: string; name?: string; version?: string; notes: string[] } {
  const props = parseProperties(text);
  const notes: string[] = [];
  const lines: string[] = [];
  for (const key of KEPT_PROPERTIES) {
    const value = props.get(key);
    if (value === undefined) continue;
    lines.push(`${key}=${value.replace(/[\x00-\x1f$`]/g, "")}`);
  }
  if (props.has("ldflags") || props.get("precompiled") === "true" || props.get("precompiled") === "full") {
    notes.push("Its precompiled parts were left out; only its source code is used.");
  }
  if (props.get("depends")) notes.push(USES_OTHERS);
  return { text: lines.join("\n") + "\n", name: props.get("name") || undefined, version: props.get("version") || undefined, notes };
}

export interface LibraryInfo {
  /** Header keys (see headerKey) of every header in the library. */
  headers: string[];
  /** The headers meant to be included, e.g. "DHT.h", for the agent. */
  headerFiles: string[];
  /** Header keys the library includes from elsewhere. */
  includes: string[];
  /** Classes and their public functions, briefly, for the agent. */
  summary: string;
}

/** Headers, what the library itself includes, and a short outline of its API. */
export function describeLibrary(files: { path: string; data: Buffer }[], name: string, extraPublicDirs: string[] = []): LibraryInfo {
  const headerEntries = files.filter((f) => HEADER_FILE.test(f.path));
  const headers = [...new Set(headerEntries.map((f) => headerKey(basename(f.path))))];
  const own = new Set(headers);

  const includes = new Set<string>();
  for (const f of files) {
    if (!CODE_FILE.test(f.path) || f.data.length > 512 * 1024) continue;
    for (const key of includedHeaderKeys(f.data.toString("utf8"))) if (!own.has(key)) includes.add(key);
  }

  const publicDirs = new Set(["", "src", "include", "Src", "Include", ...extraPublicDirs.map((d) => d.replace(/^\.\/?/, "").replace(/\/+$/, ""))]);
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const publicHeaders = headerEntries
    .filter((f) => publicDirs.has(dirname(f.path)))
    .sort((a, b) => {
      const score = (f: { path: string }) => (basename(f.path).toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/g, "") === wanted ? 0 : 1);
      return score(a) - score(b) || basename(a.path).length - basename(b.path).length || a.path.localeCompare(b.path);
    });
  const headerFiles = [...new Set(publicHeaders.map((f) => basename(f.path)))].slice(0, 12);
  let summary = "";
  try {
    summary = apiSummary(publicHeaders.slice(0, 3).map((f) => f.data.toString("utf8")));
  } catch {
    summary = "";
  }
  return { headers, headerFiles, includes: [...includes].slice(0, 60), summary };
}

export interface SanitizedLibrary extends LibraryInfo {
  name: string;
  version: string;
  folder: string;
  files: { path: string; data: Buffer }[];
  bytes: number;
  /** Files left out because of their names. */
  skipped: number;
  notes: string[];
}

/** Whether a path inside an archive is one an import keeps, given the library's root. */
export function isKeptImportPath(path: string, root: string): boolean {
  const prefix = root ? `${root}/` : "";
  if (prefix && !path.startsWith(prefix)) return false;
  const rel = path.slice(prefix.length);
  const parts = rel.split("/");
  if (parts.slice(0, -1).some(isSkippedDir)) return false;
  const file = parts[parts.length - 1];
  if (parts.length === 1 && (MANIFESTS.has(file) || ROOT_TEXT_FILE.test(file))) return true;
  return CODE_FILE.test(file);
}

/**
 * An imported library as it will be stored: its code and headers under plain
 * names, its manifests rewritten, and nothing else.
 */
export function sanitizeLibrary(entries: ArchiveEntry[], root: string, fallbackName: string): SanitizedLibrary {
  const prefix = root ? `${root}/` : "";
  const files: { path: string; data: Buffer }[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let jsonText: string | null = null;
  let propsText: string | null = null;

  for (const e of entries) {
    if (!isKeptImportPath(e.path, root)) continue;
    const rel = e.path.slice(prefix.length);
    if (rel === "library.json") { jsonText = e.data.toString("utf8"); continue; }
    if (rel === "library.properties") { propsText = e.data.toString("utf8"); continue; }
    if (!isSafeFilePath(rel)) { skipped++; continue; }
    files.push({ path: rel, data: e.data });
  }
  if (!files.some((f) => HEADER_FILE.test(f.path))) {
    throw new LibraryError("There's no library in it: no header (.h) files were found.");
  }

  let name = "";
  let version = "";
  const publicDirs: string[] = [];
  if (propsText !== null) {
    const p = sanitizeLibraryProperties(propsText);
    files.push({ path: "library.properties", data: Buffer.from(p.text) });
    notes.push(...p.notes);
    name = p.name || name;
    version = p.version || version;
  }
  if (jsonText !== null) {
    const j = sanitizeLibraryJson(jsonText);
    if (j.json) files.push({ path: "library.json", data: Buffer.from(j.json) });
    for (const n of j.notes) if (!notes.includes(n)) notes.push(n);
    name = name || j.name || "";
    version = version || j.version || "";
    if (j.includeDir) publicDirs.push(j.includeDir);
    if (j.srcDir) publicDirs.push(j.srcDir);
  }
  name = (PLAIN(name, 100) && name.trim()) || nameFromFolder(basename(root)) || fallbackName || "Library";
  if (!PLAIN(version, 40)) version = "";
  if (propsText === null && jsonText === null) {
    // No manifest at all: give it the plainest one, so the build treats it as
    // an ordinary library rather than guessing.
    files.push({ path: "library.json", data: Buffer.from(JSON.stringify({ name: name.replace(/[^\w .+\-]/g, ""), version: "0.0.0" }, null, 2)) });
  }
  if (skipped) notes.push(`${skipped} file${skipped === 1 ? " was" : "s were"} left out because of unusual characters in ${skipped === 1 ? "its name" : "their names"}.`);

  const info = describeLibrary(files, name, publicDirs);
  return {
    name,
    version,
    folder: folderNameFor(name),
    files,
    bytes: files.reduce((n, f) => n + f.data.length, 0),
    skipped,
    notes,
    ...info,
  };
}

// ---------------------------------------------------------------------------
// A short outline of a header's API, for the agent
// ---------------------------------------------------------------------------

function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/^[ \t]*#(?:[^\n]*\\\n)*[^\n]*/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function signatureOf(statement: string): string | null {
  let s = statement.replace(/\s+/g, " ").trim();
  if (!s.includes("(") || /^(typedef|using|friend|enum|template|static_assert|~)/.test(s)) return null;
  // Attribute macros such as IRAM_ATTR go; a type such as T or BOOL stays.
  s = s.replace(/\b(virtual|inline|explicit|constexpr)\s+/g, "").replace(/^([A-Z][A-Z0-9]*_[A-Z0-9_]*\s+)+/, "");
  const open = s.indexOf("(");
  let depth = 0;
  let close = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const tail = /^\s*const\b/.test(s.slice(close + 1)) ? " const" : "";
  const sig = (s.slice(0, close + 1) + tail).trim();
  return sig.length > 100 ? `${sig.slice(0, 99)}…` : sig;
}

/** Each class and struct in the headers, with its public functions. */
export function apiSummary(headerTexts: string[], maxChars = 700): string {
  const parts: string[] = [];
  for (const text of headerTexts) {
    const src = stripNoise(text);
    const re = /(?<!\benum\s+)\b(class|struct)\s+(?:[A-Z_][A-Z0-9_]*\s+)*([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^{;]*)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const [, kind, name] = m;
      const start = re.lastIndex;
      let depth = 1;
      let i = start;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      const body = src.slice(start, i - 1);
      re.lastIndex = i;
      let access = kind === "struct" ? "public" : "private";
      const members: string[] = [];
      let stmt = "";
      let d = 0;
      const flush = () => {
        if (access === "public") {
          const sig = signatureOf(stmt);
          if (sig && !members.includes(sig)) members.push(sig);
        }
        stmt = "";
      };
      for (let j = 0; j < body.length; j++) {
        const c = body[j];
        if (c === "{") { if (d === 0) flush(); d++; continue; }
        if (c === "}") { d--; continue; }
        if (d > 0) continue;
        if (c === ";") { flush(); continue; }
        if (c === ":" && body[j + 1] !== ":" && body[j - 1] !== ":") {
          const spec = /\b(public|private|protected)\s*$/.exec(stmt);
          if (spec) { access = spec[1]; stmt = ""; continue; }
        }
        stmt += c;
      }
      if (members.length || kind === "class") parts.push(`${kind} ${name}${members.length ? ` { ${members.slice(0, 14).join("; ")}; }` : ""}`);
    }
  }
  const out = parts.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

type Ver = [number, number, number];

export function parseVersion(v: string): Ver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) || [0, 0, 0];
  const y = parseVersion(b) || [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const cmp = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a version meets a requirement ("^1.2.3", "~1.2", ">=1.0,<2",
 * "1.2.3", "1.x", "*"). Null when the requirement isn't understood.
 */
export function satisfies(version: string, requirement?: string): boolean | null {
  const req = String(requirement ?? "").trim();
  if (!req || req === "*" || /^latest$/i.test(req)) return true;
  const v = parseVersion(version);
  if (!v) return null;
  const tokens = req.replace(/([<>=!~^]+)\s+/g, "$1").split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    const t = /^(\^|~=|~|>=|<=|>|<|==|=|!=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.\-]+)?$/.exec(token);
    if (!t) return null;
    const op = t[1] || "";
    const raw = [t[2], t[3], t[4]];
    let given = raw.findIndex((p) => p === undefined || /[xX*]/.test(p));
    if (given < 0) given = 3;
    const base: Ver = [0, 1, 2].map((i) => (i < given ? Number(raw[i]) : 0)) as Ver;
    const bump = (i: number): Ver => (i === 0 ? [base[0] + 1, 0, 0] : i === 1 ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1]);
    let ok: boolean;
    switch (op) {
      case "^": {
        const upper = base[0] > 0 || given === 1 ? bump(0) : base[1] > 0 || given === 2 ? bump(1) : bump(2);
        ok = cmp(v, base) >= 0 && cmp(v, upper) < 0;
        break;
      }
      case "~": ok = cmp(v, base) >= 0 && cmp(v, given >= 2 ? bump(1) : bump(0)) < 0; break;
      case "~=": ok = cmp(v, base) >= 0 && cmp(v, given >= 3 ? bump(1) : bump(0)) < 0; break;
      case ">=": ok = cmp(v, base) >= 0; break;
      case "<=": ok = cmp(v, base) <= 0; break;
      case ">": ok = cmp(v, base) > 0; break;
      case "<": ok = cmp(v, base) < 0; break;
      case "!=": ok = cmp(v, base) !== 0; break;
      default:
        // "1.2.3" or "==1.2.3" is exactly that version; "1.2" or "1.x" any 1.2.* / 1.*.
        ok = given === 3 ? cmp(v, base) === 0 : given === 0 ? true : [0, 1].slice(0, given).every((i) => v[i] === base[i]);
    }
    if (!ok) return false;
  }
  return true;
}

/** The newest version meeting the requirement; the newest of all when the requirement isn't understood. */
export function pickVersion(versions: string[], requirement?: string): string | null {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));
  for (const v of sorted) {
    const s = satisfies(v, requirement);
    if (s === null) return sorted[0] ?? null;
    if (s) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub links
// ---------------------------------------------------------------------------

export interface GithubSource {
  owner: string;
  repo: string;
  /** Branch, tag or commit, each paired with the folder after it; tried in order (a branch name may hold "/"). */
  candidates: { ref: string | null; subpath: string | null }[];
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._\-\/]{1,200}$/;

/**
 * A GitHub link as people paste them: the repository, a folder or file in
 * it (/tree/, /blob/), a release, a commit, a download link, "git@" or bare
 * "github.com/owner/repo".
 */
export function parseGithubUrl(input: string): GithubSource | null {
  const text = String(input || "").trim();
  if (!text || text.length > 500) return null;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text);
  let owner: string;
  let repo: string;
  let rest: string[] = [];
  if (ssh) {
    [, owner, repo] = ssh;
  } else {
    let url: URL;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
    let parts: string[];
    try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return null; }
    if (parts.length < 2) return null;
    [owner, repo] = parts;
    repo = repo.replace(/\.git$/i, "");
    rest = parts.slice(2);
  }
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;

  let candidates: { ref: string | null; subpath: string | null }[] = [{ ref: null, subpath: null }];
  if ((rest[0] === "tree" || rest[0] === "blob") && rest[1]) {
    const after = rest.slice(1);
    // A file link means the folder it is in.
    if (rest[0] === "blob") after.pop();
    candidates = [];
    for (let i = 1; i <= Math.min(after.length, 4); i++) {
      const sub = after.slice(i).join("/");
      candidates.push({ ref: after.slice(0, i).join("/"), subpath: sub || null });
    }
    if (!candidates.length) candidates = [{ ref: rest[1], subpath: null }];
  } else if (rest[0] === "archive" && rest.length > 1) {
    const ref = rest.slice(1).join("/").replace(/\.(zip|tar\.gz)$/i, "").replace(/^refs\/(heads|tags)\//, "");
    candidates = [{ ref: ref || null, subpath: null }];
  } else if (rest[0] === "releases" && rest[1] === "tag" && rest[2]) {
    candidates = [{ ref: rest.slice(2).join("/"), subpath: null }];
  } else if (rest[0] === "commit" && rest[1]) {
    candidates = [{ ref: rest[1], subpath: null }];
  }
  for (const c of candidates) {
    if (c.ref !== null && (!REF.test(c.ref) || c.ref.split("/").includes(".."))) return null;
    if (c.subpath !== null && !cleanArchivePath(c.subpath)) return null;
  }
  return { owner, repo, candidates };
}
