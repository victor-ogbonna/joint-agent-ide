import React, { createContext, useContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

function friendlyAuthError(code: string): string {
  switch (code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/email-already-in-use": return "An account already exists for that email.";
    case "auth/weak-password": return "Password should be at least 6 characters.";
    case "auth/popup-closed-by-user": return "Sign-in was cancelled.";
    case "auth/too-many-requests": return "Too many attempts — please wait a moment and try again.";
    default: return "Something went wrong. Please try again.";
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
    }),
    signInWithGoogle: () => run(() => signInWithPopup(auth, googleProvider)),
    signOut: () => run(() => firebaseSignOut(auth)),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
