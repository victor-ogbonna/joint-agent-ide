import React, { useEffect, useState } from "react";
import { X, Share2, Copy, Check, Loader2, ExternalLink, Link2Off, ShieldCheck } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

/**
 * Sharing the open project as a read-only link (server/share.ts). The link
 * shows the project as it is now, code and circuit, with passwords, keys and
 * WiFi details hidden; the chat with the agent is never shared.
 */
export default function ShareDialog({ projectId, projectName, onClose }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [shareId, setShareId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = shareId ? `${window.location.origin}/share/${shareId}` : "";

  const call = async (method: "GET" | "POST" | "DELETE") => {
    const token = await user?.getIdToken();
    const res = await fetch(`/api/share/${encodeURIComponent(projectId)}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Something went wrong. Try again.");
    return body as { shared: boolean; id?: string };
  };

  useEffect(() => {
    let cancelled = false;
    call("GET")
      .then((b) => { if (!cancelled) setShareId(b.shared && b.id ? b.id : null); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const act = async (method: "POST" | "DELETE") => {
    setWorking(true);
    setError(null);
    setCopied(false);
    try {
      const b = await call(method);
      setShareId(b.shared && b.id ? b.id : null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Share2 size={16} className="text-[var(--accent-secondary)]" />
          <h2 id="share-title" className="font-display font-bold text-sm text-[var(--text-main)] min-w-0 truncate">Share "{projectName || "Untitled Project"}"</h2>
          <button onClick={onClose} className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-main)]" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Anyone with the link can see this project's code and circuit, as it is now. They can't change anything.
        </p>
        <div className="flex items-start gap-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-main)] p-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--term-success)]" />
          <span>Passwords, API keys, tokens and WiFi names in the code are hidden. Your chat with the agent is never shared. Open the link to check what others will see.</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-3 text-[var(--text-muted)]"><Loader2 size={18} className="animate-spin" /></div>
        ) : shareId ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                readOnly
                value={link}
                aria-label="Share link"
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)]"
              />
              <button
                onClick={copy}
                className="flex items-center gap-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition shrink-0"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 border border-[var(--border-main)] text-[var(--text-main)] text-xs font-semibold px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition"
              >
                <ExternalLink size={13} /> Open link
              </a>
              <button
                onClick={() => act("DELETE")}
                disabled={working}
                className="flex items-center gap-1.5 text-red-400 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-500/10 disabled:opacity-50 transition"
              >
                {working ? <Loader2 size={13} className="animate-spin" /> : <Link2Off size={13} />} Stop sharing
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => act("POST")}
            disabled={working}
            className="w-full flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition"
          >
            {working ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
            Create link
          </button>
        )}

        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
