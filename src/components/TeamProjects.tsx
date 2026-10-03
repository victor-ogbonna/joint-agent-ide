import React, { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Eye, EyeOff, Pencil, Copy, Trash2, Unlock, Share2, Loader2, X, ExternalLink, Cpu, Code, Cable, MessageSquare, Send } from "lucide-react";
import { formatDay } from "../lib/plans";

/**
 * Working together on /team (server/teamProjects.ts), each only by the
 * person's own choice: the team's shared projects and their comments, the
 * member's switch for letting admins see their projects, and the read-only
 * view of a project.
 */

export type Call = (path: string, body?: unknown) => Promise<{ ok: boolean; data: any }>;

// As on the rest of /team (TeamPage.tsx).
const card = "rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-5";
const button = "inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-main)] px-3 text-[13px] font-medium text-[var(--text-main)] transition hover:bg-[var(--bg-hover)] disabled:opacity-50";
const heading = "flex items-center gap-2 text-[14px] font-semibold text-[var(--text-main)]";
const small = "text-[12px] text-[var(--text-muted)]";

const BOARD_NAMES: Record<string, string> = { uno: "Arduino Uno", megaatmega2560: "Arduino Mega", nanoatmega328: "Arduino Nano", esp32dev: "ESP32" };
const boardName = (mcu: string, boardId: string) => BOARD_NAMES[boardId] || boardId || (mcu === "arduino" ? "Arduino" : "ESP32");

function Notes({ error, note }: { error: string | null; note: React.ReactNode }) {
  return (
    <>
      {error && <p role="alert" className="mt-2 text-[13px] text-red-500">{error}</p>}
      {note && <p role="status" className="mt-2 text-[13px] text-green-500">{note}</p>}
    </>
  );
}

// ---- The read-only view ----

interface ProjectView {
  name: string;
  description: string;
  mcu: string;
  boardId: string;
  code: string;
  components: { id?: string; type?: string; label?: string }[];
  connections: unknown[];
}

/** A project to look at, not change: the code and circuit, its secrets hidden by the server. */
export function ProjectViewer({ title, load, onClose }: { title: string; load: () => Promise<{ ok: boolean; data: any }>; onClose: () => void }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((r) => {
      if (!live) return;
      if (r.ok) setView(r.data as ProjectView);
      else setError(r.data.error || "It couldn't be opened.");
    }).catch(() => { if (live) setError("Couldn't reach the server. Try again."); });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { live = false; window.removeEventListener("keydown", onKey); };
  }, [load, onClose]);
  const parts = view ? view.components.filter((c) => !["mcu", "esp32", "arduino", "board", "uno"].includes(String(c.id ?? "").toLowerCase())) : [];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-main)] px-5 py-3">
          <div className="min-w-0">
            <h2 className="break-words font-display text-[16px] font-bold text-[var(--text-main)]">{view?.name || title}</h2>
            <p className={small}>Read-only. Passwords, keys and tokens in the code are hidden.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? <p role="alert" className="text-[13px] text-red-500">{error}</p> : !view ? (
            <p className={`flex items-center gap-2 ${small}`}><Loader2 size={14} className="animate-spin" /> Opening…</p>
          ) : (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[13px] text-[var(--text-main)]"><Cpu size={14} className="text-[var(--accent-primary)]" aria-hidden="true" /> {boardName(view.mcu, view.boardId)}</p>
              {view.description && <p className="whitespace-pre-wrap text-[13px] text-[var(--text-muted)]">{view.description}</p>}
              <div>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Code size={13} aria-hidden="true" /> Code</h3>
                <pre className="max-h-[50vh] overflow-auto rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text-main)]">{view.code || "// No code yet."}</pre>
              </div>
              <div>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Cable size={13} aria-hidden="true" /> Circuit</h3>
                <p className="text-[13px] text-[var(--text-main)]">
                  {parts.length ? `${parts.length} part${parts.length === 1 ? "" : "s"}: ${parts.map((c) => c.label || c.type || c.id).join(", ")}` : "Just the board."}
                  {view.connections.length ? ` ${view.connections.length} connection${view.connections.length === 1 ? "" : "s"}.` : ""}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- The member's choice ----

export function ConsentCard({ teamName, allowed, call, reload }: { teamName: string; allowed: boolean; call: Call; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call("/api/team/consent", { adminsCanView: !allowed });
      if (!r.ok) setError(r.data.error || "That didn't work. Try again.");
      else await reload();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={card} data-consent="">
      <h2 className={heading}>{allowed ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />} Your projects and the team's admins</h2>
      <p className={`mt-1 ${small}`}>
        You choose whether the admins of {teamName} can see your projects. They'd see them read-only: the code and the circuit, with passwords, keys and tokens hidden, never your conversations with the agent. You can change this any time.
      </p>
      <p className="mt-3 text-[14px] text-[var(--text-main)]">
        {allowed ? <>The team's admins <strong>can</strong> see your projects.</> : <>Your projects are <strong>private</strong>: the team's admins can't see them.</>}
      </p>
      <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void change()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : allowed ? <EyeOff size={14} /> : <Eye size={14} />}
        {allowed ? "Stop letting admins see my projects" : "Let admins see my projects"}
      </button>
      <Notes error={error} note={null} />
    </section>
  );
}

// ---- Admins: a member's projects, once the member allows it ----

export function MemberProjects({ uid, email, call, locked = null }: {
  uid: string;
  email: string | null;
  call: Call;
  /** While the license isn't paid: what to show instead of their projects. */
  locked?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; mcu: string; boardId: string; updatedAt: number | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (locked) return;
    setError(null);
    setList(null);
    try {
      const r = await call(`/api/team/members/${encodeURIComponent(uid)}/projects`);
      if (r.ok) setList(r.data.projects || []);
      else setError(r.data.error || "Their projects couldn't be listed.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  };
  const load = useCallback(() => call(`/api/team/members/${encodeURIComponent(uid)}/projects/${encodeURIComponent(viewing?.id ?? "")}`), [call, uid, viewing?.id]);
  const close = useCallback(() => setViewing(null), []);
  return (
    <div className="w-full">
      <button type="button" className={button} onClick={() => void toggle()} aria-expanded={open}>
        <FolderOpen size={14} /> {open ? "Hide projects" : "View projects"}
      </button>
      {open && locked ? locked : open && (
        <div className="mt-2 rounded-lg border border-[var(--border-main)] p-2">
          {error ? <p role="alert" className="text-[12px] text-red-500">{error}</p> : !list ? (
            <p className={`flex items-center gap-2 ${small}`}><Loader2 size={13} className="animate-spin" /> Loading…</p>
          ) : list.length === 0 ? (
            <p className={small}>{email ? `${email} has no projects yet.` : "They have no projects yet."}</p>
          ) : (
            <ul className="divide-y divide-[var(--border-main)]">
              {list.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 break-words text-[13px]">{p.name} <span className="text-[11px] text-[var(--text-subtle)]">· {boardName(p.mcu, p.boardId)}{p.updatedAt ? ` · ${formatDay(p.updatedAt)}` : ""}</span></span>
                  <button type="button" className={button} onClick={() => setViewing({ id: p.id, name: p.name })}><Eye size={14} /> View</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {viewing && <ProjectViewer title={viewing.name} load={load} onClose={close} />}
    </div>
  );
}

// ---- The team's shared projects ----

interface TeamProjectRow {
  id: string;
  name: string;
  mcu: string;
  boardId: string;
  sharedBy: string | null;
  sharedAt: number;
  updatedBy: string | null;
  updatedAt: number;
  editing: { by: string | null; since: number; you: boolean } | null;
  copyId: string | null;
  canRemove: boolean;
  canFree: boolean;
  comments: number;
  newComments: boolean;
}

// ---- Comments on a team project ----

interface TeamComment {
  id: string;
  by: string | null;
  at: number;
  text: string;
  mine: boolean;
  canDelete: boolean;
}

/** As server/teamProjects.ts keeps it. */
const MAX_COMMENT_LENGTH = 1000;

const commentTime = (at: number) => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * A team project's comments, oldest first, and a box to write one. Opening
 * it marks them read. `onCount` tells the list how many there are now.
 */
function CommentsThread({ projectId, call, onCount }: { projectId: string; call: Call; onCount: (n: number) => void }) {
  const [list, setList] = useState<TeamComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const path = `/api/team/projects/${encodeURIComponent(projectId)}/comments`;
  const countRef = useRef(onCount);
  countRef.current = onCount;

  const load = useCallback(async () => {
    try {
      const r = await call(path);
      if (!r.ok) { setError(r.data.error || "The comments couldn't be loaded."); return; }
      const comments: TeamComment[] = r.data.comments || [];
      setList(comments);
      setError(null);
      countRef.current(comments.length);
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  }, [call, path]);
  useEffect(() => { void load(); }, [load]);

  const length = text.trim().length;
  const send = async () => {
    if (!length || length > MAX_COMMENT_LENGTH || busy) return;
    setBusy("send");
    setError(null);
    try {
      const r = await call(path, { text });
      // What they wrote stays in the box if it didn't go.
      if (!r.ok) { setError(r.data.error || "Your comment couldn't be posted. Try again."); return; }
      setText("");
      await load();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const remove = async (c: TeamComment) => {
    if (busy || !window.confirm(c.mine ? "Delete your comment?" : `Delete ${c.by || "this person"}'s comment?`)) return;
    setBusy(`rm:${c.id}`);
    setError(null);
    try {
      const r = await call(`${path}/${encodeURIComponent(c.id)}/delete`, {});
      if (!r.ok) setError(r.data.error || "It couldn't be deleted. Try again.");
      await load();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-[var(--border-main)] p-3" data-comments={projectId}>
      {list === null && !error ? (
        <p className={`flex items-center gap-2 ${small}`}><Loader2 size={13} className="animate-spin" /> Loading comments…</p>
      ) : list && list.length === 0 ? (
        <p className={small}>No comments yet. Leave a note, a question or feedback for the team.</p>
      ) : list ? (
        <ul className="space-y-2.5">
          {list.map((c) => (
            <li key={c.id} data-comment={c.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <p className="text-[11px] text-[var(--text-subtle)]">
                  <span className="font-semibold text-[var(--text-muted)]">{c.mine ? "You" : c.by || "Someone"}</span> · {commentTime(c.at)}
                </p>
                {c.canDelete && (
                  <button type="button" className="text-[11px] text-[var(--text-muted)] underline-offset-2 hover:text-red-500 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void remove(c)}>
                    {busy === `rm:${c.id}` ? "Deleting…" : "Delete"}
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--text-main)]">{c.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {error && <p role="alert" className="mt-2 text-[12px] text-red-500">{error}</p>}
      <div className="mt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
          rows={2}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          className="w-full resize-y rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-3 py-2 text-[13px] text-[var(--text-main)] focus:border-[var(--accent-primary)] focus:outline-none"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className={`text-[11px] ${length > MAX_COMMENT_LENGTH ? "text-red-500" : "text-[var(--text-subtle)]"}`}>{length}/{MAX_COMMENT_LENGTH}</span>
          <button type="button" className={button} disabled={busy !== null || !length || length > MAX_COMMENT_LENGTH} onClick={() => void send()}>
            {busy === "send" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
          </button>
        </div>
      </div>
    </div>
  );
}

/** Opens one of the person's own projects in the app. */
const openInApp = (projectId: string) => { window.location.href = `/?open=${encodeURIComponent(projectId)}`; };

export function TeamProjectsCard({ teamName, call, locked = null }: {
  teamName: string;
  call: Call;
  /** While the license isn't paid, or after it ends: why it's locked, shown instead of the projects. */
  locked?: React.ReactNode;
}) {
  const [rows, setRows] = useState<TeamProjectRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<React.ReactNode>(null);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [mine, setMine] = useState<{ id: string; name: string; mcu: string; boardId: string; shared: boolean }[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // The one project whose comments are open.
  const [thread, setThread] = useState<string | null>(null);
  const counted = useCallback((id: string, n: number) => {
    setRows((rs) => rs && rs.map((r) => (r.id === id ? { ...r, comments: n, newComments: false } : r)));
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await call("/api/team/projects");
      if (r.ok) setRows(r.data.projects || []);
      else setError(r.data.error || "The team's projects couldn't be listed.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  }, [call]);
  // Nothing to load while it's locked; once it's paid (the page reloads), the list loads.
  const isLocked = !!locked;
  useEffect(() => {
    if (isLocked) return;
    void reload();
  }, [reload, isLocked]);

  const act = async (what: string, path: string, done: (data: any) => React.ReactNode | void, body: unknown = {}) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const r = await call(path, body);
      if (!r.ok) { setError(r.data.error || "That didn't work. Try again."); await reload(); return; }
      const shown = done(r.data);
      if (shown) setNote(shown);
      await reload();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const openPicker = async () => {
    if (picking) { setPicking(false); return; }
    setPicking(true);
    setMine(null);
    setPickError(null);
    try {
      const r = await call("/api/team/projects-to-share");
      if (r.ok) setMine(r.data.projects || []);
      else setPickError(r.data.error || "Your projects couldn't be listed.");
    } catch {
      setPickError("Couldn't reach the server. Try again.");
    }
  };
  const share = (p: { id: string; name: string }) => {
    if (!window.confirm(`Share “${p.name}” with ${teamName}?\n\nEveryone on the team can open it, copy it, and change the team's copy. Your own project stays as it is. Passwords, keys and tokens in the code are hidden in the team's copy, and your conversation with the agent isn't shared.`)) return;
    void act(`share:${p.id}`, "/api/team/projects", () => { setPicking(false); return `Shared “${p.name}” with ${teamName}.`; }, { projectId: p.id });
  };

  const load = useCallback(() => call(`/api/team/projects/${encodeURIComponent(viewing?.id ?? "")}`), [call, viewing?.id]);
  const close = useCallback(() => setViewing(null), []);

  return (
    <section className={card} data-team-projects="">
      <h2 className={heading}><Share2 size={16} aria-hidden="true" /> Team projects</h2>
      <p className={`mt-1 ${small}`}>
        Projects someone on the team chose to share. One person edits at a time: Edit opens your own working copy in the app, and Send there makes your version the team's. Everyone can comment on them. Passwords, keys and tokens in shared code are hidden.
      </p>

      {locked ? locked : rows === null && !error ? (
        <p className={`mt-3 flex items-center gap-2 ${small}`}><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : rows && rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-[var(--text-muted)]">Nothing shared yet.</p>
      ) : rows ? (
        <ul className="mt-3 divide-y divide-[var(--border-main)] text-[13px]">
          {rows.map((p) => {
            const others = p.editing && !p.editing.you;
            return (
              <li key={p.id} className="py-3" data-team-project={p.id}>
                <p className="break-words font-medium text-[var(--text-main)]">{p.name}</p>
                <p className="text-[11px] text-[var(--text-subtle)]">
                  {boardName(p.mcu, p.boardId)} · shared by {p.sharedBy || "someone"} · changed {p.updatedBy && p.updatedBy !== p.sharedBy ? `by ${p.updatedBy} ` : ""}on {formatDay(p.updatedAt)}
                </p>
                {p.editing && (
                  <p className="mt-1 text-[12px] font-medium text-orange-400">
                    {p.editing.you ? "You're editing it. Send your changes from the app when you're done." : `${p.editing.by || "Someone"} is editing it now.`}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={button} onClick={() => setViewing({ id: p.id, name: p.name })}><Eye size={14} /> View</button>
                  <button type="button" className={button} aria-expanded={thread === p.id} data-comments-button={p.id} onClick={() => setThread((t) => (t === p.id ? null : p.id))}>
                    <MessageSquare size={14} /> Comments{p.comments ? ` (${p.comments})` : ""}
                    {p.newComments && <span className="rounded-full bg-orange-500 px-1.5 py-px text-[10px] font-semibold text-white">New</span>}
                  </button>
                  {p.editing?.you && p.copyId ? (
                    <>
                      <button type="button" className={button} onClick={() => openInApp(p.copyId as string)}><ExternalLink size={14} /> Open in the app</button>
                      <button type="button" className={button} disabled={busy !== null} onClick={() => void act(`stop:${p.id}`, `/api/team/projects/${encodeURIComponent(p.id)}/stop`, () => "You stopped editing it. The team's copy is unchanged; your working copy stays in your projects.")}>
                        {busy === `stop:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Stop editing
                      </button>
                    </>
                  ) : (
                    <button type="button" className={button} disabled={busy !== null || !!others} onClick={() => void act(`edit:${p.id}`, `/api/team/projects/${encodeURIComponent(p.id)}/edit`, (d) => { openInApp(d.copyId); })}>
                      {busy === `edit:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />} Edit
                    </button>
                  )}
                  <button type="button" className={button} disabled={busy !== null} onClick={() => void act(`copy:${p.id}`, `/api/team/projects/${encodeURIComponent(p.id)}/copy`, (d) => (
                    <>Copied to your projects as “{p.name} (copy)”. <button type="button" className="font-semibold underline underline-offset-2" onClick={() => openInApp(d.projectId)}>Open it</button></>
                  ))}>
                    {busy === `copy:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} Copy to my projects
                  </button>
                  {p.canFree && (
                    <button type="button" className={button} disabled={busy !== null} onClick={() => {
                      if (!window.confirm(`End ${p.editing?.by || "their"}'s turn editing “${p.name}”? Changes they haven't sent stay in their own projects.`)) return;
                      void act(`free:${p.id}`, `/api/team/projects/${encodeURIComponent(p.id)}/free`, () => "It's free to edit again.");
                    }}>
                      {busy === `free:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <Unlock size={14} />} Free it up
                    </button>
                  )}
                  {p.canRemove && (
                    <button type="button" className={`${button} hover:text-red-500`} disabled={busy !== null} onClick={() => {
                      if (!window.confirm(`Remove “${p.name}” from ${teamName}?\n\nEveryone's own copies stay theirs.`)) return;
                      void act(`rm:${p.id}`, `/api/team/projects/${encodeURIComponent(p.id)}/remove`, () => `Removed “${p.name}” from the team.`);
                    }}>
                      {busy === `rm:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove
                    </button>
                  )}
                </div>
                {thread === p.id && <CommentsThread projectId={p.id} call={call} onCount={(n) => counted(p.id, n)} />}
              </li>
            );
          })}
        </ul>
      ) : null}

      {!locked && <div className="mt-3 border-t border-[var(--border-main)] pt-3">
        <button type="button" className={button} onClick={() => void openPicker()} aria-expanded={picking}>
          <Share2 size={14} /> {picking ? "Close" : "Share one of my projects"}
        </button>
        {picking && (
          <div className="mt-2 rounded-lg border border-[var(--border-main)] p-2">
            {pickError ? (
              <p role="alert" className="text-[12px] text-red-500">{pickError}</p>
            ) : !mine ? (
              <p className={`flex items-center gap-2 ${small}`}><Loader2 size={13} className="animate-spin" /> Loading your projects…</p>
            ) : mine.length === 0 ? (
              <p className={small}>You have no projects yet. Make one in the app first.</p>
            ) : (
              <ul className="divide-y divide-[var(--border-main)]">
                {mine.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 break-words text-[13px]">{p.name} <span className="text-[11px] text-[var(--text-subtle)]">· {boardName(p.mcu, p.boardId)}</span></span>
                    {p.shared ? (
                      <span className="text-[12px] text-[var(--text-muted)]">Shared</span>
                    ) : (
                      <button type="button" className={button} disabled={busy !== null} onClick={() => share(p)}>
                        {busy === `share:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />} Share
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>}
      {!locked && <Notes error={error} note={note} />}
      {!locked && viewing && <ProjectViewer title={viewing.name} load={load} onClose={close} />}
    </section>
  );
}
