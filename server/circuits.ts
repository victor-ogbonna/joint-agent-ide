/**
 * Circuits: who may build and simulate them, each person's own switch for
 * the agent building them, and the circuit saved with each project.
 *
 * Access is the owner, plus the verified addresses granted on the admin page
 * (server/access.ts). Everyone else sees the circuit view as "Coming soon",
 * and the agent works for them as it always has.
 *
 * Stored server-side only, written here with the server's own access (the
 * browser's Firestore rules open nothing but a project's own document):
 *   users/{uid}.settings.buildCircuit   false once turned off; on otherwise
 *   users/{uid}/circuits/{projectId}    { diagram, updatedAt }: the project's
 *                                       circuit, as diagram.json text
 * Kept beside the project rather than in it, so a project's document holds
 * only the fields it always has and the rules that check them still pass.
 */
import type express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth } from "./quota";
import { hasCircuitAccess, readCircuitAccessList, sanitiseEmailList } from "./access";
import { saveAdminConfig } from "./adminConfig";
import { parseDiagram } from "../src/sim/diagram";

const PROJECT_ID = /^[A-Za-z0-9]{1,64}$/;
/** A saved circuit's text, at most (the diagram is capped at 300 parts and 2000 wires before this). */
export const MAX_CIRCUIT_CHARS = 400_000;

/** A circuit sent to be saved: checked and rewritten in the diagram's own shape, or why not. */
export function cleanCircuit(text: unknown): { diagram: string } | { error: string } {
  if (typeof text !== "string" || !text) return { error: "No circuit was sent." };
  if (text.length > MAX_CIRCUIT_CHARS) return { error: "That circuit is too big to save." };
  try {
    const diagram = JSON.stringify(parseDiagram(text));
    if (diagram.length > MAX_CIRCUIT_CHARS) return { error: "That circuit is too big to save." };
    return { diagram };
  } catch (err: any) {
    return { error: err?.message || "That isn't a circuit." };
  }
}

// Saves come from the app's autosave, a second and a half after a change
// stops; this many a minute is far beyond that, and stops a loop or a script.
const SAVES_PER_MINUTE = 60;
const saves = new Map<string, { at: number; count: number }>();
function saveAllowed(uid: string, now = Date.now()): boolean {
  const s = saves.get(uid);
  if (!s || now - s.at > 60_000) {
    saves.set(uid, { at: now, count: 1 });
    if (saves.size > 10_000) for (const [k, v] of saves) if (now - v.at > 60_000) saves.delete(k);
    return true;
  }
  s.count++;
  return s.count <= SAVES_PER_MINUTE;
}

export function registerCircuitRoutes(app: express.Express, requireAdmin: express.RequestHandler) {
  const userRef = (uid: string) => adminDb.collection("users").doc(uid);
  const circuitRef = (uid: string, projectId: string) => userRef(uid).collection("circuits").doc(projectId);
  const projectRef = (uid: string, projectId: string) => userRef(uid).collection("projects").doc(projectId);
  const noFirebase = (res: express.Response) => res.status(503).json({ error: "Circuits can't be saved right now." });
  const access = (req: express.Request) => hasCircuitAccess(req.email ?? null, req.emailVerified === true);

  // ---- The admin page's list ----

  app.get("/api/admin/circuit-access", requireAdmin, (_req, res) => {
    res.json(readCircuitAccessList());
  });

  app.post("/api/admin/circuit-access", requireAdmin, async (req, res) => {
    const emails = sanitiseEmailList(req.body?.circuitAccessEmails);
    if (emails === null) return res.status(400).json({ error: "Every entry must be a valid email address." });
    if (emails.length > 500) return res.status(400).json({ error: "That's more addresses than the list holds (500)." });
    const { durable } = await saveAdminConfig({ circuitAccessEmails: emails });
    console.log(`Circuit access list updated via admin page: ${emails.length} address${emails.length === 1 ? "" : "es"}.`);
    res.json({ ...readCircuitAccessList(), durable });
  });

  // ---- Your own settings ----

  app.get("/api/settings", requireFirebaseAuth, async (req, res) => {
    const circuitAccess = access(req);
    if (!isFirebaseAdminConfigured()) return res.json({ circuitAccess, buildCircuit: true });
    const snap = await userRef(req.uid!).get();
    res.json({ circuitAccess, buildCircuit: snap.get("settings.buildCircuit") !== false });
  });

  app.put("/api/settings", requireFirebaseAuth, async (req, res) => {
    const value = req.body?.buildCircuit;
    if (typeof value !== "boolean") return res.status(400).json({ error: "Send buildCircuit as true or false." });
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    await userRef(req.uid!).set({ settings: { buildCircuit: value } }, { merge: true });
    res.json({ circuitAccess: access(req), buildCircuit: value });
  });

  // ---- A project's circuit ----

  app.get("/api/circuits/:projectId", requireFirebaseAuth, async (req, res) => {
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    const snap = await circuitRef(req.uid!, projectId).get();
    const diagram = snap.exists ? snap.get("diagram") : null;
    res.json({ circuit: typeof diagram === "string" ? diagram : null });
  });

  app.put("/api/circuits/:projectId", requireFirebaseAuth, async (req, res) => {
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    if (!access(req)) return res.status(403).json({ error: "Circuits aren't open to this account yet.", code: "NO_CIRCUIT_ACCESS" });
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    if (!saveAllowed(req.uid!)) return res.status(429).json({ error: "Too many saves at once. Your circuit saves with your next change." });
    const clean = cleanCircuit(req.body?.circuit);
    if ("error" in clean) return res.status(400).json({ error: clean.error });
    const project = await projectRef(req.uid!, projectId).get();
    if (!project.exists) return res.status(404).json({ error: "That project can't be found." });
    await circuitRef(req.uid!, projectId).set({ diagram: clean.diagram, updatedAt: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  });

  app.delete("/api/circuits/:projectId", requireFirebaseAuth, async (req, res) => {
    const projectId = String(req.params.projectId || "");
    if (!PROJECT_ID.test(projectId)) return res.status(400).json({ error: "Unknown project." });
    if (!isFirebaseAdminConfigured()) return noFirebase(res);
    await circuitRef(req.uid!, projectId).delete();
    res.json({ ok: true });
  });
}
