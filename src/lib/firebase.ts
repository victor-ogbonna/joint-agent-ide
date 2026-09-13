import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// ---------------------------------------------------------------------------
// NOTE ON THE REBRAND: the identifiers below still name the original Firebase
// project. They are infrastructure, not branding — the project ID is baked into
// the auth tenant, the Firestore database and every existing user record, so
// renaming these strings would not rename the project, it would just point at
// a project that does not exist and break sign-in outright.
//
// Two options when you are ready to fully separate Joint-Agent:
//   1. Keep this project. Nothing to do — existing accounts and data carry over.
//   2. Create a new Firebase project. Replace the whole config block below with
//      the new one from Firebase Console -> Project Settings, and issue a new
//      service account for the server's FIREBASE_* env vars. Existing users and
//      their saved projects do NOT carry across.
// ---------------------------------------------------------------------------

// Google's consent screen names whichever domain hosts the sign-in handler, so
// serving it from our own domain is what makes it read as our brand rather than
// "<project>.firebaseapp.com". The server proxies /__/auth/* through to Firebase
// (see server/firebaseAuthProxy.ts) so that works without Firebase Hosting.
//
// Set to afrojoint.xyz on 11 Sep 2026. Requests to /__/auth/* are proxied to
// the Firebase backend by server/firebaseAuthProxy.ts, so Google's consent
// screen shows the real domain instead of afro-joint-ide.firebaseapp.com.
// Google's consent screen shows whatever authDomain is set to, so it must be
// the domain the visitor is actually on — otherwise someone signing in at
// jointagentide.com is asked to "continue to afrojoint.xyz", which looks like a
// phishing attempt.
//
// Derived from the current hostname rather than hardcoded, deliberately. A
// single constant is all-or-nothing: point it at a domain that is not yet
// registered with Google and sign-in breaks on EVERY domain at once. This way
// each domain stands alone, so the known-good one keeps working while a new one
// is being registered.
//
// A domain only works here once it is listed in BOTH:
//   Firebase Console -> Authentication -> Settings -> Authorized domains
//   Google Cloud -> Credentials -> Web client -> Authorized JavaScript origins
// Miss either and sign-in fails on that domain alone.
//
// www is folded onto the apex so only the apex needs registering.
const AUTH_DOMAINS = ["jointagentide.com", "afrojoint.xyz"];

const hostname = typeof window !== "undefined" ? window.location.hostname : "";
const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
const apex = hostname.replace(/^www\./, "");

// Falls back to the Firebase-hosted domain, which is always authorised — the
// consent screen reads worse, but sign-in keeps working.
const resolvedAuthDomain =
  !isLocalhost && AUTH_DOMAINS.includes(apex) ? apex : "afro-joint-ide.firebaseapp.com";

const firebaseConfig = {
  apiKey: "AIzaSyCjGpSSw4P_oklMJKcmMebfMyE2reZIsxI",
  authDomain: resolvedAuthDomain,
  projectId: "afro-joint-ide",
  storageBucket: "afro-joint-ide.firebasestorage.app",
  messagingSenderId: "367947451511",
  appId: "1:367947451511:web:7aa1fc85fea7031837ca72"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
