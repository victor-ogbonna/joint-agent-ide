import React, { useMemo, useState } from "react";
import { X, Globe, ExternalLink, Wifi, Info, Monitor, Smartphone, Code2 } from "lucide-react";

interface WebPreviewPanelProps {
  onClose: () => void;
  /** The current sketch. Scanned for the HTML the board will serve. */
  code: string;
  /** Terminal + serial text, for finding a live board address. */
  lines: string[];
}

/**
 * Pull the page a sketch serves out of its source.
 *
 * Two shapes cover nearly every Arduino/ESP32 web server:
 *   1. a raw string literal — `R"rawliteral(<!DOCTYPE html>...)rawliteral"` —
 *      which is what the agent generates and what most examples use;
 *   2. ordinary string literals concatenated a line at a time, the
 *      `html += "<p>..."` / `client.println("<p>...")` style.
 * Raw literals win when present: they are unambiguous.
 */
export function extractHtml(code: string): string | null {
  const looksLikeHtml = (s: string) => /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(s);

  // 1. C++11 raw string literals, with whatever delimiter the author chose.
  const raws: string[] = [];
  for (const m of code.matchAll(/R"([^(\s\\]{0,16})\(([\s\S]*?)\)\1"/g)) raws.push(m[2]);
  const rawHit = raws.filter(looksLikeHtml).sort((a, b) => b.length - a.length)[0];
  if (rawHit) return rawHit;

  // 2. Concatenated ordinary literals. Join every double-quoted string that
  //    carries markup and see whether the result is a page.
  const parts: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const unescaped = m[1]
      .replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, "\t")
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (/<\/?[a-z][a-z0-9]*[\s/>]/i.test(unescaped)) parts.push(unescaped);
  }
  const joined = parts.join("");
  return looksLikeHtml(joined) || /<\/html>/i.test(joined) ? joined : null;
}

function detectAddresses(lines: string[]): string[] {
  const found: string[] = [];
  const push = (v: string) => { if (!found.includes(v)) found.push(v); };
  const urlRe = /\bhttps?:\/\/[^\s"'<>)]+/gi;
  const ipRe = /\b((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})\b/g;
  const mdnsRe = /\b([a-z0-9][a-z0-9-]{0,30}\.local)\b/gi;
  for (const line of lines) {
    for (const m of line.matchAll(urlRe)) push(m[0].replace(/[.,;]$/, ""));
    for (const m of line.matchAll(mdnsRe)) push(`http://${m[1]}`);
    for (const m of line.matchAll(ipRe)) {
      const ip = m[1];
      if (ip === "0.0.0.0" || ip === "255.255.255.255" || ip.startsWith("127.")) continue;
      push(`http://${ip}`);
    }
  }
  return found.slice(-6).reverse();
}

export default function WebPreviewPanel({ onClose, code, lines }: WebPreviewPanelProps) {
  const html = useMemo(() => extractHtml(code), [code]);
  const detected = useMemo(() => detectAddresses(lines), [lines]);
  const [width, setWidth] = useState<"phone" | "desktop">("phone");
  const [showSource, setShowSource] = useState(false);

  const open = (raw: string) =>
    window.open(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`, "_blank", "noopener,noreferrer");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-main)] shrink-0 gap-2">
          <h2 className="font-display font-bold text-sm flex items-center gap-2 text-[var(--text-main)] min-w-0">
            <Globe size={15} className="text-[var(--accent-secondary)] shrink-0" />
            <span className="truncate">Web Preview</span>
          </h2>
          <div className="flex items-center gap-1 shrink-0">
            {html && (
              <>
                <div className="flex bg-[var(--bg-root)] p-[3px] rounded-lg border border-[var(--border-main)]">
                  {([["phone", Smartphone], ["desktop", Monitor]] as const).map(([id, Icon]) => (
                    <button key={id} type="button" onClick={() => setWidth(id)}
                      title={id === "phone" ? "Phone width" : "Desktop width"}
                      className={`px-2 py-1 rounded-md transition ${width === id ? "text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                      style={width === id ? { background: "var(--gradient-hero)" } : undefined}>
                      <Icon size={12} />
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setShowSource((v) => !v)} title="Show the HTML"
                  className={`p-1.5 rounded-lg transition ${showSource ? "text-[var(--accent-primary)] bg-[var(--accent-primary-soft)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}>
                  <Code2 size={13} />
                </button>
              </>
            )}
            <button type="button" onClick={onClose} title="Close" className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-main)]">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto terminal-scrollbar p-4 space-y-3 min-h-0">
          {!html ? (
            <div className="text-xs text-[var(--text-muted)] leading-relaxed border border-dashed border-[var(--border-main)] rounded-lg px-4 py-6 text-center">
              <p className="text-[var(--text-main)] font-medium mb-1">No web page in this sketch yet.</p>
              <p>
                Ask the agent for something that serves one — &ldquo;add a web page to control the LED&rdquo; —
                and the page will render here before you flash anything.
              </p>
            </div>
          ) : showSource ? (
            <pre className="text-[10px] font-mono text-[var(--text-main)] bg-[var(--bg-root)] border border-[var(--border-main)] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
              {html}
            </pre>
          ) : (
            <div className="flex justify-center">
              {/* No allow-same-origin: the sketch's own scripts run, but in an
                  opaque origin where they cannot reach this app, its storage
                  or the user's session. */}
              <iframe
                title="Web preview"
                srcDoc={html}
                sandbox="allow-scripts allow-forms"
                className="bg-white rounded-lg border border-[var(--border-main)] w-full"
                style={{ maxWidth: width === "phone" ? 390 : "100%", height: 460 }}
              />
            </div>
          )}

          {detected.length > 0 && (
            <div className="space-y-1.5 border-t border-[var(--border-main)] pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                Board is live — open the real page
              </p>
              {detected.map((a) => (
                <button key={a} type="button" onClick={() => open(a)}
                  className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 rounded-md border border-[var(--border-main)] hover:bg-[var(--bg-hover)] transition">
                  <Wifi size={11} className="text-[var(--accent-secondary)] shrink-0" />
                  <span className="text-[11px] font-mono text-[var(--text-main)] truncate flex-1">{a}</span>
                  <ExternalLink size={10} className="text-[var(--text-subtle)] shrink-0" />
                </button>
              ))}
            </div>
          )}

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed flex items-start gap-1.5">
            <Info size={11} className="mt-0.5 shrink-0" />
            <span>
              This renders the HTML found in your sketch. Anything the page fetches from the board at
              runtime won&rsquo;t respond until it is flashed and on your network.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
