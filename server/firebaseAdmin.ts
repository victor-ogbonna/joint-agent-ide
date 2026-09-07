import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

// ----------------------------------------------------
// Firebase Admin SDK — verifies end-user ID tokens and reads/writes
// per-user Firestore state (token usage, subscription status) from the
// server. No gcloud CLI / Application Default Credentials are available in
// this environment, so credentials come from explicit service-account
// fields (download once from Firebase Console -> Project Settings ->
// Service Accounts -> Generate new private key) rather than ADC. This also
// means the exact same env vars work unchanged on Cloud Run later.
// ----------------------------------------------------

let app: App | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

function init(): boolean {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    return false;
  }

  try {
    if (getApps().length === 0) {
      app = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          // .env stores the key with literal "\n" sequences; restore real newlines.
          privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
        }),
      });
    } else {
      app = getApps()[0];
    }
    auth = getAuth(app);
    db = getFirestore(app);
    return true;
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err);
    app = null;
    auth = null;
    db = null;
    return false;
  }
}

const configured = init();
if (configured) {
  console.log("Firebase Admin SDK successfully initialized on backend.");
} else {
  console.warn("WARNING: FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY are missing. Auth-gated AI endpoints and the paywall will be unavailable.");
}

export function isFirebaseAdminConfigured(): boolean {
  return configured;
}

// Non-null once isFirebaseAdminConfigured() is true; callers in this codebase
// only reach these after that check (or after a request already required auth).
export const adminAuth = auth as Auth;
export const adminDb = db as Firestore;
