import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import { readZip, readTarGz, ArchiveError, type ArchiveLimits } from "./archive";
import {
  LibraryError, findLibraryRoot, isKeptImportPath, sanitizeLibrary, auditPackage, describeLibrary,
  includedHeaderKeys, parseGithubUrl, compareVersions, satisfies, isSafeFilePath, isSkippedDir,
  HEADER_FILE, type SanitizedLibrary, type DependencySpec,
} from "./libraryManifest";
import { isBuiltinHeader, knownLibraryHeader } from "./libraryDeps";

/**
 * Libraries a user adds themselves, on top of the ones found automatically
 * from their #includes.
 *
 * Two kinds, both kept per account and usable in any project, both used by a
 * build only when its code includes one of their headers:
 *   - from the catalogue: a pinned version, checked before it is allowed (see
 *     auditPackage), then fetched by the build as usual;
 *   - imported (a .zip, or a GitHub link): unpacked here, cut down to its
 *     code and headers (see sanitizeLibrary), stored on disk, and copied into
 *     the build's own lib folder.
 * Nothing the user sees names the build system: it is "the catalogue".
 */

const MB = 1024 * 1024;
export const MAX_LIBRARIES = 20;
export const MAX_IMPORTED_BYTES = 50 * MB;
export const MAX_ZIP_BYTES = 10 * MB;
const IMPORT_LIMITS: ArchiveLimits = { maxFiles: 3000, maxFileBytes: 2 * MB, maxTotalBytes: 20 * MB };
/** A catalogue package is only read for its manifests and headers. */
const PACKAGE_LIMITS: ArchiveLimits = { maxFiles: 6000, maxFileBytes: 2 * MB, maxTotalBytes: 48 * MB };
const PACKAGE_DOWNLOAD_BYTES = 30 * MB;
/** A library and the ones it depends on, checked together. */
const MAX_CHECKED_PACKAGES = 10;

const REGISTRY = "https://api.registry.platformio.org";
const USER_AGENT = "JointAgent/1.0";

const OWNER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.+\-]{0,99}$/;
const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+\-]{0,39}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A reason that holds only for now (network, rate limit); never remembered. */
export class TemporaryLibraryError extends LibraryError {}

const unreachable = () => new TemporaryLibraryError("The library catalogue can't be reached right now. Try again in a minute.");

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface LibraryBase {
  id: string;
  name: string;
  version: string;
  headers: string[];
  headerFiles: string[];
  summary: string;
  addedAt: number;
}

export interface CatalogueLibrary extends LibraryBase {
  kind: "catalogue";
  owner: string;
  /** "owner/name@version", exactly as the build is given it. */
  spec: string;
}

export interface ImportedLibrary extends LibraryBase {
  kind: "zip" | "github";
  /** Its folder in the build's lib folder. */
  folder: string;
  /** Headers it includes from elsewhere. */
  includes: string[];
  bytes: number;
  files: number;
  origin?: string;
  notes: string[];
}

export type UserLibrary = CatalogueLibrary | ImportedLibrary;

/** What the app is shown about a library. */
export function libraryView(lib: UserLibrary) {
  return {
    id: lib.id,
    kind: lib.kind,
    name: lib.name,
    version: lib.version,
    owner: lib.kind === "catalogue" ? lib.owner : undefined,
    origin: lib.kind === "github" ? lib.origin : undefined,
    headerFiles: lib.headerFiles,
    bytes: lib.kind === "catalogue" ? undefined : lib.bytes,
    notes: lib.kind === "catalogue" ? [] : lib.notes,
  };
}

// ---------------------------------------------------------------------------
// Storage: <ADMIN_CONFIG_DIR>/libraries (./data/libraries in development)
// ---------------------------------------------------------------------------

let rootOverride: string | null = null;
/** For tests. */
export function setLibrariesRoot(dir: string | null) {
  rootOverride = dir;
  checks = null;
}
function librariesRoot(): string {
  return rootOverride || process.env.LIBRARIES_DIR || path.join(process.env.ADMIN_CONFIG_DIR || path.join(process.cwd(), "data"), "libraries");
}

function userDir(uid: string): string {
  if (!USER_ID.test(uid)) throw new LibraryError("Unknown account.");
  return path.join(librariesRoot(), "users", uid);
}
const filesDir = (uid: string, id: string) => path.join(userDir(uid), "files", id);

function writeJsonAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function isRecord(x: any): x is UserLibrary {
  return x && typeof x.id === "string" && /^[a-f0-9]{12}$/.test(x.id) && typeof x.name === "string" &&
    Array.isArray(x.headers) && (x.kind === "catalogue"
      ? typeof x.spec === "string" && typeof x.owner === "string"
      : (x.kind === "zip" || x.kind === "github") && typeof x.folder === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(x.folder) && Array.isArray(x.includes));
}

export function listLibraries(uid: string): UserLibrary[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(userDir(uid), "index.json"), "utf8"));
    return Array.isArray(data?.libraries) ? data.libraries.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeLibraries(uid: string, libraries: UserLibrary[]) {
  writeJsonAtomic(path.join(userDir(uid), "index.json"), { libraries });
}

const locks = new Map<string, Promise<void>>();
/** One change to an account's libraries at a time. */
function withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

export function importedBytes(libs: UserLibrary[]): number {
  return libs.reduce((n, l) => n + (l.kind === "catalogue" ? 0 : l.bytes), 0);
}

const newId = () => crypto.randomBytes(6).toString("hex");

/** Store an imported library, replacing one of the same name. */
export function saveImported(uid: string, lib: SanitizedLibrary, kind: "zip" | "github", origin?: string): Promise<ImportedLibrary> {
  return withLock(uid, () => {
    const libs = listLibraries(uid);
    const same = libs.find((l) => l.kind !== "catalogue" && l.name.toLowerCase() === lib.name.toLowerCase()) as ImportedLibrary | undefined;
    const others = libs.filter((l) => l !== same);
    if (others.length >= MAX_LIBRARIES) {
      throw new LibraryError(`You have ${MAX_LIBRARIES} libraries, the most there's room for. Remove one you no longer use first.`);
    }
    if (importedBytes(others) + lib.bytes > MAX_IMPORTED_BYTES) {
      throw new LibraryError(`That would take your imported libraries past ${MAX_IMPORTED_BYTES / MB} MB. Remove one you no longer use first.`);
    }
    // Two libraries never share a folder in the build.
    const taken = new Set(others.filter((l) => l.kind !== "catalogue").map((l) => (l as ImportedLibrary).folder.toLowerCase()));
    let folder = lib.folder;
    for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${lib.folder.slice(0, 56)}_${n}`;

    const id = newId();
    const dir = filesDir(uid, id);
    try {
      for (const f of lib.files) {
        if (!isSafeFilePath(f.path)) continue;
        const target = path.resolve(dir, f.path);
        if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.data);
      }
      const record: ImportedLibrary = {
        id, kind, name: lib.name, version: lib.version, folder,
        headers: lib.headers, headerFiles: lib.headerFiles, includes: lib.includes, summary: lib.summary,
        bytes: lib.bytes, files: lib.files.length, origin, notes: lib.notes, addedAt: Date.now(),
      };
      writeLibraries(uid, [...others, record]);
      if (same) fs.rmSync(filesDir(uid, same.id), { recursive: true, force: true });
      return record;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });
}

export function removeLibrary(uid: string, id: string): Promise<boolean> {
  return withLock(uid, () => {
    const libs = listLibraries(uid);
    const lib = libs.find((l) => l.id === id);
    if (!lib) return false;
    writeLibraries(uid, libs.filter((l) => l !== lib));
    if (lib.kind !== "catalogue") fs.rmSync(filesDir(uid, lib.id), { recursive: true, force: true });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Unpacking an import
// ---------------------------------------------------------------------------

/** A zip as a library, ready to store; `subpath` picks one folder of it. */
export function unpackZipLibrary(buf: Buffer, subpath: string | null, fallbackName: string): SanitizedLibrary {
  try {
    const listing = readZip(buf, IMPORT_LIMITS, () => false);
    const root = findLibraryRoot(listing.allPaths, subpath);
    const contents = readZip(buf, IMPORT_LIMITS, (p) => isKeptImportPath(p, root));
    return sanitizeLibrary(contents.entries, root, fallbackName);
  } catch (err) {
    if (err instanceof ArchiveError) throw new LibraryError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

class HttpStatusError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "user-agent": USER_AGENT, ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/** A download, stopped the moment it passes `maxBytes`. */
async function download(url: string, maxBytes: number, tooLargeMessage: string): Promise<Buffer> {
  if (!/^https:\/\//i.test(url)) throw new LibraryError("That download link isn't allowed.");
  const res = await fetchWithTimeout(url, { redirect: "follow" }, 90000);
  if (!res.ok) throw new HttpStatusError(res.status);
  if (Number(res.headers.get("content-length") || 0) > maxBytes) throw new LibraryError(tooLargeMessage);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new LibraryError(tooLargeMessage);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: any }>();
const CACHE_MS = 10 * 60 * 1000;
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function registryJson(pathAndQuery: string): Promise<any | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(REGISTRY + pathAndQuery, { headers: { accept: "application/json" } });
  } catch {
    throw unreachable();
  }
  if (res.status === 404) return null;
  if (!res.ok) throw unreachable();
  try { return await res.json(); } catch { throw unreachable(); }
}

export interface CatalogueItem {
  owner: string;
  name: string;
  version: string;
  description: string;
  updated: string | null;
}

export async function searchCatalogue(query: string, page = 1): Promise<{ items: CatalogueItem[]; total: number; page: number; perPage: number }> {
  const q = String(query || "").replace(/[\x00-\x1f]/g, " ").trim().slice(0, 100);
  const p = Math.max(1, Math.min(50, Math.floor(Number(page) || 1)));
  if (!q) return { items: [], total: 0, page: 1, perPage: 0 };
  return cached(`search|${q.toLowerCase()}|${p}`, async () => {
    const params = new URLSearchParams({ query: `type:"library" ${q}`, page: String(p) });
    const data = await registryJson(`/v3/search?${params}`);
    const items: CatalogueItem[] = (Array.isArray(data?.items) ? data.items : [])
      .filter((it: any) => it && (it.type === undefined || it.type === "library"))
      .map((it: any) => ({
        owner: String(it.owner?.username ?? ""),
        name: String(it.name ?? ""),
        version: String(it.version?.name ?? ""),
        description: String(it.description ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
        updated: typeof it.version?.released_at === "string" ? it.version.released_at : null,
      }))
      .filter((it: CatalogueItem) => OWNER_NAME.test(it.owner) && PACKAGE_NAME.test(it.name));
    return { items, total: Number(data?.total) || items.length, page: p, perPage: Number(data?.limit) || items.length };
  });
}

function fetchPackage(owner: string, name: string): Promise<any | null> {
  const key = `${owner}/${name}`.toLowerCase();
  return cached(`package|${key}`, () =>
    registryJson(`/v3/packages/${encodeURIComponent(owner.toLowerCase())}/library/${encodeURIComponent(name.toLowerCase())}`));
}

const versionsOf = (pkg: any): any[] => (Array.isArray(pkg?.versions) ? pkg.versions : []).filter((v: any) => v && typeof v.name === "string");

/** The newest of a package's versions meeting a requirement (all of them when it isn't understood). */
function pickVersionObject(pkg: any, requirement?: string): any | null {
  const sorted = versionsOf(pkg).sort((a, b) => compareVersions(b.name, a.name));
  for (const v of sorted) {
    const s = satisfies(v.name, requirement);
    if (s === null) return sorted[0] ?? null;
    if (s) return v;
  }
  return null;
}

export async function catalogueVersions(owner: string, name: string): Promise<{ version: string; released: string | null }[]> {
  if (!OWNER_NAME.test(owner) || !PACKAGE_NAME.test(name)) throw new LibraryError("That library isn't in the catalogue.");
  const pkg = await fetchPackage(owner, name);
  if (!pkg) throw new LibraryError("That library isn't in the catalogue.");
  return versionsOf(pkg)
    .filter((v) => VERSION_NAME.test(v.name))
    .sort((a, b) => compareVersions(b.name, a.name))
    .slice(0, 60)
    .map((v) => ({ version: v.name, released: typeof v.released_at === "string" ? v.released_at : null }));
}

/** Download a package version and read what the build would read from it. */
async function inspectPackage(pkg: any, version: any, describe: boolean) {
  const files: any[] = Array.isArray(version?.files) ? version.files : [];
  const file = files.find((f) => !f?.system || f.system === "*" || (Array.isArray(f.system) && f.system.includes("*"))) ?? files[0];
  if (!file?.download_url) throw new LibraryError(`“${pkg.name}” ${version?.name ?? ""} has nothing to download.`);
  let buf: Buffer;
  try {
    buf = await download(String(file.download_url), PACKAGE_DOWNLOAD_BYTES, `“${pkg.name}” is too large to add.`);
  } catch (err) {
    if (err instanceof LibraryError) throw err;
    throw unreachable();
  }
  const sha = file.checksum?.sha256;
  if (typeof sha === "string" && sha && crypto.createHash("sha256").update(buf).digest("hex") !== sha.toLowerCase()) {
    throw new TemporaryLibraryError(`“${pkg.name}” didn't download correctly. Try again.`);
  }
  let contents;
  try {
    contents = readTarGz(buf, PACKAGE_LIMITS, (p, size) => {
      const base = p.slice(p.lastIndexOf("/") + 1);
      if (base === "library.json" || base === "library.properties") return p.split("/").length <= 3;
      return describe && HEADER_FILE.test(p) && size <= 512 * 1024 && !p.split("/").slice(0, -1).some(isSkippedDir);
    });
  } catch (err) {
    if (err instanceof ArchiveError) throw new LibraryError(`“${pkg.name}” can't be unpacked: ${err.message}`);
    throw err;
  }
  let root: string;
  try {
    root = findLibraryRoot(contents.allPaths);
  } catch {
    return { refusals: ["isn't laid out as a library"], dependencies: [] as DependencySpec[], info: null };
  }
  const at = (name: string) => contents.entries.find((e) => e.path === (root ? `${root}/${name}` : name))?.data.toString("utf8") ?? null;
  const json = at("library.json");
  const audit = auditPackage(contents.allPaths, { json, properties: at("library.properties") }, root);
  let info = null;
  if (describe) {
    const prefix = root ? `${root}/` : "";
    let publicDirs: string[] = [];
    try {
      const build = json ? JSON.parse(json.replace(/^﻿/, ""))?.build : null;
      publicDirs = [build?.includeDir, build?.srcDir].filter((d) => typeof d === "string");
    } catch { /* audited above */ }
    const headers = contents.entries
      .filter((e) => e.path.startsWith(prefix) && HEADER_FILE.test(e.path))
      .map((e) => ({ path: e.path.slice(prefix.length), data: e.data }));
    info = describeLibrary(headers, String(pkg.name), publicDirs);
  }
  return { ...audit, info };
}

/** A dependency as the build would find it: by owner and name, or failing an owner, by name alone. */
async function resolveDependency(dep: DependencySpec): Promise<{ pkg: any; version: any } | null> {
  if (dep.owner) {
    const pkg = await fetchPackage(dep.owner, dep.name);
    const version = pkg && pickVersionObject(pkg, dep.requirement);
    return version ? { pkg, version } : null;
  }
  const params = new URLSearchParams({ query: `type:"library" name:"${dep.name.toLowerCase().replace(/"/g, "")}"` });
  const found = await cached(`byname|${dep.name.toLowerCase()}`, () => registryJson(`/v3/search?${params}`));
  for (const item of (Array.isArray(found?.items) ? found.items : []).slice(0, 3)) {
    const owner = item?.owner?.username;
    if (typeof owner !== "string" || typeof item.name !== "string") continue;
    const pkg = await fetchPackage(owner, item.name);
    const version = pkg && pickVersionObject(pkg, dep.requirement);
    if (version) return { pkg, version };
  }
  return null;
}

export interface CheckResult {
  ok: boolean;
  spec: string;
  error?: string;
  owner?: string;
  name?: string;
  version?: string;
  headers?: string[];
  headerFiles?: string[];
  summary?: string;
}

// Versions in the catalogue never change once published, so a verdict on
// one holds for everyone, for good.
let checks: Map<string, CheckResult> | null = null;
const checksFile = () => path.join(librariesRoot(), "catalogue-checks.json");
function loadChecks(): Map<string, CheckResult> {
  if (checks) return checks;
  checks = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(checksFile(), "utf8"));
    for (const [k, v] of Object.entries(data || {})) if (v && typeof (v as any).ok === "boolean") checks.set(k, v as CheckResult);
  } catch { /* first run */ }
  return checks;
}
function rememberCheck(result: CheckResult) {
  const all = loadChecks();
  all.set(result.spec.toLowerCase(), result);
  while (all.size > 3000) all.delete(all.keys().next().value as string);
  try { writeJsonAtomic(checksFile(), Object.fromEntries(all)); } catch (err: any) {
    console.error("[Libraries] could not save a check:", err?.message || err);
  }
}

/**
 * Whether a catalogue library, at a version (the newest when none is given),
 * may go into builds: it and every library it depends on are downloaded and
 * read, and refused if anything in them would run during a build.
 */
export async function checkCatalogueLibrary(owner: string, name: string, version?: string): Promise<CheckResult> {
  if (!OWNER_NAME.test(owner) || !PACKAGE_NAME.test(name)) throw new LibraryError("That library isn't in the catalogue.");
  const pkg = await fetchPackage(owner, name);
  if (!pkg) throw new LibraryError("That library isn't in the catalogue.");
  const chosen = version ? versionsOf(pkg).find((v) => v.name === version) : pickVersionObject(pkg);
  if (!chosen) throw new LibraryError("That version isn't available.");
  const realOwner = String(pkg.owner?.username ?? owner);
  const realName = String(pkg.name ?? name);
  if (!OWNER_NAME.test(realOwner) || !PACKAGE_NAME.test(realName) || !VERSION_NAME.test(chosen.name)) {
    throw new LibraryError("That library can't be added.");
  }
  const spec = `${realOwner}/${realName}@${chosen.name}`;
  const known = loadChecks().get(spec.toLowerCase());
  if (known) return known;

  const first = await inspectPackage(pkg, chosen, true);
  let error: string | undefined = first.refusals.length ? `“${realName}” can't be added: it ${first.refusals[0]}.` : undefined;
  const seen = new Set([`${realOwner}/${realName}`.toLowerCase()]);
  const queue = [...first.dependencies];
  let count = 1;
  while (!error && queue.length) {
    const dep = queue.shift()!;
    // Framework libraries (Wire, SPI, WiFi…) come with the board.
    if (!dep.owner && isBuiltinHeader(dep.name)) continue;
    const found = await resolveDependency(dep);
    // Not in the catalogue: the build can't fetch it either.
    if (!found) continue;
    const key = `${found.pkg.owner?.username}/${found.pkg.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (++count > MAX_CHECKED_PACKAGES) {
      error = `“${realName}” can't be added: it depends on more libraries than can be checked.`;
      break;
    }
    const r = await inspectPackage(found.pkg, found.version, false);
    if (r.refusals.length) error = `“${realName}” can't be added: it needs “${found.pkg.name}”, which ${r.refusals[0]}.`;
    queue.push(...r.dependencies);
  }

  const result: CheckResult = error
    ? { ok: false, spec, error }
    : {
        ok: true, spec, owner: realOwner, name: realName, version: chosen.name,
        headers: first.info?.headers ?? [], headerFiles: first.info?.headerFiles ?? [], summary: first.info?.summary ?? "",
      };
  if (result.ok && !result.headers!.length) {
    result.ok = false;
    result.error = `“${realName}” has no header files to include.`;
  }
  rememberCheck(result);
  return result;
}

/** Add a catalogue library to the account, or change the version of one already there. */
export async function addCatalogueLibrary(uid: string, owner: string, name: string, version?: string): Promise<CatalogueLibrary> {
  const check = await checkCatalogueLibrary(owner, name, version);
  if (!check.ok) throw new LibraryError(check.error || "That library can't be added.");
  return withLock(uid, () => {
    const libs = listLibraries(uid);
    const same = libs.find((l) => l.kind === "catalogue" && `${l.owner}/${l.name}`.toLowerCase() === `${check.owner}/${check.name}`.toLowerCase());
    const others = libs.filter((l) => l !== same);
    if (others.length >= MAX_LIBRARIES) {
      throw new LibraryError(`You have ${MAX_LIBRARIES} libraries, the most there's room for. Remove one you no longer use first.`);
    }
    const record: CatalogueLibrary = {
      id: same?.id ?? newId(), kind: "catalogue", owner: check.owner!, name: check.name!, version: check.version!,
      spec: check.spec, headers: check.headers!, headerFiles: check.headerFiles!, summary: check.summary!,
      addedAt: same?.addedAt ?? Date.now(),
    };
    writeLibraries(uid, same ? libs.map((l) => (l === same ? record : l)) : [...libs, record]);
    return record;
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export async function importFromGithub(uid: string, link: string): Promise<ImportedLibrary> {
  const source = parseGithubUrl(link);
  if (!source) throw new LibraryError("That isn't a GitHub repository link. It should look like https://github.com/owner/repository.");
  const tooLarge = `That repository is larger than ${MAX_ZIP_BYTES / MB} MB, too large to add. If the library has a release .zip, download it and use Import .zip.`;
  for (const candidate of source.candidates) {
    const ref = (candidate.ref ?? "HEAD").split("/").map(encodeURIComponent).join("/");
    let buf: Buffer;
    try {
      buf = await download(`https://codeload.github.com/${source.owner}/${source.repo}/zip/${ref}`, MAX_ZIP_BYTES, tooLarge);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) continue;
      if (err instanceof LibraryError) throw err;
      throw new TemporaryLibraryError("GitHub can't be reached right now. Try again in a minute.");
    }
    const lib = unpackZipLibrary(buf, candidate.subpath, candidate.subpath?.split("/").pop() || source.repo);
    const where = candidate.ref ? `/tree/${candidate.ref}${candidate.subpath ? `/${candidate.subpath}` : ""}` : "";
    return saveImported(uid, lib, "github", `https://github.com/${source.owner}/${source.repo}${where}`);
  }
  throw new LibraryError(source.candidates[0].ref
    ? "That branch or folder wasn't found in the repository."
    : "That repository wasn't found. Only public repositories can be added.");
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export interface LibraryPlan {
  /** Imported libraries to copy into the build. */
  imported: ImportedLibrary[];
  /** Catalogue libraries, pinned, for the build to fetch. */
  libDeps: string[];
  /** Headers these libraries provide: automatic detection leaves them alone. */
  skipHeaders: Set<string>;
  /** #include lines for known libraries the imported ones need, for automatic detection only. */
  extraIncludes: string;
  used: string[];
}

/**
 * Which of an account's libraries a build uses: the ones whose headers the
 * code includes, then any those include in turn. An imported library wins
 * over a catalogue one providing the same header, since it was added on
 * purpose, and headers the framework itself provides never pull one in.
 */
export function planLibraries(libs: UserLibrary[], codeKeys: string[]): LibraryPlan {
  const wanted = new Set(codeKeys.filter((k) => !isBuiltinHeader(k)));
  const imported = libs.filter((l): l is ImportedLibrary => l.kind !== "catalogue");
  const catalogue = libs.filter((l): l is CatalogueLibrary => l.kind === "catalogue");
  const used: ImportedLibrary[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const lib of imported) {
      if (used.includes(lib) || !lib.headers.some((h) => wanted.has(h))) continue;
      used.push(lib);
      for (const k of lib.includes) if (!isBuiltinHeader(k)) wanted.add(k);
      grew = true;
    }
  }
  const fromImported = new Set(used.flatMap((l) => l.headers));
  const fromCatalogue = catalogue.filter((l) => l.headers.some((h) => wanted.has(h) && !fromImported.has(h)));
  const skipHeaders = new Set([...fromImported, ...fromCatalogue.flatMap((l) => l.headers)]);
  const extra = [...wanted].filter((k) => !codeKeys.includes(k) && !skipHeaders.has(k) && knownLibraryHeader(k));
  return {
    imported: used,
    libDeps: fromCatalogue.map((l) => l.spec),
    skipHeaders,
    extraIncludes: extra.map((k) => `\n#include <${k}.h>`).join(""),
    used: [...used, ...fromCatalogue].map((l) => l.name),
  };
}

/** Pinned catalogue libraries first; automatic ones only where they aren't the same library. */
export function mergeLibDeps(pinned: string[], detected: string[]): string[] {
  if (!pinned.length) return detected;
  const full = new Set(pinned.map((s) => s.split("@")[0].toLowerCase()));
  const bare = new Set([...full].map((s) => s.split("/").pop()!));
  return [...pinned, ...detected.filter((d) => {
    const n = d.split("@")[0].toLowerCase();
    return !full.has(n) && !bare.has(n.split("/").pop()!);
  })];
}

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export interface BuildLibraries {
  libDeps: string[];
  skipHeaders: Set<string>;
  extraIncludes: string;
  used: string[];
}

export const NO_LIBRARIES: BuildLibraries = Object.freeze({ libDeps: [], skipHeaders: new Set<string>(), extraIncludes: "", used: [] }) as BuildLibraries;

/** Put the account's libraries this code uses into a build folder. */
export function prepareLibraries(uid: string | undefined, code: string, buildDir: string): BuildLibraries {
  if (!uid || !USER_ID.test(uid)) return NO_LIBRARIES;
  const libs = listLibraries(uid);
  if (!libs.length) return NO_LIBRARIES;
  const plan = planLibraries(libs, includedHeaderKeys(code));
  for (const lib of plan.imported) {
    const from = filesDir(uid, lib.id);
    if (fs.existsSync(from)) copyDir(from, path.join(buildDir, "lib", lib.folder));
  }
  return { libDeps: plan.libDeps, skipHeaders: plan.skipHeaders, extraIncludes: plan.extraIncludes, used: plan.used };
}

/** A line for the user when a build failed for want of a library. */
export function missingLibraryHint(output: string): string | null {
  const header = /fatal error:\s*([^\s:]+\.(?:h|hh|hpp|hxx))\s*:\s*No such file or directory/i.exec(output || "");
  if (header) {
    const file = header[1].split("/").pop();
    return `“${file}” wasn't found. If it comes from a library, add the library under Libraries: search the catalogue, or import it as a .zip or from a GitHub link.`;
  }
  const pkg = /Could not find the package with '([^']+)' requirements/i.exec(output || "");
  if (pkg) {
    const name = pkg[1].split("@")[0].split("/").pop();
    return `No library called “${name}” was found in the catalogue. If it's from a maker's website or GitHub, add it under Libraries → Import.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

const NOTE_BUDGET = 3000;

/** What the agent is told about libraries: always the rule, and the account's own list when there is one. */
export function libraryNoteFor(uid: string | undefined): string {
  const libs = uid && USER_ID.test(uid) ? listLibraries(uid) : [];
  const lines = [
    "LIBRARIES: Well-known Arduino libraries are fetched automatically when the code #includes them.",
    "If the project needs a library that isn't well known (one from a maker's website or GitHub), use it anyway and tell the user " +
      "to add it under Libraries (the Libraries button above main.cpp), where they can search the catalogue or import a .zip or a GitHub link. " +
      "Never rewrite a project to avoid a library the user asked for, and never tell them to install anything on their computer.",
  ];
  if (libs.length) {
    lines.push("The user has added these libraries to their account; any project can #include them, and should rather than reimplement them:");
    let used = lines.join("\n").length;
    for (const lib of libs) {
      const head = `- ${lib.name}${lib.version ? ` ${lib.version}` : ""} (${lib.kind === "catalogue" ? "from the catalogue" : "imported"})` +
        (lib.headerFiles.length ? `: #include <${lib.headerFiles.slice(0, 4).join(">, <")}>` : "");
      const api = lib.summary ? `\n  ${lib.summary.split("\n").join("\n  ")}` : "";
      const entry = used + head.length + api.length < NOTE_BUDGET ? head + api : head;
      if (used + entry.length > NOTE_BUDGET) break;
      lines.push(entry);
      used += entry.length + 1;
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const buckets = new Map<string, number[]>();
/** A simple per-account rate limit; true when allowed. */
function allow(uid: string, bucket: string, max: number, windowMs = 60 * 60 * 1000): boolean {
  const key = `${bucket}|${uid}`;
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) buckets.delete(buckets.keys().next().value as string);
  return true;
}

function sendError(res: express.Response, err: unknown) {
  if (err instanceof TemporaryLibraryError) return res.status(503).json({ error: err.message });
  if (err instanceof LibraryError) return res.status(400).json({ error: err.message });
  console.error("[Libraries]", (err as any)?.message || err);
  res.status(500).json({ error: "Something went wrong with that library. Try again." });
}

function listing(uid: string) {
  const libs = listLibraries(uid);
  return {
    libraries: libs.map(libraryView),
    usedBytes: importedBytes(libs),
    maxBytes: MAX_IMPORTED_BYTES,
    maxLibraries: MAX_LIBRARIES,
  };
}

export function registerLibraryRoutes(app: express.Express, requireAuth: express.RequestHandler) {
  app.get("/api/libraries", requireAuth, (req: any, res) => {
    res.json(listing(req.uid));
  });

  app.get("/api/libraries/search", requireAuth, async (req: any, res) => {
    if (!allow(req.uid, "search", 300)) return res.status(429).json({ error: "That's a lot of searches. Wait a few minutes." });
    try {
      res.json(await searchCatalogue(String(req.query.q || ""), Number(req.query.page) || 1));
    } catch (err) { sendError(res, err); }
  });

  app.get("/api/libraries/versions", requireAuth, async (req: any, res) => {
    try {
      res.json({ versions: await catalogueVersions(String(req.query.owner || ""), String(req.query.name || "")) });
    } catch (err) { sendError(res, err); }
  });

  app.post("/api/libraries/catalogue", requireAuth, async (req: any, res) => {
    const { owner, name, version } = req.body || {};
    if (typeof owner !== "string" || typeof name !== "string" || (version !== undefined && typeof version !== "string")) {
      return res.status(400).json({ error: "Pick a library first." });
    }
    if (!allow(req.uid, "add", 40)) return res.status(429).json({ error: "That's a lot of libraries at once. Wait a few minutes." });
    try {
      const library = await addCatalogueLibrary(req.uid, owner, name, version || undefined);
      res.json({ library: libraryView(library), ...listing(req.uid) });
    } catch (err) { sendError(res, err); }
  });

  const rawZip = express.raw({ type: () => true, limit: MAX_ZIP_BYTES });
  app.post("/api/libraries/import", requireAuth, (req, res, next) => {
    rawZip(req, res, (err?: any) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: `That zip is larger than ${MAX_ZIP_BYTES / MB} MB.` });
      next();
    });
  }, async (req: any, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Choose a .zip file first." });
    if (!allow(req.uid, "import", 30)) return res.status(429).json({ error: "That's a lot of imports at once. Wait a few minutes." });
    const fileName = String(req.get("x-file-name") || "").replace(/[^\w .+\-()]/g, "").replace(/\.zip$/i, "").slice(0, 80);
    try {
      const lib = unpackZipLibrary(req.body, null, fileName);
      const library = await saveImported(req.uid, lib, "zip");
      res.json({ library: libraryView(library), ...listing(req.uid) });
    } catch (err) { sendError(res, err); }
  });

  app.post("/api/libraries/github", requireAuth, async (req: any, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    if (!url.trim()) return res.status(400).json({ error: "Paste a GitHub link first." });
    if (!allow(req.uid, "import", 30)) return res.status(429).json({ error: "That's a lot of imports at once. Wait a few minutes." });
    try {
      const library = await importFromGithub(req.uid, url);
      res.json({ library: libraryView(library), ...listing(req.uid) });
    } catch (err) { sendError(res, err); }
  });

  app.delete("/api/libraries/:id", requireAuth, async (req: any, res) => {
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "Unknown library." });
    try {
      await removeLibrary(req.uid, id);
      res.json(listing(req.uid));
    } catch (err) { sendError(res, err); }
  });
}
