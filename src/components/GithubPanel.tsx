import React, { useEffect, useRef, useState } from "react";
import { X, Github, Loader2, Check, Plus, RefreshCw, Lock, Globe, Paperclip, ExternalLink } from "lucide-react";
import { auth } from "../lib/firebase";

interface Repo { fullName: string; private: boolean; defaultBranch: string; updatedAt: string; }
interface Status { configured: boolean; connected: boolean; login?: string; avatarUrl?: string; }
interface Photo { name: string; dataBase64: string; size: number; }

interface GithubPanelProps {
  onClose: () => void;
  projectName: string;
  code: string;
  description: string;
  boardLabel: string;
  schematicJson: string;
}

const MAX_PHOTOS = 6;
const PHOTO_MAX_EDGE = 1600;

/** Phone photos are 3-8MB; a blob that size has no business in a JSON body. */
async function shrinkPhoto(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.82));
  const dataBase64: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    fr.readAsDataURL(blob);
  });
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "photo";
  return { name: `${base}.jpg`, dataBase64, size: blob.size };
}

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "joint-agent-project";

export default function GithubPanel({
  onClose, projectName, code, description, boardLabel, schematicJson,
}: GithubPanelProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selected, setSelected] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [message, setMessage] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; branch: string } | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);

  const api = async (path: string, init: RequestInit = {}) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("Please sign in first.");
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  };

  const refreshStatus = async () => {
    try { setStatus(await api("/api/github/status")); }
    catch (e: any) { setError(e.message); }
  };

  useEffect(() => { void refreshStatus(); }, []);

  // The OAuth popup posts back when it lands on the callback page.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.source === "joint-agent-github") {
        if (e.data.ok) { void refreshStatus(); setError(""); }
        else setError("GitHub did not complete the connection.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!status?.connected) return;
    setLoadingRepos(true);
    api("/api/github/repos")
      .then((d) => setRepos(d.repos || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingRepos(false));
  }, [status?.connected]);

  useEffect(() => { setNewRepoName(slug(projectName)); }, [projectName]);

  const connect = async () => {
    setError("");
    try {
      const { url } = await api("/api/github/authorize");
      window.open(url, "joint-agent-github", "width=720,height=780");
    } catch (e: any) { setError(e.message); }
  };

  const disconnect = async () => {
    try { await api("/api/github/disconnect", { method: "POST" }); setRepos([]); setSelected(""); await refreshStatus(); }
    catch (e: any) { setError(e.message); }
  };

  const createRepo = async () => {
    setError(""); setCreating(true);
    try {
      const r = await api("/api/github/repos", {
        method: "POST",
        body: JSON.stringify({ name: newRepoName, private: true, description: `${projectName} — built with Joint-Agent IDE` }),
      });
      setRepos((prev) => [{ fullName: r.fullName, private: r.private, defaultBranch: r.defaultBranch, updatedAt: "" }, ...prev]);
      setSelected(r.fullName);
    } catch (e: any) { setError(e.message); }
    finally { setCreating(false); }
  };

  const addPhotos = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setError("");
    try {
      const room = MAX_PHOTOS - photos.length;
      if (room <= 0) throw new Error(`Up to ${MAX_PHOTOS} photos.`);
      const next: Photo[] = [];
      for (const f of Array.from(picked).slice(0, room)) {
        if (!f.type.startsWith("image/")) throw new Error(`${f.name} is not an image.`);
        next.push(await shrinkPhoto(f));
      }
      setPhotos((p) => [...p, ...next]);
    } catch (e: any) { setError(e.message); }
    finally { if (photoInput.current) photoInput.current.value = ""; }
  };

  const push = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const readme =
        `# ${projectName}\n\n${description || "Firmware project."}\n\n` +
        `**Board:** ${boardLabel}\n\n` +
        (photos.length ? `## Build photos\n\n${photos.map((p) => `![${p.name}](photos/${p.name})`).join("\n\n")}\n\n` : "") +
        `---\n\nBuilt with [Joint-Agent IDE](https://jointagentide.com).\n`;

      const files = [
        { path: "src/main.cpp", content: code },
        { path: "README.md", content: readme },
        { path: "schematic.json", content: schematicJson },
        ...photos.map((p) => ({ path: `photos/${p.name}`, content: p.dataBase64, encoding: "base64" as const })),
      ];

      const r = await api("/api/github/commit", {
        method: "POST",
        body: JSON.stringify({ repo: selected, message: message.trim() || `Update ${projectName}`, files }),
      });
      setResult({ url: r.url, branch: r.branch });
      setPhotos([]);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] shrink-0">
          <h2 className="font-display font-bold text-sm flex items-center gap-2 text-[var(--text-main)]">
            <Github size={15} /> Push to GitHub
          </h2>
          <button type="button" onClick={onClose} title="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto terminal-scrollbar">
          {status === null ? (
            <div className="flex justify-center py-6 text-[var(--text-muted)]"><Loader2 size={18} className="animate-spin" /></div>
          ) : !status.configured ? (
            <div className="space-y-2 text-xs text-[var(--text-muted)] leading-relaxed">
              <p className="text-[var(--text-main)] font-medium">GitHub isn&rsquo;t set up on the server yet.</p>
              <p>Create an OAuth App at <span className="font-mono text-[10px]">github.com/settings/developers</span> with the callback URL:</p>
              <p className="font-mono text-[10px] bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-2 py-1 break-all">
                {window.location.origin}/api/github/callback
              </p>
              <p>Then set <span className="font-mono text-[10px]">GITHUB_CLIENT_ID</span> and <span className="font-mono text-[10px]">GITHUB_CLIENT_SECRET</span> in <span className="font-mono text-[10px]">.env</span> on the server and restart.</p>
            </div>
          ) : !status.connected ? (
            <div className="space-y-3">
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Connect your GitHub account to push this project — code, schematic, README and photos of the physical build — as a single commit.
              </p>
              <button type="button" onClick={connect}
                className="w-full flex items-center justify-center gap-2 text-white text-sm font-semibold py-2.5 rounded-lg transition"
                style={{ background: "var(--gradient-accent)" }}>
                <Github size={15} /> Connect GitHub
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs">
                {status.avatarUrl && <img src={status.avatarUrl} alt="" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />}
                <span className="text-[var(--text-main)] font-medium">{status.login}</span>
                <button type="button" onClick={disconnect} className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-red-400 transition">
                  Disconnect
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">Repository</label>
                <div className="flex gap-1.5">
                  <select value={selected} onChange={(e) => setSelected(e.target.value)}
                    className="flex-1 min-w-0 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2 py-2 text-xs text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)]">
                    <option value="">{loadingRepos ? "Loading…" : "Choose a repository…"}</option>
                    {repos.map((r) => (
                      <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</option>
                    ))}
                  </select>
                  <button type="button" title="Refresh" onClick={() => setStatus((s) => (s ? { ...s } : s))}
                    className="px-2 rounded-lg border border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition">
                    <RefreshCw size={13} className={loadingRepos ? "animate-spin" : ""} />
                  </button>
                </div>
                {selected && (
                  <p className="text-[10px] text-[var(--text-subtle)] flex items-center gap-1">
                    {repos.find((r) => r.fullName === selected)?.private ? <Lock size={9} /> : <Globe size={9} />}
                    {repos.find((r) => r.fullName === selected)?.private ? "Private" : "Public"} repository
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">Or create a new one</label>
                <div className="flex gap-1.5">
                  <input value={newRepoName} onChange={(e) => setNewRepoName(e.target.value)}
                    className="flex-1 min-w-0 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2 py-2 text-xs text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)]" />
                  <button type="button" onClick={createRepo} disabled={creating || !newRepoName}
                    className="flex items-center gap-1 px-2.5 rounded-lg border border-[var(--border-main)] text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50">
                    {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-subtle)]">New repositories are private.</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">Commit message</label>
                <input value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder={`Update ${projectName}`}
                  className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2 py-2 text-xs text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]" />
              </div>

              <div className="space-y-1.5">
                <input ref={photoInput} type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => addPhotos(e.target.files)} />
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => photoInput.current?.click()} disabled={photos.length >= MAX_PHOTOS}
                    className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] rounded-md border border-[var(--border-main)] bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50">
                    <Plus size={12} /> Add photos
                  </button>
                  <span className="text-[9px] text-[var(--text-subtle)]">{photos.length}/{MAX_PHOTOS} · committed to /photos and linked in the README</span>
                </div>
                {photos.map((p, i) => (
                  <div key={`${p.name}-${i}`} className="flex items-center gap-1.5 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-2 py-1">
                    <Paperclip size={10} className="text-[var(--text-muted)] shrink-0" />
                    <span className="text-[10px] text-[var(--text-main)] truncate flex-1">{p.name}</span>
                    <span className="text-[9px] text-[var(--text-subtle)] shrink-0">{Math.round(p.size / 1024)}KB</span>
                    <button type="button" onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                      className="text-[var(--text-muted)] hover:text-red-400 transition shrink-0"><X size={11} /></button>
                  </div>
                ))}
              </div>

              {error && <p className="text-[11px] text-red-500 leading-relaxed">{error}</p>}

              {result && (
                <a href={result.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[11px] text-green-500 hover:underline">
                  <Check size={12} /> Pushed to {result.branch} — view the commit <ExternalLink size={10} />
                </a>
              )}

              <button type="button" onClick={push} disabled={!selected || busy}
                className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
                style={{ background: "var(--gradient-accent)" }}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <><Github size={15} /> Push project</>}
              </button>
            </>
          )}

          {error && status?.connected === false && <p className="text-[11px] text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
