import React, { useState } from "react";
import { Mail, X } from "lucide-react";
import type { TeamInvitationView } from "../lib/teams";

/**
 * An invitation to a team or school license, waiting: nobody joins without
 * saying so, so the app points to the Team page, where it's accepted (or
 * declined). Closing it hides it until the app is next opened.
 */
const DISMISS_KEY = "jointagent_invite_dismissed";

function dismissedFor(teamId: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === teamId;
  } catch {
    return false;
  }
}

export default function TeamInviteBanner({ invitation }: { invitation: TeamInvitationView | null }) {
  const [hidden, setHidden] = useState<string | null>(null);
  if (!invitation || hidden === invitation.teamId || dismissedFor(invitation.teamId)) return null;
  const close = () => {
    try { sessionStorage.setItem(DISMISS_KEY, invitation.teamId); } catch { /* storage blocked: hide for now only */ }
    setHidden(invitation.teamId);
  };
  return (
    <div role="status" data-team-invite="" className="shrink-0 border-b border-[var(--border-main)] bg-[var(--accent-primary-soft)] px-3 py-2 text-[12px] leading-snug text-[var(--text-main)]">
      <div className="flex items-start gap-2">
        <Mail size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">{invitation.teamName}</span> invited you to its license{invitation.role === "admin" ? ", as its admin" : ""}.{" "}
          <a href="/team" target="_blank" rel="noopener" className="font-semibold text-[var(--accent-primary)] underline underline-offset-2">See the invitation</a>
        </p>
        <button type="button" onClick={close} aria-label="Hide until next time" className="-m-1 shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
