// ---------------------------------------------------------------------------
// Access control: who may use the product, and on what allowance.
//
// Four outcomes, highest first:
//
//   "unmetered"  the owner. Full access, AI usage never counted at all, so
//                demos and testing never eat a real allowance. Hardcoded, so
//                a mistake in the admin page cannot lock the owner out.
//   "pro"        granted Pro without paying — the paid token cap, and access
//                even while the launch lock is on. For VCs and design partners.
//   "early"      normal free allowance, but allowed in while locked. For early
//                users you want testing before launch.
//   "none"       ordinary visitor. Full access when unlocked, refused while
//                the launch lock is on.
//
// Every match is on a VERIFIED email. That is not optional: Firebase lets
// anyone register an arbitrary address through email/password sign-up without
// proving they own it, so matching an unverified address would let a stranger
// claim a granted slot by typing that address into the sign-up form. Google
// sign-in always yields a verified address.
// ---------------------------------------------------------------------------
import { loadAdminConfig } from "./adminConfig";

/** Hardcoded on purpose — the owner must survive any admin-page mistake. */
const OWNER_EMAILS = ["victorogbonna313@gmail.com"];

export type AccessLevel = "unmetered" | "pro" | "early" | "none";

const norm = (email?: string | null) => (email || "").trim().toLowerCase();
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((e) => norm(String(e))).filter(Boolean) : [];

export function accessLevelFor(email: string | null | undefined, emailVerified: boolean): AccessLevel {
  if (!emailVerified) return "none";
  const e = norm(email);
  if (!e) return "none";
  if (OWNER_EMAILS.includes(e)) return "unmetered";

  const cfg = loadAdminConfig();
  if (list(cfg.proAccessEmails).includes(e)) return "pro";
  if (list(cfg.earlyAccessEmails).includes(e)) return "early";
  return "none";
}

/** May use the product even while the launch lock is on. */
export function bypassesLaunchLock(level: AccessLevel): boolean {
  return level !== "none";
}

/** Reads the stored lists back for the admin page. */
export function readAccessLists(): { proAccessEmails: string[]; earlyAccessEmails: string[]; ownerEmails: string[] } {
  const cfg = loadAdminConfig();
  return {
    proAccessEmails: list(cfg.proAccessEmails),
    earlyAccessEmails: list(cfg.earlyAccessEmails),
    ownerEmails: [...OWNER_EMAILS],
  };
}

/**
 * Normalises, de-duplicates and validates a submitted list. Returns null if
 * any entry is not an email, so a typo is rejected outright rather than
 * silently stored as a grant that will never match anything.
 */
export function sanitiseEmailList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const raw of input) {
    const e = norm(String(raw ?? ""));
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    // An owner address in a managed list is redundant and would imply the
    // owner's standing could be edited away. Drop it silently.
    if (OWNER_EMAILS.includes(e)) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export const LAUNCH_LOCKED_CODE = "LAUNCH_LOCKED";
export const LAUNCH_LOCKED_MESSAGE =
  "Joint-Agent IDE hasn't launched yet. Join the waitlist and we'll let you in as soon as a place is free.";
