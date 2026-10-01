import React, { createContext, useContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  sendEmailVerification,
  signOut as firebaseSignOut,
  updateProfile,
  type User
} from "firebase/auth";
import { auth, googleProvider } from "../lib/firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Sends the "verify your email" link again (email and password accounts). */
  sendVerificationEmail: () => Promise<void>;
  /** Re-reads the account from Firebase: true once its email is verified. */
  refreshVerification: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function friendlyAuthError(code: string): string {
  switch (code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/missing-password": return "Enter your password.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-login-credentials":
    case "auth/invalid-credential": return "Incorrect email or password. If you joined with Google, use Continue with Google.";
    case "auth/email-already-in-use": return "An account already exists for that email. Sign in instead.";
    case "auth/weak-password": return "Password should be at least 6 characters.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return "Sign-in was cancelled.";
    case "auth/popup-blocked": return "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.";
    case "auth/too-many-requests": return "Too many attempts — please wait a moment and try again.";
    case "auth/network-request-failed": return "Couldn't reach the sign-in service. Check your internet connection, then try again.";
    case "auth/timeout": return "Sign-in took too long. Check your internet connection, then try again.";
    case "auth/user-disabled": return "This account has been switched off. Contact us if you think that's a mistake.";
    case "auth/account-exists-with-different-credential": return "This email already has an account that signs in another way. Use your email and password instead.";
    case "auth/web-storage-unsupported": return "Your browser is blocking the storage sign-in needs. Allow cookies for this site, or leave private browsing, then try again.";
    case "auth/unauthorized-domain": return "Sign-in isn't set up for this web address. Open jointagentide.com and try again.";
    case "auth/operation-not-allowed": return "That way of signing in isn't switched on. Try another one.";
    case "auth/internal-error": return "The sign-in service had a problem (auth/internal-error). Please try again in a moment.";
    // The code says what went wrong, for whoever is asked to help.
    default: return `Something went wrong${code ? ` (${code})` : ""}. Please try again.`;
  }
}

// When the sign-in window can't open (blocked by the browser's settings or
// security software, or not possible in this browser), the same Google
// sign-in runs in this tab instead, and comes back here when it's done.
const USE_REDIRECT = new Set(["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"]);

/** The "verify your email" email, with a link back to the site; plainly, if that link isn't allowed. */
async function sendVerification(user: User): Promise<void> {
  try {
    await sendEmailVerification(user, { url: `${window.location.origin}/` });
  } catch (err: any) {
    if (err?.code === "auth/unauthorized-continue-uri" || err?.code === "auth/invalid-continue-uri") {
      await sendEmailVerification(user);
      return;
    }
    throw err;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    // Back from signing in on Google's page (USE_REDIRECT, below): the
    // account arrives through onAuthStateChanged; a failure is shown here.
    getRedirectResult(auth).catch((err: any) => setError(friendlyAuthError(err?.code || "")));
    return unsubscribe;
  }, []);

  const run = async (fn: () => Promise<any>) => {
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(friendlyAuthError(err?.code || ""));
      throw err;
    }
  };

  const value: AuthContextValue = {
    user,
    loading,
    error,
    clearError: () => setError(null),
    signInWithEmail: (email, password) => run(() => signInWithEmailAndPassword(auth, email, password)),
    signUpWithEmail: (name, email, password) => run(async () => {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      // Access you're given is matched on a verified address
      // (server/access.ts), so the link goes out straight away.
      try {
        await sendVerification(cred.user);
      } catch (err) {
        console.warn("[Auth] Could not send the verification email:", (err as any)?.code || err);
      }
    }),
    signInWithGoogle: () => run(async () => {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err: any) {
        if (!USE_REDIRECT.has(err?.code)) throw err;
        await signInWithRedirect(auth, googleProvider);
      }
    }),
    signOut: () => run(() => firebaseSignOut(auth)),
    sendVerificationEmail: () => run(async () => {
      if (auth.currentUser) await sendVerification(auth.currentUser);
    }),
    refreshVerification: async () => {
      const current = auth.currentUser;
      if (!current) return false;
      await current.reload();
      if (!current.emailVerified) return false;
      // A new token carries the verified address to the server.
      await current.getIdToken(true);
      return true;
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
