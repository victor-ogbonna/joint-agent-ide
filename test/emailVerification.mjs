/**
 * Email-and-password accounts are used once their address is verified, with
 * the pre-launch lock on or off (server/quota.ts). Google accounts come
 * verified, and only how this session signed in decides it.
 */
import { identityFromToken, verifiedEmailCheck, EMAIL_NOT_VERIFIED_CODE } from "../server/quota.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const fakeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const token = (provider, verified) => ({ uid: "u1", email: "ada@school.ng", email_verified: verified, firebase: { sign_in_provider: provider } });

console.log("Who has to verify first");
let res = fakeRes();
const unverified = identityFromToken(token("password", false));
check(unverified.unverifiedPassword && !verifiedEmailCheck(unverified, res), "an email-and-password sign-in with the address not verified is held");
check(res.statusCode === 403 && res.body?.code === EMAIL_NOT_VERIFIED_CODE && /Verify your email address first/.test(res.body?.error || ""),
  "with a 403 that says to open the link", JSON.stringify(res.body));

res = fakeRes();
check(verifiedEmailCheck(identityFromToken(token("password", true)), res) && res.statusCode === 200, "once verified, it goes through");
res = fakeRes();
check(verifiedEmailCheck(identityFromToken(token("google.com", true)), res) && res.statusCode === 200, "a Google sign-in goes through");
res = fakeRes();
check(verifiedEmailCheck(identityFromToken(token("google.com", false)), res), "only how this session signed in decides it (not an older password on the account)");
res = fakeRes();
check(verifiedEmailCheck(identityFromToken({ uid: "u2" }), res), "a token with no sign-in method named isn't held");
const missingFlag = identityFromToken({ uid: "u3", email: "x@y.z", firebase: { sign_in_provider: "password" } });
check(missingFlag.unverifiedPassword && !missingFlag.emailVerified, "a password sign-in without the verified flag counts as not verified");

console.log(bad ? `\n${bad} check(s) failed.` : "\nAll email verification checks passed.");
process.exit(bad ? 1 : 0);
