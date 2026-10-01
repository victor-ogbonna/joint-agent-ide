import React, { useState } from "react";
import { Mail, Loader2, LogOut, RefreshCw } from "lucide-react";
import { friendlyAuthError } from "../contexts/AuthContext";

/**
 * Shown while the pre-launch lock is on to someone who signed in with an
 * email and password they haven't verified yet. Access is granted to a
 * verified address (server/access.ts), so until then the server can't tell
 * that this account is the one on the list. It used to sign them straight
 * out with "That account doesn't have early access yet", which read as
 * being refused.
 */
export default function VerifyEmailScreen({ email, onResend, onCheck, onSignOut }: {
  email: string | null;
  onResend: () => Promise<void>;
  /** Re-reads the account: true once its email is verified (the page then carries on by itself). */
  onCheck: () => Promise<boolean>;
  onSignOut: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"check" | "resend" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy("check");
    setNote(null);
    setError(null);
    try {
      const verified = await onCheck();
      if (!verified) setError("It isn't verified yet. Open the link in the email we sent, then press Continue again.");
    } catch (err: any) {
      setError(friendlyAuthError(err?.code || ""));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy("resend");
    setNote(null);
    setError(null);
    try {
      await onResend();
      setNote(`Sent. Check your inbox${email ? ` at ${email}` : ""}, and the spam folder too.`);
    } catch (err: any) {
      setError(friendlyAuthError(err?.code || ""));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-primary-soft)]">
          <Mail size={22} className="text-[var(--accent-primary)]" aria-hidden="true" />
        </div>
        <h1 className="font-display text-xl font-bold">Verify your email address</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">
          We sent a link to <strong className="text-[var(--text-main)]">{email || "your email address"}</strong>.
          Open it to confirm the address is yours, then come back here and press Continue.
        </p>
        <button
          type="button"
          onClick={check}
          disabled={busy !== null}
          className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full px-5 text-[14px] font-bold text-white shadow-md disabled:opacity-60"
          style={{ background: "var(--gradient-hero)" }}
        >
          {busy === "check" ? <Loader2 size={16} className="animate-spin" /> : null} I've verified it: Continue
        </button>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={resend}
            disabled={busy !== null}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {busy === "resend" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Send the link again
          </button>
          <button
            type="button"
            onClick={() => void onSignOut()}
            disabled={busy !== null}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            <LogOut size={14} /> Use another account
          </button>
        </div>
        {note && <p role="status" className="mt-3 text-[13px] text-green-500">{note}</p>}
        {error && <p role="alert" className="mt-3 text-[13px] text-red-500">{error}</p>}
      </div>
    </div>
  );
}
