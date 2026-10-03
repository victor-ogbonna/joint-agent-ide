import {
  collection, doc, addDoc, getDoc, getDocsFromServer, updateDoc, deleteDoc, deleteField,
  query, orderBy, serverTimestamp, Timestamp
} from "firebase/firestore";
import { db } from "./firestore";
import { authedApiRequest } from "./aiClient";
import { MCUType, SchematicComponent, SchematicConnection } from "../types";

// Default board id per MCU family — matches server/boards.ts's DEFAULT_BOARD_ID,
// used as the fallback for projects created before the board picker existed.
const DEFAULT_BOARD_ID: Record<MCUType, string> = { esp32: "esp32dev", arduino: "uno" };

/** One chat turn, trimmed to what is needed to redraw the conversation. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  isPlanResponse?: boolean;
  isContextSummary?: boolean;
  compacted?: boolean;
  images?: string[];
  failed?: boolean;
}

export interface ProjectData {
  name: string;
  code: string;
  /** Conversation for this project. Capped on write — see MAX_STORED_MESSAGES. */
  messages?: StoredMessage[];
  description: string;
  components: SchematicComponent[];
  connections: SchematicConnection[];
  mcu: MCUType;
  boardId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ProjectSummary {
  id: string;
  name: string;
  mcu: MCUType;
  boardId: string;
  updatedAt: Timestamp | null;
  createdAt: Timestamp | null;
  /** When it was moved to Trash; null while it's a normal project. */
  deletedAt: Timestamp | null;
}

/** How long a project stays in Trash before it is deleted for good. */
export const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

const projectsCol = (uid: string) => collection(db, "users", uid, "projects");
const projectDoc = (uid: string, projectId: string) => doc(db, "users", uid, "projects", projectId);

export async function createProject(uid: string, name: string, defaults: Pick<ProjectData, "code" | "description" | "components" | "connections" | "mcu" | "boardId">): Promise<string> {
  const ref = await addDoc(projectsCol(uid), {
    name: name.trim() || "Untitled Project",
    ...defaults,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * The project list couldn't come from the database: no connection, or one
 * that blocks it. (Asked the usual way, Firestore would then answer from its
 * own memory, which on a freshly opened page is empty: "no projects", as if
 * they were gone. So the list is only ever asked of the database itself.)
 * They're safe; the app tries again, and says so meanwhile.
 */
export class ProjectsUnreachableError extends Error {
  readonly code = "unavailable";
  constructor() {
    super("Couldn't reach your saved projects just now. They're safe: check your connection, then try again.");
    this.name = "ProjectsUnreachableError";
  }
}

async function listAll(uid: string): Promise<ProjectSummary[]> {
  const q = query(projectsCol(uid), orderBy("updatedAt", "desc"));
  let snap;
  try {
    snap = await getDocsFromServer(q);
  } catch (err: any) {
    // No connection: not "no projects" (above). Anything else, as it is.
    if (err?.code === "unavailable") throw new ProjectsUnreachableError();
    throw err;
  }
  return snap.docs.map(d => {
    const data = d.data();
    const mcu: MCUType = data.mcu || "esp32";
    return {
      id: d.id,
      name: data.name || "Untitled Project",
      mcu,
      boardId: data.boardId || DEFAULT_BOARD_ID[mcu],
      updatedAt: data.updatedAt ?? null,
      createdAt: data.createdAt ?? null,
      deletedAt: data.deletedAt ?? null,
    };
  });
}

/**
 * The account's projects, from one read: the live ones (most recently
 * updated first), and the ones in Trash (most recently deleted first).
 */
export async function listProjectsAndTrash(uid: string): Promise<{ live: ProjectSummary[]; trashed: ProjectSummary[] }> {
  const all = await listAll(uid);
  return {
    live: all.filter((p) => !p.deletedAt),
    trashed: all.filter((p) => p.deletedAt).sort((a, b) => millis(b.deletedAt) - millis(a.deletedAt)),
  };
}

/** The account's projects, not counting the ones in Trash. */
export async function listProjects(uid: string): Promise<ProjectSummary[]> {
  return (await listProjectsAndTrash(uid)).live;
}

/** Projects in Trash, most recently deleted first. */
export async function listTrashedProjects(uid: string): Promise<ProjectSummary[]> {
  return (await listProjectsAndTrash(uid)).trashed;
}

function millis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** When a project in Trash will be deleted for good. */
export function trashExpiresAt(deletedAt: any): number {
  return millis(deletedAt) + TRASH_MS;
}

export async function getProject(uid: string, projectId: string): Promise<ProjectData | null> {
  const snap = await getDoc(projectDoc(uid, projectId));
  if (!snap.exists()) return null;
  const data = snap.data();
  const mcu: MCUType = data.mcu || "esp32";
  return { ...data, mcu, boardId: data.boardId || DEFAULT_BOARD_ID[mcu] } as ProjectData;
}

export async function updateProject(uid: string, projectId: string, data: Partial<ProjectData>): Promise<void> {
  await updateDoc(projectDoc(uid, projectId), { ...data, updatedAt: serverTimestamp() });
}

export async function renameProject(uid: string, projectId: string, name: string): Promise<void> {
  await updateDoc(projectDoc(uid, projectId), { name: name.trim() || "Untitled Project", updatedAt: serverTimestamp() });
}

/**
 * A project's circuit, which the server keeps beside it (server/circuits.ts),
 * goes when the project goes for good. Best effort: one left behind is never
 * shown, as no project opens it.
 */
async function deleteCircuitOf(projectId: string): Promise<void> {
  try {
    await authedApiRequest(`/api/circuits/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  } catch { /* left behind, unseen */ }
}

/** Deletes a project for good. The app moves projects to Trash first. */
export async function deleteProject(uid: string, projectId: string): Promise<void> {
  await deleteDoc(projectDoc(uid, projectId));
  void deleteCircuitOf(projectId);
}

/** Moves a project to Trash, where it stays TRASH_DAYS days. */
export async function trashProject(uid: string, projectId: string): Promise<void> {
  await updateDoc(projectDoc(uid, projectId), { deletedAt: serverTimestamp() });
}

/** Brings a project back from Trash. */
export async function restoreProject(uid: string, projectId: string): Promise<void> {
  await updateDoc(projectDoc(uid, projectId), { deletedAt: deleteField(), updatedAt: serverTimestamp() });
}

/**
 * Deletes for good the projects that have been in Trash longer than
 * TRASH_DAYS days. Run when the app opens, on the Trash it has just listed
 * (`trashed`), or read here; returns how many went.
 */
export async function purgeExpiredTrash(uid: string, now = Date.now(), trashed?: ProjectSummary[]): Promise<number> {
  const expired = (trashed ?? (await listAll(uid))).filter((p) => p.deletedAt && trashExpiresAt(p.deletedAt) <= now);
  for (const p of expired) {
    await deleteDoc(projectDoc(uid, p.id));
    void deleteCircuitOf(p.id);
  }
  return expired.length;
}

/**
 * Firestore documents are capped at 1 MB, and a long agent conversation with
 * generated code in it gets there faster than you would think. Keep the most
 * recent turns only — they are the ones with context worth restoring — and drop
 * any single message too large to be worth storing.
 */
export const MAX_STORED_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 20000;

export function trimMessagesForStorage(messages: StoredMessage[]): StoredMessage[] {
  const kept = messages.slice(-MAX_STORED_MESSAGES);
  // The latest summary is the agent's memory of everything before it; keep it
  // even when it has scrolled past the storage cap.
  const summary = [...messages].reverse().find((m) => m.isContextSummary);
  if (summary && !kept.includes(summary)) kept.unshift(summary);
  return kept
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: (m.content.length > MAX_MESSAGE_CHARS
        ? m.content.slice(0, MAX_MESSAGE_CHARS) + "\n\n[truncated]"
        : m.content)
        // Images are not saved (a project document has a size limit a photo
        // would exceed); say one was there so the conversation still reads.
        + (m.images?.length ? `\n\n[${m.images.length} image${m.images.length === 1 ? "" : "s"} attached]` : ""),
      timestamp: m.timestamp,
      ...(m.isPlanResponse ? { isPlanResponse: true } : {}),
      ...(m.isContextSummary ? { isContextSummary: true } : {}),
      ...(m.compacted ? { compacted: true } : {}),
      ...(m.failed ? { failed: true } : {}),
    }));
}
