import React, { useCallback, useEffect, useState } from "react";
import { CircuitBoard, AlertCircle, Loader2, UserPlus, Trash2 } from "lucide-react";

/**
 * Who may use circuits (server/circuits.ts): the agent building the circuit
 * with the code, the circuit view in schematic.view, and Play to simulate
 * it. The owner always may; everyone else sees "Coming soon" until their
 * address is added here. Matched on a verified address only, as every grant.
 */

type Get = (path: string) => Promise<Response | null>;
type Post = (path: string, body: unknown) => Promise<Response | null>;

export default function CircuitAccess({ get, post }: { get: Get; post: Post }) {
  const [emails, setEmails] = useState<string[] | null>(null);
  const [ownerEmails, setOwnerEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await get("/api/admin/circuit-access");
      if (!res) return;
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || "Couldn't load the list."); return; }
      setEmails(Array.isArray(d.circuitAccessEmails) ? d.circuitAccessEmails : []);
      setOwnerEmails(Array.isArray(d.ownerEmails) ? d.ownerEmails : []);
    } catch {
      setError("Could not reach the server.");
    }
  }, [get]);

  useEffect(() => { void load(); }, [load]);

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await post("/api/admin/circuit-access", { circuitAccessEmails: next });
      if (!res) return;
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || "Could not save."); return; }
      setEmails(Array.isArray(d.circuitAccessEmails) ? d.circuitAccessEmails : []);
      if (d.durable === false) setNote("Saved, but only until the server restarts: this server keeps its settings on a disk that's replaced on restart.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email || !emails) return;
    if (emails.includes(email)) { setNewEmail(""); return; }
    setNewEmail("");
    void save([...emails, email]);
  };

  const list = emails ?? [];

  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4 mb-4">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
          <CircuitBoard size={14} />
        </div>
        <h2 className="font-display font-bold text-sm">Auto schematic &amp; simulation</h2>
        <span className="ml-auto font-mono text-xs text-[var(--text-main)]">{emails === null ? "…" : list.length}</span>
      </div>

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        These accounts get circuits: the agent builds the circuit along with the code, the circuit is
        saved with each project, and <span className="text-[var(--text-main)]">schematic.view</span> lets them
        edit it and press Play to simulate it. Everyone else sees &ldquo;Coming soon&rdquo;. Each person can
        still turn the automatic circuit off in their own Settings.
      </p>

      <form onSubmit={add} className="space-y-2.5">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="name@example.com"
          aria-label="Email address to grant circuits"
          className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
        />
        <button
          type="submit"
          disabled={saving || emails === null || !newEmail.trim()}
          className="flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
          Grant circuits
        </button>
      </form>

      {error && (
        <div className="flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {note && <p className="text-[11px] text-[var(--text-muted)]">{note}</p>}

      {list.length > 0 && (
        <div className="border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)] max-h-56 overflow-y-auto">
          {list.map((email) => (
            <div key={email} className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="font-mono text-[var(--text-main)] truncate">{email}</span>
              <button
                type="button"
                onClick={() => void save(list.filter((x) => x !== email))}
                disabled={saving}
                aria-label={`Remove circuits from ${email}`}
                title="Remove"
                className="ml-auto shrink-0 p-1 text-[var(--text-subtle)] hover:text-red-400 transition disabled:opacity-50"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
        Always on for the owner, not editable here:{" "}
        <span className="font-mono">{ownerEmails.join(", ") || "—"}</span>. A granted address must be
        verified (Google sign-in, or a confirmed email) to match. A change applies the next time that
        person opens or reloads the app.
      </p>
    </div>
  );
}
