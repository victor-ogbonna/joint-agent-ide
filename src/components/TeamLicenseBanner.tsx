import React, { useState } from "react";
import { Clock, X } from "lucide-react";
import { formatDay } from "../lib/plans";
import { daysLeft, type TeamStatusView } from "../lib/teams";

/**
 * Shown to everyone on a team or school license while it's in its grace
 * days: when it ended, and how long PRO lasts. Closing it hides it until the
 * app is next opened, so nobody misses it.
 */
const DISMISS_KEY = "jointagent_grace_dismissed";

function dismissedFor(graceUntil: number): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === String(graceUntil);
  } catch {
    return false;
  }
}

export default function TeamLicenseBanner({ team }: { team: TeamStatusView | null }) {
  const [hidden, setHidden] = useState<number | null>(null);
  if (!team || team.state !== "grace" || team.graceUntil === null || team.paidUntil === null) return null;
  const graceUntil = team.graceUntil;
  if (hidden === graceUntil || dismissedFor(graceUntil)) return null;

  const days = daysLeft(graceUntil);
  const whose = team.kind === "school" ? "school's" : "team's";
  const close = () => {
    try { sessionStorage.setItem(DISMISS_KEY, String(graceUntil)); } catch { /* storage blocked: hide for now only */ }
    setHidden(graceUntil);
  };

  return (
    <div role="status" className="shrink-0 border-b border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[12px] leading-snug text-[var(--text-main)]">
      <div className="flex items-start gap-2">
        <Clock size={14} className="mt-0.5 shrink-0 text-orange-500" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">{team.name}</span>'s license ended on {formatDay(team.paidUntil)}.{" "}
          {team.role === "admin" ? "Everyone keeps" : "You keep"} PRO for {days} more day{days === 1 ? "" : "s"}, until {formatDay(graceUntil)}.{" "}
          {team.role === "admin" ? (
            <a href="/team" target="_blank" rel="noopener" className="font-semibold text-[var(--accent-primary)] underline underline-offset-2">Renew now</a>
          ) : (
            <>Ask your {whose} admin to renew it.</>
          )}
        </p>
        <button type="button" onClick={close} aria-label="Hide until next time" className="-m-1 shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
