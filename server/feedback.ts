import type express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";

const MAX_MESSAGE = 4000;
const KINDS = ["bug", "idea", "other"] as const;
type Kind = (typeof KINDS)[number];

// Per-signed-in-user throttle. This route is auth-gated, so the account is a
// far better key than the IP -- a shared campus NAT would otherwise let one
// person's flood lock out everyone else in the building.
const byUid = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;

function isRateLimited(uid: string): boolean {
  const e = byUid.get(uid);
  if (!e) return false;
  if (Date.now() - e.windowStart > WINDOW_MS) { byUid.delete(uid); return false; }
  return e.count >= MAX_PER_WINDOW;
}

function record(uid: string) {
  const e = byUid.get(uid);
  if (!e || Date.now() - e.windowStart > WINDOW_MS) byUid.set(uid, { count: 1, windowStart: Date.now() });
  else e.count += 1;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Best-effort email delivery. Feedback is written to Firestore FIRST and is
 * readable in /admin regardless, so a missing key or a failing mail provider
 * loses a notification, never the message itself. Configure by setting
 * RESEND_API_KEY and FEEDBACK_TO_EMAIL in .env on the server.
 */
async function emailFeedback(entry: {
  kind: Kind; message: string; email: string; uid: string;
  boardId?: string; mcu?: string; page?: string;
}): Promise<"sent" | "not-configured" | "failed"> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO_EMAIL;
  if (!key || !to) return "not-configured";

  const from = process.env.FEEDBACK_FROM_EMAIL || "Joint-Agent IDE <onboarding@resend.dev>";
  const subject = `[Joint-Agent ${entry.kind}] from ${entry.email}`;
  const rows: Array<[string, string]> = [
    ["From", entry.email],
    ["Type", entry.kind],
    ["Board", entry.boardId || "—"],
    ["Family", entry.mcu || "—"],
    ["Page", entry.page || "—"],
    ["UID", entry.uid],
  ];
  const html =
    `<h2 style="font:600 16px system-ui;margin:0 0 12px">${escapeHtml(entry.kind)} report</h2>` +
    `<table style="font:14px system-ui;border-collapse:collapse;margin-bottom:16px">` +
    rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${k}</td><td>${escapeHtml(v)}</td></tr>`).join("") +
    `</table>` +
    `<pre style="font:14px/1.5 system-ui;white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:6px;margin:0">${escapeHtml(entry.message)}</pre>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // reply_to so hitting Reply in the inbox goes to the person who wrote in.
      body: JSON.stringify({ from, to: [to], subject, html, reply_to: entry.email }),
    });
    if (!r.ok) {
      console.error("Feedback email rejected:", r.status, (await r.text()).slice(0, 300));
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("Feedback email failed:", err);
    return "failed";
  }
}

export function registerFeedbackRoutes(
  app: express.Express,
  requireFirebaseAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler
) {
  app.post("/api/feedback", requireFirebaseAuth, async (req: any, res) => {
    if (!isFirebaseAdminConfigured()) {
      return res.status(503).json({ error: "Feedback isn't configured yet." });
    }
    const uid: string = req.uid;
    if (isRateLimited(uid)) {
      return res.status(429).json({ error: "You've sent a lot of feedback in the last hour — try again later.", code: "RATE_LIMITED" });
    }

    const kind: Kind = KINDS.includes(req.body?.kind) ? req.body.kind : "other";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "Please write something first." });
    if (message.length > MAX_MESSAGE) {
      return res.status(400).json({ error: `Please keep it under ${MAX_MESSAGE} characters.` });
    }

    const entry = {
      uid,
      email: req.email || "(no email)",
      kind,
      message,
      boardId: typeof req.body?.boardId === "string" ? req.body.boardId.slice(0, 64) : "",
      mcu: typeof req.body?.mcu === "string" ? req.body.mcu.slice(0, 32) : "",
      page: typeof req.body?.page === "string" ? req.body.page.slice(0, 200) : "",
      userAgent: String(req.get("user-agent") || "").slice(0, 300),
    };

    try {
      // Stored first, and the response does not wait on the mail provider:
      // the message is safe in Firestore and visible in /admin either way.
      await adminDb.collection("feedback").add({ ...entry, createdAt: FieldValue.serverTimestamp(), emailed: false });
      record(uid);
    } catch (err: any) {
      console.error("Failed to store feedback:", err);
      return res.status(500).json({ error: "Could not save that — please try again." });
    }

    res.json({ ok: true });

    const outcome = await emailFeedback(entry);
    if (outcome === "not-configured") {
      console.warn("Feedback saved but not emailed: set RESEND_API_KEY and FEEDBACK_TO_EMAIL to get notifications.");
    }
  });

  // Admin-gated: this is other people's words and email addresses.
  app.get("/api/feedback/entries", requireAdmin, async (_req, res) => {
    if (!isFirebaseAdminConfigured()) {
      return res.status(503).json({ error: "Feedback isn't configured yet." });
    }
    try {
      const snap = await adminDb.collection("feedback").orderBy("createdAt", "desc").limit(300).get();
      const entries = snap.docs.map((d) => {
        const v = d.data() as any;
        return {
          id: d.id,
          email: v.email || "",
          kind: v.kind || "other",
          message: v.message || "",
          boardId: v.boardId || "",
          mcu: v.mcu || "",
          page: v.page || "",
          createdAt: v.createdAt?.toDate?.().toISOString() || null,
        };
      });
      res.json({ entries, emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.FEEDBACK_TO_EMAIL) });
    } catch (err: any) {
      console.error("Failed to read feedback:", err);
      res.status(500).json({ error: "Could not load feedback." });
    }
  });
}
