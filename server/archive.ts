import zlib from "zlib";

/**
 * Just enough zip and tar.gz reading to take in a library: a user's .zip, a
 * GitHub download, or a catalogue package.
 *
 * Written here rather than pulled in because an archive from a stranger is
 * hostile until proven otherwise, and the limits have to hold while it is
 * being unpacked, not after. Nothing is ever written to disk from here:
 * entries come back as buffers with their paths cleaned, and the caller
 * decides what to keep. Directories, links and devices are never returned.
 */

export interface ArchiveEntry {
  /** Forward slashes, relative, no "." or ".." parts. */
  path: string;
  data: Buffer;
}

export interface ArchiveLimits {
  /** How many kept files at most. */
  maxFiles: number;
  /** The largest kept file. */
  maxFileBytes: number;
  /** All kept files together. */
  maxTotalBytes: number;
}

export interface ArchiveContents {
  /** The files the caller asked for, with their contents. */
  entries: ArchiveEntry[];
  /** Every regular file in the archive, kept or not. */
  allPaths: string[];
}

/** A reason to refuse an archive, worded for the person who sent it. */
export class ArchiveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * The path as a safe relative path, or null for one that is not: absolute,
 * a drive letter, or climbing out with "..".
 */
export function cleanArchivePath(raw: string): string | null {
  const unified = String(raw || "").replace(/\\/g, "/");
  if (!unified || unified.startsWith("/") || /^[A-Za-z]:/.test(unified) || unified.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function tooLarge(what: string, limit: number): ArchiveError {
  return new ArchiveError("too_large", `${what} is larger than ${Math.round(limit / (1024 * 1024))} MB.`);
}

class Budget {
  private files = 0;
  private bytes = 0;
  constructor(private limits: ArchiveLimits) {}
  admit(path: string, size: number) {
    if (size > this.limits.maxFileBytes) {
      throw new ArchiveError("file_too_large", `"${path}" is larger than ${Math.round(this.limits.maxFileBytes / (1024 * 1024))} MB.`);
    }
    if (++this.files > this.limits.maxFiles) {
      throw new ArchiveError("too_many_files", `It has more than ${this.limits.maxFiles} code files.`);
    }
    this.bytes += size;
    if (this.bytes > this.limits.maxTotalBytes) throw tooLarge("Unpacked, it", this.limits.maxTotalBytes);
  }
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Read a zip from its central directory, which holds every entry's real
 * sizes (the local headers may not, when the zip was streamed). Each kept
 * entry is inflated with a hard ceiling at its declared size, so a small zip
 * that claims to be small but inflates to gigabytes stops at the ceiling.
 */
export function readZip(buf: Buffer, limits: ArchiveLimits, keep: (path: string, size: number) => boolean): ArchiveContents {
  let eocd = -1;
  // The end record is 22 bytes plus a comment of up to 65,535 (GitHub puts
  // the commit id there).
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError("not_zip", "That file isn't a zip.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw tooLarge("That zip", limits.maxTotalBytes);

  const budget = new Budget(limits);
  const entries: ArchiveEntry[] = [];
  const allPaths: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ArchiveError("corrupt", "That zip is damaged.");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue;
    // Made on Unix: the upper half is the file mode. Only regular files (or
    // no type at all, as some tools write) are files.
    if (madeBy >> 8 === 3) {
      const type = (externalAttr >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000) continue;
    }
    const path = cleanArchivePath(rawName);
    if (!path) continue;
    allPaths.push(path);
    if (!keep(path, size)) continue;

    if (flags & 0x1) throw new ArchiveError("encrypted", "That zip is password-protected.");
    budget.admit(path, size);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) {
      throw new ArchiveError("corrupt", "That zip is damaged.");
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buf.length) throw new ArchiveError("corrupt", "That zip is damaged.");
    const stored = buf.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(stored);
    } else if (method === 8) {
      try {
        data = size === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(stored, { maxOutputLength: size });
      } catch (err: any) {
        if (err?.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
          throw new ArchiveError("corrupt", `"${path}" is bigger than the zip says it is.`);
        }
        throw new ArchiveError("corrupt", "That zip is damaged.");
      }
    } else {
      throw new ArchiveError("unsupported", "That zip uses a compression method that isn't supported. Re-zip it with your computer's built-in zip.");
    }
    if (data.length !== size) throw new ArchiveError("corrupt", "That zip is damaged.");
    entries.push({ path, data });
  }
  return { entries, allPaths };
}

// ---------------------------------------------------------------------------
// tar.gz
// ---------------------------------------------------------------------------

function cString(b: Buffer, start: number, len: number): string {
  const slice = b.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.toString("utf8", 0, end < 0 ? slice.length : end);
}

function octal(b: Buffer, start: number, len: number): number {
  // Base-256 (high bit set) is for files over 8 GB: never a library.
  if (b[start] & 0x80) return Number.MAX_SAFE_INTEGER;
  const text = cString(b, start, len).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  if (!Number.isFinite(n) || n < 0) throw new ArchiveError("corrupt", "That archive is damaged.");
  return n;
}

/** The "path" of a pax extended header, which long names are carried in. */
function paxPath(body: Buffer): string | null {
  let i = 0;
  let found: string | null = null;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space < 0) break;
    const len = parseInt(body.toString("ascii", i, space), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break;
    const record = body.toString("utf8", space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") found = record.slice(eq + 1);
    i += len;
  }
  return found;
}

export function readTarGz(buf: Buffer, limits: ArchiveLimits, keep: (path: string, size: number) => boolean, maxUnpackedBytes = 64 * 1024 * 1024): ArchiveContents {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(buf, { maxOutputLength: maxUnpackedBytes });
  } catch (err: any) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw tooLarge("Unpacked, it", maxUnpackedBytes);
    throw new ArchiveError("not_targz", "That package couldn't be unpacked.");
  }

  const budget = new Budget(limits);
  const entries: ArchiveEntry[] = [];
  const allPaths: string[] = [];
  let off = 0;
  let longName: string | null = null;
  let pax: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    const bodyStart = off + 512;
    if (size > tar.length - bodyStart) throw new ArchiveError("corrupt", "That archive is damaged.");
    const body = tar.subarray(bodyStart, bodyStart + size);
    off = bodyStart + Math.ceil(size / 512) * 512;

    if (type === "L") { longName = cString(body, 0, body.length); continue; }
    if (type === "x") { pax = paxPath(body); continue; }
    if (type === "g") continue;

    const ustar = header.toString("ascii", 257, 262) === "ustar";
    const prefix = ustar ? cString(header, 345, 155) : "";
    const name = cString(header, 0, 100);
    const rawPath = pax ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    pax = null;
    longName = null;

    // Regular files only ("0", or NUL in old archives; "7" is contiguous).
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const path = cleanArchivePath(rawPath);
    if (!path) continue;
    allPaths.push(path);
    if (!keep(path, size)) continue;
    budget.admit(path, size);
    entries.push({ path, data: Buffer.from(body) });
  }
  return { entries, allPaths };
}
