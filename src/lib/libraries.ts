import { auth } from "./firebase";

/**
 * The account's libraries (server/libraries.ts). Added once, usable in every
 * project: a build uses one whenever the code #includes one of its headers.
 */
export interface LibraryView {
  id: string;
  kind: "catalogue" | "zip" | "github";
  name: string;
  version: string;
  owner?: string;
  origin?: string;
  headerFiles: string[];
  bytes?: number;
  notes: string[];
}

export interface LibraryListing {
  libraries: LibraryView[];
  usedBytes: number;
  maxBytes: number;
  maxLibraries: number;
}

export interface CatalogueItem {
  owner: string;
  name: string;
  version: string;
  description: string;
  updated: string | null;
}

async function call<T>(path: string, init: { method?: string; json?: unknown; body?: Blob; headers?: Record<string, string> } = {}): Promise<T> {
  const send = async (forceRefresh: boolean) => {
    const user = auth.currentUser;
    if (!user) throw new Error("You must be signed in.");
    const token = await user.getIdToken(forceRefresh);
    return fetch(path, {
      method: init.method || (init.json !== undefined || init.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  let data: any = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    throw new Error(data?.error || (res.status === 413 ? "That file is too large." : "That didn't work. Try again."));
  }
  return data as T;
}

export const fetchLibraries = () => call<LibraryListing>("/api/libraries");

export const searchCatalogue = (query: string, page = 1) =>
  call<{ items: CatalogueItem[]; total: number; page: number; perPage: number }>(
    `/api/libraries/search?${new URLSearchParams({ q: query, page: String(page) })}`);

export const fetchVersions = (owner: string, name: string) =>
  call<{ versions: { version: string; released: string | null }[] }>(
    `/api/libraries/versions?${new URLSearchParams({ owner, name })}`).then((d) => d.versions);

type Added = LibraryListing & { library: LibraryView };

export const addFromCatalogue = (owner: string, name: string, version?: string) =>
  call<Added>("/api/libraries/catalogue", { json: { owner, name, version } });

export const importZip = (file: File) =>
  call<Added>("/api/libraries/import", {
    body: file,
    // Header values must be plain ASCII; the server tidies it further.
    headers: { "Content-Type": "application/zip", "X-File-Name": file.name.replace(/[^\w .+\-()]/g, "_").slice(0, 100) },
  });

export const importGithub = (url: string) => call<Added>("/api/libraries/github", { json: { url } });

export const removeLibrary = (id: string) => call<LibraryListing>(`/api/libraries/${id}`, { method: "DELETE" });

/** "2.4 MB", "340 KB". */
export function formatBytes(n: number): string {
  if (n <= 0) return "0 KB";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
