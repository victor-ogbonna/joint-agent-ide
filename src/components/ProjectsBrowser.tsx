import React, { useEffect, useState } from "react";
import { X, FolderOpen, Plus, Trash2, Cpu, Loader2, FileCode, Search, RotateCcw } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import {
  listProjects, listTrashedProjects, trashProject, restoreProject, deleteProject,
  trashExpiresAt, ProjectSummary, TRASH_DAYS, ProjectsUnreachableError,
} from "../lib/projects";

interface ProjectsBrowserProps {
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  /** The Free plan's limit, shown as "3 of 5"; none for PRO. */
  projectLimit?: number;
  currentProjectId: string | null;
  /** A project went to Trash: the app clears it from the editor if it's open. */
  onProjectTrashed?: (projectId: string, name: string) => void;
  /** The project list changed (restored from Trash). */
  onProjectsChanged?: () => void;
}

function formatDate(ts: any): string {
  if (!ts) return "just now";
  try {
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ProjectsBrowser({ onClose, onOpenProject, onNewProject, currentProjectId, projectLimit, onProjectTrashed, onProjectsChanged }: ProjectsBrowserProps) {
  const { user } = useAuth();
  const [view, setView] = useState<"projects" | "trash">("projects");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [trash, setTrash] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The list itself couldn't load: offer to try again. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Name or board, any order of words: "mega blink" finds "Blink" on a Mega.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (p: ProjectSummary) => {
    const haystack = `${p.name} ${p.boardId || ""} ${p.mcu || ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  };
  const shown = words.length ? projects.filter(matches) : projects;
  const shownTrash = words.length ? trash.filter(matches) : trash;

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    setLoadFailed(false);
    try {
      const [live, trashed] = await Promise.all([listProjects(user.uid), listTrashedProjects(user.uid)]);
      setProjects(live);
      setTrash(trashed);
    } catch (err: any) {
      setError(err instanceof ProjectsUnreachableError ? err.message : "Couldn't load your projects. " + (err?.message || ""));
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [user]);

  const handleTrash = async (e: React.MouseEvent, p: ProjectSummary) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm(`Move "${p.name}" to Trash? You can restore it for ${TRASH_DAYS} days.`)) return;
    setBusyId(p.id);
    setError(null);
    try {
      await trashProject(user.uid, p.id);
      onProjectTrashed?.(p.id, p.name);
      await refresh();
    } catch (err: any) {
      setError("Couldn't move that project to Trash. " + (err?.message || ""));
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (p: ProjectSummary) => {
    if (!user) return;
    if (projectLimit !== undefined && projects.length >= projectLimit) {
      setError(`You have ${projects.length} projects, the Free plan's limit. Move one to Trash first, or get PRO for unlimited projects.`);
      return;
    }
    setBusyId(p.id);
    setError(null);
    try {
      await restoreProject(user.uid, p.id);
      onProjectsChanged?.();
      await refresh();
    } catch (err: any) {
      setError("Couldn't restore that project. " + (err?.message || ""));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteForever = async (p: ProjectSummary) => {
    if (!user) return;
    if (!window.confirm(`Delete "${p.name}" for good? This can't be undone.`)) return;
    setBusyId(p.id);
    setError(null);
    try {
      await deleteProject(user.uid, p.id);
      setTrash((prev) => prev.filter((t) => t.id !== p.id));
    } catch (err: any) {
      setError("Couldn't delete that project. " + (err?.message || ""));
    } finally {
      setBusyId(null);
    }
  };

  const tab = (id: "projects" | "trash", label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      onClick={() => setView(id)}
      className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${view === id ? "bg-[var(--bg-hover)] text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
    >
      {label}{!loading && <span className="ml-1 font-normal tabular-nums text-[var(--text-subtle)]">{count}</span>}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-3xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
          <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
            <FolderOpen size={15} className="text-[var(--accent-secondary)]" /> Your Projects
            {projectLimit !== undefined && !loading && !error && (
              <span className="text-[11px] font-normal text-[var(--text-muted)] tabular-nums">
                {Math.min(projects.length, projectLimit)} of {projectLimit} · Free plan
              </span>
            )}
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-main)]" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-main)] shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex gap-1 shrink-0" role="tablist" aria-label="Projects or Trash">
            {tab("projects", "Projects", projects.length)}
            {tab("trash", "Trash", trash.length)}
          </div>
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === "trash" ? "Search Trash" : "Search projects by name or board"}
              aria-label="Search projects"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-9 pr-3 py-2 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 terminal-scrollbar">
          {error && (
            <p className="text-xs text-red-400 text-center pb-4" role="alert">
              {error}
              {loadFailed && <>{" "}<button type="button" onClick={() => void refresh()} className="font-semibold text-[var(--accent-primary)] hover:underline">Try again</button></>}
            </p>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : view === "projects" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <button
                onClick={onNewProject}
                className="starter-card flex flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--border-main)] rounded-lg p-5 text-[var(--text-muted)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-primary)] transition min-h-[130px]"
              >
                <Plus size={20} />
                <span className="text-xs font-semibold">New Project</span>
              </button>

              {shown.map((p) => (
                <div
                  key={p.id}
                  onClick={() => onOpenProject(p.id)}
                  className={`starter-card relative text-left bg-[var(--bg-surface)] border rounded-lg p-4 cursor-pointer transition group ${p.id === currentProjectId ? "border-[var(--accent-primary)]" : "border-[var(--border-main)]"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="p-1.5 bg-[var(--bg-root)] rounded-md text-[var(--accent-secondary)] shrink-0">
                      <FileCode size={14} />
                    </div>
                    <button
                      onClick={(e) => handleTrash(e, p)}
                      disabled={busyId === p.id}
                      // Hover-reveal hides this completely on a touch screen, where there is
                      // no hover — the delete control simply did not exist on a phone.
                      className="p-1 text-[var(--text-muted)] hover:text-red-400 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition shrink-0"
                      title="Move to Trash"
                      aria-label={`Move ${p.name} to Trash`}
                    >
                      {busyId === p.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                  <h3 className="font-display font-semibold text-xs text-[var(--text-main)] mt-2.5 truncate">{p.name}</h3>
                  <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-[var(--text-muted)]">
                    <Cpu size={10} /> {p.mcu === "esp32" ? "ESP32" : "Arduino Uno"}
                  </div>
                  <p className="text-[9px] text-[var(--text-subtle)] mt-2">{formatDate(p.updatedAt)}</p>
                </div>
              ))}

              {projects.length === 0 && (
                <div className="col-span-full text-center py-8 text-xs text-[var(--text-muted)]">
                  No saved projects yet — create one to get started.
                </div>
              )}
              {projects.length > 0 && shown.length === 0 && (
                <div className="col-span-full text-center py-8 text-xs text-[var(--text-muted)]">
                  No project matches "{query.trim()}".
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-[11px] text-[var(--text-muted)] mb-3">
                Projects in Trash are deleted for good after {TRASH_DAYS} days. Restore one to keep working on it.
              </p>
              {trash.length === 0 ? (
                <p className="text-center py-8 text-xs text-[var(--text-muted)]">Trash is empty.</p>
              ) : shownTrash.length === 0 ? (
                <p className="text-center py-8 text-xs text-[var(--text-muted)]">Nothing in Trash matches "{query.trim()}".</p>
              ) : (
                <ul className="divide-y divide-[var(--border-main)] border border-[var(--border-main)] rounded-lg">
                  {shownTrash.map((p) => (
                    <li key={p.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-[var(--text-main)] truncate">{p.name}</p>
                        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                          {p.mcu === "esp32" ? "ESP32" : "Arduino Uno"} · deleted {formatDay(trashExpiresAt(p.deletedAt) - TRASH_DAYS * 86400000)} · gone for good on {formatDay(trashExpiresAt(p.deletedAt))}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRestore(p)}
                          disabled={busyId === p.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border-main)] text-xs font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition"
                        >
                          {busyId === p.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteForever(p)}
                          disabled={busyId === p.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition"
                        >
                          <Trash2 size={12} />
                          Delete forever
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
