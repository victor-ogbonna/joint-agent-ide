import crypto from "crypto";
import type express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { hideSecrets } from "./hideSecrets";

/**
 * Sharing a project: a read-only link to its code and circuit.
 *
 * The owner turns sharing on for one project and gets a link with a random,
 * unguessable id. Anyone with the link sees the project as it is now, name,
 * board, description, code and circuit, with passwords, keys and tokens
 * hidden (server/hideSecrets.ts). The conversation with the agent is never
 * shared. Stop sharing ends the link; while the project is in Trash the
 * link shows nothing, and restoring the project brings it back.
 *
 * Stored server-side only (the Firestore rules let no browser touch these):
 *   shares/{shareId}               { uid, projectId, createdAt }
 *   users/{uid}.sharedProjects     { [projectId]: shareId }
 */

const SHARES = "shares";
const PROJECT_ID = /^[A-Za-z0-9]{1,64}$/;
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

function newShareId(): string {
  return crypto.randomBytes(16).toString("base64url"); // 22 characters, 128 bits
}

// Simple in-memory limits: sharing by account, viewing by address.
const hits = new Map<string, number[]>();
function allowed(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 20000) hits.delete(hits.keys().next().value as string);
  return true;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 200) : []);
const millis = (v: any): number | null => (v && typeof v.toMillis === "function" ? v.toMillis() : null);

/** What a shared link shows: never the conversation, never a secret in the code. */
export function sharedView(project: Record<string, any>) {
  return {
    name: text(project.name, 200) || "Untitled Project",
    description: text(project.description, 5000),
    mcu: project.mcu === "esp32" ? "esp32" : "arduino",
    boardId: text(project.boardId, 64),
    code: hideSecrets(text(project.code, 500_000)),
    components: list(project.components),
    connections: list(project.connections),
    updatedAt: millis(project.updatedAt),
  };
}

export function registerShareRoutes(app: express.Express, requireFirebaseAuth: express.RequestHandler) {
  const projectRef = (uid: string, projectId: string) => adminDb.collection("users").doc(uid).collection("projects").doc(projectId);
  const userRef = (uid: string) => adminDb.collection("users").doc(uid);
  const noFirebase = (res: express.Response) => res.status(503).json({ error: "Sharing isn't available right now." });

  /** Whether one of your projects is shared, and its link id. */
  app.get("/api/share/:projectId", requireFirebaseAuth, async (req: any, res) => {
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    const snap = await userRef(req.uid).get();
    const id = snap.get(`sharedProjects.${projectId}`);
    res.json(typeof id === "string" && SHARE_ID.test(id) ? { shared: true, id } : { shared: false });
  });

  /** Turn sharing on: the existing link if there is one, else a new one. */
  app.post("/api/share/:projectId", requireFirebaseAuth, async (req: any, res) => {
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    if (!allowed(`share:${req.uid}`, 60, 60 * 60 * 1000)) {
      return res.status(429).json({ error: "That's a lot of sharing at once. Try again in a while." });
    }
    const project = await projectRef(req.uid, projectId).get();
    if (!project.exists || project.get("deletedAt")) {
      return res.status(404).json({ error: "Save the project first, then share it." });
    }
    const id = await adminDb.runTransaction(async (tx) => {
      const user = await tx.get(userRef(req.uid));
      const existing = user.get(`sharedProjects.${projectId}`);
      if (typeof existing === "string" && SHARE_ID.test(existing)) return existing;
      const fresh = newShareId();
      tx.create(adminDb.collection(SHARES).doc(fresh), { uid: req.uid, projectId, createdAt: FieldValue.serverTimestamp() });
      tx.set(userRef(req.uid), { sharedProjects: { [projectId]: fresh } }, { merge: true });
      return fresh;
    });
    res.json({ shared: true, id });
  });

  /** Stop sharing: the link stops working at once. */
  app.delete("/api/share/:projectId", requireFirebaseAuth, async (req: any, res) => {
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    await adminDb.runTransaction(async (tx) => {
      const user = await tx.get(userRef(req.uid));
      const id = user.get(`sharedProjects.${projectId}`);
      if (typeof id === "string" && SHARE_ID.test(id)) tx.delete(adminDb.collection(SHARES).doc(id));
      if (user.exists) tx.update(userRef(req.uid), { [`sharedProjects.${projectId}`]: FieldValue.delete() });
    });
    res.json({ shared: false });
  });

  /** The public, read-only view behind a link. No sign-in. */
  app.get("/api/shared/:shareId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    const shareId = String(req.params.shareId || "");
    const gone = () => res.status(404).json({ error: "This link doesn't work any more. The owner may have stopped sharing the project." });
    if (!SHARE_ID.test(shareId)) return gone();
    if (!allowed(`view:${req.ip || "unknown"}`, 120, 60 * 1000)) {
      return res.status(429).json({ error: "Too many requests. Try again in a minute." });
    }
    const share = await adminDb.collection(SHARES).doc(shareId).get();
    const uid = share.get("uid");
    const projectId = share.get("projectId");
    if (!share.exists || typeof uid !== "string" || typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return gone();
    const project = await projectRef(uid, projectId).get();
    if (!project.exists || project.get("deletedAt")) return gone();
    res.json(sharedView(project.data() || {}));
  });
}
