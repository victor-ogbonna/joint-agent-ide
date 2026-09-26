import {
  collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp, Timestamp
} from "firebase/firestore";
import { db } from "./firebase";
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
}

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

export async function listProjects(uid: string): Promise<ProjectSummary[]> {
  const q = query(projectsCol(uid), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
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
    };
  });
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

export async function deleteProject(uid: string, projectId: string): Promise<void> {
  await deleteDoc(projectDoc(uid, projectId));
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
    }));
}
