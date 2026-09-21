import React, { useEffect, useState } from "react";
import { X, FolderOpen, Plus, Trash2, Cpu, Loader2, FileCode } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { listProjects, deleteProject, ProjectSummary } from "../lib/projects";

interface ProjectsBrowserProps {
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  currentProjectId: string | null;
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

export default function ProjectsBrowser({ onClose, onOpenProject, onNewProject, currentProjectId }: ProjectsBrowserProps) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listProjects(user.uid);
      setProjects(list);
    } catch (err: any) {
      setError("Couldn't load your projects. " + (err?.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [user]);

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm("Delete this project? This can't be undone.")) return;
    setDeletingId(projectId);
    try {
      await deleteProject(user.uid, projectId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (err: any) {
      setError("Couldn't delete that project. " + (err?.message || ""));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-3xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
          <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
            <FolderOpen size={15} className="text-[var(--accent-secondary)]" /> Your Projects
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 terminal-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : error ? (
            <p className="text-xs text-red-400 text-center py-8">{error}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <button
                onClick={onNewProject}
                className="starter-card flex flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--border-main)] rounded-lg p-5 text-[var(--text-muted)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-primary)] transition min-h-[130px]"
              >
                <Plus size={20} />
                <span className="text-xs font-semibold">New Project</span>
              </button>

              {projects.map((p) => (
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
                      onClick={(e) => handleDelete(e, p.id)}
                      disabled={deletingId === p.id}
                      // Hover-reveal hides this completely on a touch screen, where there is
                      // no hover — the delete control simply did not exist on a phone.
                      className="p-1 text-[var(--text-muted)] hover:text-red-400 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition shrink-0"
                      title="Delete project"
                    >
                      {deletingId === p.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                  <h3 className="font-display font-semibold text-xs text-[var(--text-main)] mt-2.5 truncate">{p.name}</h3>
                  <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-[var(--text-muted)]">
                    <Cpu size={10} /> {p.mcu === "esp32" ? "ESP32" : "Arduino Uno"}
                  </div>
                  <p className="text-[9px] text-[var(--text-subtle)] mt-2">{formatDate(p.updatedAt)}</p>
                </div>
              ))}

              {!loading && projects.length === 0 && (
                <div className="col-span-full text-center py-8 text-xs text-[var(--text-muted)]">
                  No saved projects yet — create one to get started.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
