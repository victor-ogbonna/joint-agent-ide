import React, { useMemo, useState } from "react";
import { X, Globe, ExternalLink, Wifi, Info } from "lucide-react";

interface WebConsolePanelProps {
  onClose: () => void;
  /** Terminal + serial text, newest last. Scanned for an address the sketch printed. */
  lines: string[];
}

/**
 * Board addresses found in the serial output. An ESP32 web-server sketch
 * almost always prints its IP on boot ("WiFi connected", "IP address:
 * 192.168.1.42"), so the address the user needs is usually already on screen.
 */
function detectAddresses(lines: string[]): string[] {
  const found: string[] = [];
  const push = (v: string) => { if (!found.includes(v)) found.push(v); };
  const urlRe = /\bhttps?:\/\/[^\s"'<>)]+/gi;
  // Dotted quad with every octet in range, so version strings and timings do
  // not masquerade as addresses.
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
  return found.slice(-8).reverse();
}

export default function WebConsolePanel({ onClose, lines }: WebConsolePanelProps) {
  const detected = useMemo(() => detectAddresses(lines), [lines]);
  const [manual, setManual] = useState("");

  const open = (raw: string) => {
    const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] shrink-0">
          <h2 className="font-display font-bold text-sm flex items-center gap-2 text-[var(--text-main)]">
            <Globe size={15} className="text-[var(--accent-secondary)]" /> Web Console
          </h2>
          <button type="button" onClick={onClose} title="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto terminal-scrollbar">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            If your board serves a page — a web server, a dashboard, a captive portal — open it here.
          </p>

          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
              Found in the serial output
            </label>
            {detected.length === 0 ? (
              <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed border border-dashed border-[var(--border-main)] rounded-lg px-3 py-2.5">
                No address seen yet. Open the Serial Monitor and reset the board — a web-server
                sketch prints its IP once WiFi connects, and it will show up here.
              </p>
            ) : (
              <div className="border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)] overflow-hidden">
                {detected.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => open(a)}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-[var(--bg-hover)] transition"
                  >
                    <Wifi size={12} className="text-[var(--accent-secondary)] shrink-0" />
                    <span className="text-xs font-mono text-[var(--text-main)] truncate flex-1">{a}</span>
                    <ExternalLink size={11} className="text-[var(--text-subtle)] shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
              Or type an address
            </label>
            <div className="flex gap-1.5">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) open(manual.trim()); }}
                placeholder="192.168.1.42"
                className="flex-1 min-w-0 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2.5 py-2 text-xs font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
              />
              <button
                type="button"
                onClick={() => manual.trim() && open(manual.trim())}
                disabled={!manual.trim()}
                className="px-3 rounded-lg text-white text-xs font-semibold transition disabled:opacity-50"
                style={{ background: "var(--gradient-accent)" }}
              >
                Open
              </button>
            </div>
          </div>

          {/* Being straight about why this opens a tab instead of embedding. */}
          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed flex items-start gap-1.5 border-t border-[var(--border-main)] pt-3">
            <Info size={11} className="mt-0.5 shrink-0" />
            <span>
              These open in a new tab rather than inside the IDE. This page is served over HTTPS and
              your board serves plain HTTP, which browsers refuse to embed. Your phone or computer
              has to be on the same network as the board.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
