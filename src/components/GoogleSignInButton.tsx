import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

/**
 * Calls `reset` when the browser's Back button brings this page back from
 * Google's sign-in exactly as it was left (the back/forward cache), so a
 * button pressed on the way out doesn't come back stuck on "signing in".
 */
export function useResetOnReturn(reset: () => void) {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
}

/**
 * "Sign in with Google" on the pages that offer only that (/team, /creator).
 * It stays pressed while signing in, so a second press can't cancel the first,
 * and it shows what went wrong, with the in-this-tab way when the Google
 * pop-up closed before it finished.
 */
export default function GoogleSignInButton({ className, style }: { className: string; style?: React.CSSProperties }) {
  const { signInWithGoogle, signInWithGoogleHere, offerSignInHere, error } = useAuth();
  const [busy, setBusy] = useState(false);
  useResetOnReturn(() => setBusy(false));

  const go = async (inThisTab: boolean) => {
    setBusy(true);
    try {
      await (inThisTab ? signInWithGoogleHere() : signInWithGoogle());
    } catch {
      // Shown below, from the sign-in's own error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void go(false)} disabled={busy} className={className} style={style}>
        {busy && <Loader2 size={16} className="animate-spin" />} Sign in with Google
      </button>
      {error && <p role="alert" className="mt-3 text-[13px] text-red-500">{error}</p>}
      {offerSignInHere && !busy && (
        <button
          type="button"
          onClick={() => void go(true)}
          className="mt-2 inline-flex min-h-[40px] items-center rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium text-[var(--accent-secondary)] hover:bg-[var(--bg-hover)]"
        >
          Continue with Google in this tab
        </button>
      )}
    </>
  );
}
