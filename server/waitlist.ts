import type express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-IP throttle against spam/abuse — this endpoint is intentionally public
// (no sign-in required, since the whole point is capturing interest from
// people who haven't signed up yet), so it needs its own limiter rather than
// relying on the auth-gated rate limiting the rest of the API has.
const submissionsByIp = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;

function isRateLimited(ip: string): boolean {
  const entry = submissionsByIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    submissionsByIp.delete(ip);
    return false;
  }
  return entry.count >= MAX_PER_WINDOW;
}

function recordSubmission(ip: string) {
  const entry = submissionsByIp.get(ip);
  if (!entry || Date.now() - entry.windowStart > WINDOW_MS) {
    submissionsByIp.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function registerWaitlistRoutes(app: express.Express) {
  app.post("/api/waitlist/join", async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    if (!isFirebaseAdminConfigured()) {
      return res.status(503).json({ error: "Waitlist isn't configured yet." });
    }

    const { email } = req.body || {};
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const normalized = email.trim().toLowerCase();

    try {
      // Doc ID = the email itself, so re-submitting just updates the
      // timestamp instead of creating duplicate entries.
      await adminDb.collection("waitlist").doc(normalized).set(
        { email: normalized, joinedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      recordSubmission(ip);
      res.json({ success: true });
    } catch (err) {
      console.error("Failed to save waitlist signup:", err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });
}
