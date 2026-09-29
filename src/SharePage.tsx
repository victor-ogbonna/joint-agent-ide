import React, { useEffect, useMemo, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import { Copy, Check, Cpu, Code, Cable, ShieldCheck, Loader2, ArrowRight } from "lucide-react";
import { useDocumentScroll } from "./useDocumentScroll";

/**
 * A shared project, read-only (server/share.ts): its code and circuit, with
 * passwords and keys hidden by the server before the code ever gets here.
 * Public: no sign-in, nothing on it can change the project.
 */

interface SharedPart { id: string; type?: string; label?: string; value?: string }
interface SharedWire { id: string; fromComponentId: string; fromPin: string; toComponentId: string; toPin: string; color?: string }
interface SharedProject {
  name: string;
  description: string;
  mcu: "esp32" | "arduino";
  boardId: string;
  code: string;
  components: SharedPart[];
  connections: SharedWire[];
  updatedAt: number | null;
}

// Prism's tokens drawn as React elements: the code is someone else's text, so
// it never goes into the page as HTML.
function renderTokens(tokens: Array<string | Prism.Token>, keyPrefix = "t"): React.ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    if (typeof t === "string") return t;
    const alias = Array.isArray(t.alias) ? t.alias.join(" ") : t.alias || "";
    const content = typeof t.content === "string"
      ? t.content
      : renderTokens(Array.isArray(t.content) ? t.content : [t.content as Prism.Token], key);
    return <span key={key} className={`token ${t.type} ${alias}`.trim()}>{content}</span>;
  });
}

const isBoard = (id: string) => ["mcu", "esp32", "arduino", "board", "uno"].includes(String(id).toLowerCase());

export default function SharePage({ shareId }: { shareId: string }) {
  useDocumentScroll();
  const [project, setProject] = useState<SharedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"code" | "circuit">("code");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/shared/${encodeURIComponent(shareId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || "This link doesn't work.");
        else setProject(body as SharedProject);
      })
      .catch(() => { if (!cancelled) setError("Couldn't load this project. Check your connection and try again."); });
    return () => { cancelled = true; };
  }, [shareId]);

  useEffect(() => {
    document.title = project ? `${project.name} · Joint-Agent IDE` : "Shared project · Joint-Agent IDE";
  }, [project]);

  const highlighted = useMemo(
    () => (project ? renderTokens(Prism.tokenize(project.code, Prism.languages.cpp)) : null),
    [project],
  );
  const lineCount = project ? project.code.split("\n").length : 0;
  const boardName = project ? (project.mcu === "esp32" ? "ESP32" : "Arduino") : "";
  const partName = (id: string) => {
    if (isBoard(id)) return boardName;
    const part = project?.components.find((c) => c.id === id);
    return part?.label || part?.type || id;
  };

  const copy = async () => {
    if (!project) return;
    try {
      await navigator.clipboard.writeText(project.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the code can still be selected by hand */ }
  };

  const header = (
    <header className="border-b border-[var(--border-main)] bg-[var(--bg-panel)]">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <a href="/" className="flex items-center gap-2 font-display font-bold text-sm text-[var(--text-main)]">
          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white" style={{ background: "var(--gradient-hero)" }}>
            <Cpu size={14} />
          </span>
          Joint-Agent IDE
        </a>
        <a href="/" className="ml-auto flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 transition">
          Build your own <ArrowRight size={13} />
        </a>
      </div>
    </header>
  );

  if (!project) {
    return (
      <div className="min-h-screen bg-[var(--bg-root)] text-[var(--text-main)]">
        {header}
        <main className="mx-auto max-w-6xl px-4 py-20 text-center">
          {error ? (
            <p className="text-sm text-[var(--text-muted)]">{error}</p>
          ) : (
            <Loader2 size={22} className="mx-auto animate-spin text-[var(--text-muted)]" />
          )}
        </main>
      </div>
    );
  }

  const codePanel = (
    <section className="min-w-0 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--border-main)] px-4 py-2.5">
        <Code size={14} className="text-[var(--accent-secondary)]" />
        <h2 className="text-xs font-semibold text-[var(--text-main)]">main.cpp</h2>
        <span className="text-[11px] text-[var(--text-muted)]">{lineCount} lines</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--border-main)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <pre className="m-0 p-4 text-[13px] leading-6 text-[var(--text-main)]" style={{ fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace' }}>
          <code>{highlighted}</code>
        </pre>
      </div>
    </section>
  );

  const circuitPanel = (
    <section className="min-w-0 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--border-main)] px-4 py-2.5">
        <Cable size={14} className="text-[var(--accent-secondary)]" />
        <h2 className="text-xs font-semibold text-[var(--text-main)]">Circuit</h2>
        <span className="text-[11px] text-[var(--text-muted)]">{project.components.length} parts · {project.connections.length} wires</span>
      </div>
      {project.components.length === 0 && project.connections.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">No circuit saved with this project.</p>
      ) : (
        <div className="space-y-4 p-4">
          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Parts</h3>
            <ul className="space-y-1.5 text-xs">
              <li className="flex gap-2 text-[var(--text-main)]"><span className="font-semibold">{boardName}</span><span className="text-[var(--text-muted)]">{project.boardId}</span></li>
              {project.components.map((c) => (
                <li key={c.id} className="flex gap-2 text-[var(--text-main)]">
                  <span className="font-semibold">{c.label || c.type}</span>
                  {c.value && <span className="text-[var(--text-muted)]">{c.value}</span>}
                </li>
              ))}
            </ul>
          </div>
          {project.connections.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Wiring</h3>
              <div className="overflow-x-auto rounded-lg border border-[var(--border-main)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--bg-surface)] text-left text-[11px] text-[var(--text-muted)]">
                    <tr><th className="px-3 py-2 font-medium">From</th><th className="px-3 py-2 font-medium">To</th></tr>
                  </thead>
                  <tbody>
                    {project.connections.map((w) => (
                      <tr key={w.id} className="border-t border-[var(--border-main)]">
                        <td className="px-3 py-2 text-[var(--text-main)]">
                          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle border border-[var(--border-light)]" style={{ background: /^#[0-9a-f]{3,8}$/i.test(w.color || "") ? w.color : "transparent" }} />
                          {partName(w.fromComponentId)} <span className="text-[var(--text-muted)]">{w.fromPin}</span>
                        </td>
                        <td className="px-3 py-2 text-[var(--text-main)]">{partName(w.toComponentId)} <span className="text-[var(--text-muted)]">{w.toPin}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-h-screen bg-[var(--bg-root)] text-[var(--text-main)]">
      {header}
      <main className="mx-auto max-w-6xl px-4 pt-6 pb-16">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Shared project · read-only</p>
        <h1 className="mt-1 font-display text-2xl font-bold text-[var(--text-main)] break-words">{project.name}</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {boardName} · {project.boardId}
          {project.updatedAt ? ` · updated ${new Date(project.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}
        </p>
        {project.description && (
          <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-main)]">{project.description}</p>
        )}
        <p className="mt-3 flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
          <ShieldCheck size={13} className="mt-px shrink-0 text-[var(--term-success)]" />
          Passwords, keys and WiFi details in this code are hidden. Put in your own before uploading it to a board.
        </p>

        {/* Phones: one panel at a time. */}
        <div className="mt-5 flex gap-1 lg:hidden" role="tablist" aria-label="Code or circuit">
          {(["code", "circuit"] as const).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${tab === id ? "bg-[var(--bg-hover)] text-[var(--text-main)]" : "text-[var(--text-muted)]"}`}
            >
              {id === "code" ? "Code" : "Circuit"}
            </button>
          ))}
        </div>
        <div className="mt-3 lg:hidden">{tab === "code" ? codePanel : circuitPanel}</div>

        {/* Wider screens: side by side. */}
        <div className="mt-5 hidden gap-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {codePanel}
          {circuitPanel}
        </div>
      </main>
    </div>
  );
}
