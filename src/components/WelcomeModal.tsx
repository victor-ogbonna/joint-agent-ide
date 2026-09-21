import React from "react";
import { X, Plus, FolderOpen, Loader2, Cpu, ArrowRight } from "lucide-react";
import { ProjectSummary } from "../lib/projects";

interface WelcomeModalProps {
  displayName: string;
  projects: ProjectSummary[];
  loading: boolean;
  onNewProject: () => void;
  onOpenProject: (projectId: string) => void;
  onBrowseAll: () => void;
  onClose: () => void;
  /** boardId -> display name, so the list names the actual board. */
  boardNames?: Map<string, string>;
}

const RECENT_SHOWN = 4;

const when = (ts: any): string => {
  const ms = typeof ts?.toMillis === "function" ? ts.toMillis() : typeof ts === "number" ? ts : null;
  if (!ms) return "";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString();
};

export default function WelcomeModal({
  displayName, projects, loading, onNewProject, onOpenProject, onBrowseAll, onClose, boardNames,
}: WelcomeModalProps) {
  const recent = projects.slice(0, RECENT_SHOWN);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between px-5 pt-5 pb-4">
          <div className="min-w-0">
            <h2 className="font-display font-bold text-base text-[var(--text-main)] truncate">
              Welcome back{displayName ? `, ${displayName}` : ""}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {recent.length > 0 ? "Pick up where you left off, or start something new." : "Start your first project."}
            </p>
          </div>
          <button type="button" onClick={onClose} title="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)] shrink-0 -mr-1">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4">
          <button
            type="button"
            onClick={onNewProject}
            className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-semibold py-2.5 rounded-lg transition shadow-sm btn-lift"
            style={{ background: "var(--gradient-accent)" }}
          >
            <Plus size={15} /> Start a new project
          </button>

          {loading ? (
            <div className="flex items-center justify-center py-5 text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : recent.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">Continue a previous project</p>
              <div className="border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)] overflow-hidden">
                {recent.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onOpenProject(p.id)}
                    className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-[var(--bg-hover)] transition"
                  >
                    <Cpu size={13} className="text-[var(--text-muted)] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-[var(--text-main)] truncate">{p.name}</p>
                      <p className="text-[10px] text-[var(--text-muted)] truncate">
                        {boardNames?.get(p.boardId) || (p.mcu || "").toUpperCase()}{when(p.updatedAt) ? ` · ${when(p.updatedAt)}` : ""}
                      </p>
                    </div>
                    <ArrowRight size={13} className="text-[var(--text-subtle)] shrink-0" />
                  </button>
                ))}
              </div>
              {projects.length > RECENT_SHOWN && (
                <button
                  type="button"
                  onClick={onBrowseAll}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] py-1.5 transition"
                >
                  <FolderOpen size={12} /> Browse all {projects.length} projects
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
