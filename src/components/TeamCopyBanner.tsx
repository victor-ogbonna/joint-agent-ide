import React from "react";
import { Users, Send, Loader2 } from "lucide-react";

/** What the server says about a project that is someone's working copy of a team project (server/teamProjects.ts). */
export interface TeamCopyInfo {
  teamProjectId: string;
  teamName: string;
  name: string;
  /** The person is editing the team's copy now, with this project. */
  editing: boolean;
  /** Someone else is, instead. */
  editingBy: string | null;
}

/**
 * Shown while a working copy of a team project is open: whose project it
 * is, and the button that makes this version the team's copy. The Team page
 * opens in a new tab, so the app (and its autosave) carries on here.
 */
export default function TeamCopyBanner({ info, sending, note, onSend }: {
  info: TeamCopyInfo;
  sending: boolean;
  /** The outcome of the last send: sent, or why not. */
  note: { ok: boolean; text: string } | null;
  onSend: () => void;
}) {
  return (
    <div role="status" className="shrink-0 border-b border-[var(--border-main)] bg-[var(--accent-primary-soft)] px-3 py-2 text-[12px] leading-snug text-[var(--text-main)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex min-w-0 flex-1 items-start gap-2">
          <Users size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
          <span className="min-w-0">
            Your working copy of “{info.name}”, a <span className="font-semibold">{info.teamName}</span> team project.{" "}
            {info.editing
              ? "When you're done, send your changes: they become the team's copy."
              : info.editingBy
                ? `${info.editingBy} is editing the team's copy now.`
                : "To change the team's copy again, press Edit on the Team page."}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {info.editing && (
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send my changes to the team
            </button>
          )}
          <a href="/team" target="_blank" rel="noopener" className="font-semibold text-[var(--accent-primary)] underline underline-offset-2">
            Team page
          </a>
        </div>
      </div>
      {note && <p className={`mt-1 ${note.ok ? "text-green-500" : "text-red-500"}`}>{note.text}</p>}
    </div>
  );
}
