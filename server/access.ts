// ---------------------------------------------------------------------------
// Pre-launch access control.
//
// Two independent ideas live here:
//
//   1. The launch lock. While it is on, only allowlisted accounts may use the
//      product at all — everyone else is refused at the middleware and signed
//      out by the client. It is the switch to flip before the product is
//      officially launched.
//
//   2. The metering exemption. The owner's own account does not burn tokens,
//      so demos and testing never eat a real allowance.
//
// Both match on EMAIL, and both require a *verified* email. That check is not
// optional: Firebase lets anyone register an arbitrary address through
// email/password sign-up without proving they own it, so matching on an
// unverified address would let a stranger claim the owner's allowlist slot by
// typing their address into the sign-up form. Google sign-in always yields a
// verified address.
// ---------------------------------------------------------------------------

/** Full access, and AI usage is never counted against a token cap. */
const UNMETERED_EMAILS = ["victorogbonna313@gmail.com"];

/** Full access while the launch lock is on, but metered like any other user. */
const EARLY_ACCESS_EMAILS = ["chineduogbonna313@gmail.com"];

const norm = (email?: string | null) => (email || "").trim().toLowerCase();

export function isUnmetered(email: string | null | undefined, emailVerified: boolean): boolean {
  return emailVerified && UNMETERED_EMAILS.includes(norm(email));
}

/** May use the product even while the launch lock is on. */
export function isAllowlisted(email: string | null | undefined, emailVerified: boolean): boolean {
  if (!emailVerified) return false;
  const e = norm(email);
  return UNMETERED_EMAILS.includes(e) || EARLY_ACCESS_EMAILS.includes(e);
}

export const LAUNCH_LOCKED_CODE = "LAUNCH_LOCKED";
export const LAUNCH_LOCKED_MESSAGE =
  "Joint-Agent IDE hasn't launched yet. Join the waitlist and we'll let you in as soon as a place is free.";
