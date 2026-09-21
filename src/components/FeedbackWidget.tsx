import React, { useRef, useState } from "react";
import { MessageSquarePlus, X, Bug, Lightbulb, MessageCircle, Loader2, Check, Plus, Paperclip } from "lucide-react";
import { auth } from "../lib/firebase";

/** Hard caps. The server enforces its own; these keep the upload sane. */
const MAX_FILES = 3;
const MAX_RAW_BYTES = 10 * 1024 * 1024;   // refuse anything absurd before reading it
const MAX_SENT_BYTES = 600 * 1024;        // per attachment, after downscaling
const IMAGE_MAX_EDGE = 1280;

interface Attachment { name: string; type: string; size: number; dataBase64: string; }

/**
 * Photos off a phone are 3-8MB, which no JSON request should carry and which
 * would not fit a Firestore document. Re-draw images at a sane size and
 * re-encode as JPEG; leave non-images alone and let the size cap reject them.
 */
async function prepareFile(file: File): Promise<Attachment> {
  const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    fr.readAsDataURL(blob);
  });

  if (!file.type.startsWith("image/")) {
    const b64 = await toBase64(file);
    return { name: file.name, type: file.type || "application/octet-stream", size: file.size, dataBase64: b64 };
  }

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const b64 = await toBase64(file);
    return { name: file.name, type: file.type, size: file.size, dataBase64: b64 };
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.7));
  const b64 = await toBase64(blob);
  const base = file.name.replace(/\.[^.]+$/, "");
  return { name: `${base}.jpg`, type: "image/jpeg", size: blob.size, dataBase64: b64 };
}

type Kind = "bug" | "idea" | "other";

const KINDS: Array<{ id: Kind; label: string; icon: React.ReactNode }> = [
  { id: "bug", label: "Bug", icon: <Bug size={12} /> },
  { id: "idea", label: "Idea", icon: <Lightbulb size={12} /> },
  { id: "other", label: "Other", icon: <MessageCircle size={12} /> },
];

interface FeedbackWidgetProps {
  boardId?: string;
  mcu?: string;
  /**
   * "sidebar" renders a row in the left rail's bottom group, matching Terminal
   * / Serial Monitor / Serial Plotter. A floating circle in the same corner sat
   * directly on top of Serial Plotter, so the rail owns the trigger whenever it
   * is visible and "fab" is only for narrow layouts where the rail is hidden.
   */
  variant?: "fab" | "sidebar" | "headless";
  /** Controlled open state. "headless" renders the panel only — the trigger
   *  lives elsewhere (the profile menu on phones, where a floating button sat
   *  on top of the files control). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function FeedbackWidget({ boardId, mcu, variant = "fab", open: openProp, onOpenChange }: FeedbackWidgetProps) {
  const [openSelf, setOpenSelf] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openSelf;
  const setOpen = (v: boolean) => { if (!controlled) setOpenSelf(v); onOpenChange?.(v); };
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setOpen(false);
    // Reset only after a successful send — a failed one keeps what they wrote
    // so a network blip doesn't make them retype it.
    if (sent) { setSent(false); setMessage(""); setError(""); setFiles([]); }
  };

  const addFiles = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    setError("");
    setAttaching(true);
    try {
      const room = MAX_FILES - files.length;
      if (room <= 0) throw new Error(`You can attach up to ${MAX_FILES} files.`);
      const next: Attachment[] = [];
      for (const f of Array.from(picked).slice(0, room)) {
        if (f.size > MAX_RAW_BYTES) throw new Error(`${f.name} is too large.`);
        const prepared = await prepareFile(f);
        if (prepared.size > MAX_SENT_BYTES) {
          throw new Error(`${f.name} is still ${Math.round(prepared.size / 1024)}KB after compressing — please attach something smaller.`);
        }
        next.push(prepared);
      }
      setFiles((prev) => [...prev, ...next]);
    } catch (e: any) {
      setError(e.message || "Could not attach that file.");
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("Please sign in first.");
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, message: text, boardId, mcu, page: window.location.pathname, attachments: files }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send that — please try again.");
      setSent(true);
      setMessage("");
      setFiles([]);
    } catch (err: any) {
      setError(err.message || "Could not send that — please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {open && (
        <div className={`fixed ${variant === "sidebar" ? "bottom-24" : "bottom-16"} left-4 z-50 w-[19rem] max-w-[calc(100vw-2rem)] bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden`}>
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--border-main)]">
            <span className="text-xs font-semibold text-[var(--text-main)]">Send feedback</span>
            <button type="button" onClick={close} title="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
              <X size={14} />
            </button>
          </div>

          {sent ? (
            <div className="p-5 text-center space-y-2">
              <div className="w-8 h-8 mx-auto rounded-full bg-green-500/10 text-green-500 flex items-center justify-center">
                <Check size={16} />
              </div>
              <p className="text-xs text-[var(--text-main)] font-medium">Thanks — that reached us.</p>
              <button type="button" onClick={close} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition">Close</button>
            </div>
          ) : (
            <div className="p-3.5 space-y-2.5">
              <div className="flex bg-[var(--bg-root)] p-[3px] rounded-lg border border-[var(--border-main)]">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setKind(k.id)}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition ${kind === k.id ? "text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                    style={kind === k.id ? { background: "var(--gradient-hero)" } : undefined}
                  >
                    {k.icon} {k.label}
                  </button>
                ))}
              </div>

              <textarea
                autoFocus
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={kind === "bug" ? "What happened, and what did you expect?" : kind === "idea" ? "What would you like it to do?" : "Tell us anything."}
                className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2.5 py-2 text-xs text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition resize-none"
              />

              {files.length > 0 && (
                <div className="space-y-1">
                  {files.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="flex items-center gap-1.5 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-2 py-1">
                      <Paperclip size={10} className="text-[var(--text-muted)] shrink-0" />
                      <span className="text-[10px] text-[var(--text-main)] truncate flex-1">{f.name}</span>
                      <span className="text-[9px] text-[var(--text-subtle)] shrink-0">{Math.max(1, Math.round(f.size / 1024))}KB</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        title={`Remove ${f.name}`}
                        className="text-[var(--text-muted)] hover:text-red-400 transition shrink-0"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.txt,.log,.ino,.cpp,.h,.json,.csv,.pdf"
                  onChange={(e) => addFiles(e.target.files)}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attaching || files.length >= MAX_FILES}
                  title={files.length >= MAX_FILES ? `Up to ${MAX_FILES} files` : "Attach a screenshot or file"}
                  className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] rounded-md border border-[var(--border-main)] bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50"
                >
                  {attaching ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  Add files
                </button>
                <span className="text-[9px] text-[var(--text-subtle)]">
                  {files.length}/{MAX_FILES} · photos are compressed
                </span>
              </div>

              {error && <p className="text-[11px] text-red-500">{error}</p>}

              <button
                type="button"
                onClick={send}
                disabled={sending || !message.trim()}
                className="w-full flex items-center justify-center gap-1.5 text-white text-xs font-semibold py-2 rounded-lg transition disabled:opacity-50"
                style={{ background: "var(--gradient-accent)" }}
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : "Send"}
              </button>
              <p className="text-[10px] text-[var(--text-subtle)] leading-snug">
                Your account email and current board are attached so we can follow up.
              </p>
            </div>
          )}
        </div>
      )}

      {variant === "headless" ? null : variant === "sidebar" ? (
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          title="Send feedback"
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${open ? "bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium" : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]"}`}
        >
          <MessageSquarePlus size={13} /> Feedback
        </button>
      ) : (
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          title="Send feedback"
          aria-label="Send feedback"
          className="fixed bottom-4 left-4 z-50 w-9 h-9 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-105 active:scale-95 transition"
          style={{ background: "var(--gradient-accent)", boxShadow: "var(--shadow-glow)" }}
        >
          {open ? <X size={16} /> : <MessageSquarePlus size={16} />}
        </button>
      )}
    </>
  );
}
