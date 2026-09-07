import {
  collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp, Timestamp
} from "firebase/firestore";
import { db } from "./firebase";
import { MCUType, SchematicComponent, SchematicConnection } from "../types";

// Default board id per MCU family — matches server/boards.ts's DEFAULT_BOARD_ID,
// used as the fallback for projects created before the board picker existed.
const DEFAULT_BOARD_ID: Record<MCUType, string> = { esp32: "esp32dev", arduino: "uno" };

export interface ProjectData {
  name: string;
  code: string;
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
