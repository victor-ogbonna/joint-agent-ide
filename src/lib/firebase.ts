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
//
// This only works if afrojoint.xyz is listed under BOTH:
//   Firebase Console -> Authentication -> Settings -> Authorized domains
//   Google Cloud -> Credentials -> Web client -> Authorized JavaScript origins
// Miss either and sign-in breaks outright.
//
// Was left as null until Joint-Agent had a domain: with no custom domain
// the Firebase default is correct everywhere, and pointing this at a domain that
// isn't live yet would break sign-in in production. Set it to the new domain
// once DNS resolves, and add that domain to BOTH Firebase Console ->
// Authentication -> Settings -> Authorized domains AND the Google Cloud OAuth
// client's authorized redirect URIs as https://<domain>/__/auth/handler.
const PROD_AUTH_DOMAIN: string | null = "afrojoint.xyz";

const isLocalhost =
  typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

const firebaseConfig = {
  apiKey: "AIzaSyCjGpSSw4P_oklMJKcmMebfMyE2reZIsxI",
  authDomain: !isLocalhost && PROD_AUTH_DOMAIN ? PROD_AUTH_DOMAIN : "afro-joint-ide.firebaseapp.com",
  projectId: "afro-joint-ide",
  storageBucket: "afro-joint-ide.firebasestorage.app",
  messagingSenderId: "367947451511",
  appId: "1:367947451511:web:7aa1fc85fea7031837ca72"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
