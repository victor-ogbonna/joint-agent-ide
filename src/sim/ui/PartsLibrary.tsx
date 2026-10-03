/**
 * The parts library: search, then a part to add. Each entry shows the
 * part's own drawing, small.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { CATEGORIES, PARTS, type PartSpec } from "../catalog";
import { applyAttrs } from "../view";

function Preview({ spec }: { spec: PartSpec }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = document.createElement(spec.type) as any;
    el.style.display = "block";
    applyAttrs(el, spec.attrs ?? {});
    const holder = box.current!;
    const inner = document.createElement("div");
    inner.style.transformOrigin = "0 0";
    inner.appendChild(el);
    holder.appendChild(inner);
    let gone = false;
    void (el.updateComplete ?? Promise.resolve()).then(() => {
      if (gone) return;
      const s = Math.min(52 / Math.max(1, el.offsetWidth), 40 / Math.max(1, el.offsetHeight), 1.5);
      inner.style.transform = `scale(${s})`;
      inner.style.position = "absolute";
      inner.style.left = `${(56 - el.offsetWidth * s) / 2}px`;
      inner.style.top = `${(44 - el.offsetHeight * s) / 2}px`;
    });
    return () => { gone = true; inner.remove(); };
  }, [spec]);
  return <div ref={box} className="relative w-14 h-11 shrink-0 overflow-hidden pointer-events-none" aria-hidden="true" />;
}

export default function PartsLibrary({ onAdd, onClose }: { onAdd: (spec: PartSpec) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? PARTS.filter((p) => `${p.name} ${p.type} ${p.keywords ?? ""} ${p.category}`.toLowerCase().includes(q)) : PARTS;
  }, [query]);

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/40 p-3 sm:p-6"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      role="dialog"
      aria-label="Add a part"
    >
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--border-main)] px-3 py-2.5">
          <Search size={15} className="text-[var(--text-muted)]" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parts: LED, servo, LCD, sensor…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none"
            onKeyDown={(e) => { if (e.key === "Enter" && found[0]) onAdd(found[0]); }}
          />
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {found.length === 0 && <p className="p-6 text-center text-xs text-[var(--text-muted)]">No part matches “{query}”.</p>}
          {CATEGORIES.map((cat) => {
            const list = found.filter((p) => p.category === cat);
            if (!list.length) return null;
            return (
              <section key={cat} className="mb-2">
                <h3 className="px-2 pb-1 pt-2 font-display text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">{cat}</h3>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {list.map((spec) => (
                    <button
                      key={spec.key}
                      type="button"
                      onClick={() => onAdd(spec)}
                      className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-[var(--border-main)] hover:bg-[var(--bg-hover)]"
                    >
                      <Preview spec={spec} />
                      <span className="text-[12px] font-medium text-[var(--text-main)]">{spec.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
