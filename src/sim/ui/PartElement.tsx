/**
 * One part's drawing on the canvas: the @wokwi/elements element, placed and
 * turned, with its settings applied. Reports its size and pins once drawn,
 * so wires can be laid to them.
 */
import React, { useEffect, useLayoutEffect, useRef } from "react";
import type { DiagramPart } from "../diagram";
import { applyAttrs, bindInputs } from "../view";

export interface PinInfo {
  name: string;
  x: number;
  y: number;
}

export interface Geometry {
  w: number;
  h: number;
  pins: PinInfo[];
}

interface Props {
  part: DiagramPart;
  /** Running: the drawing takes presses and turns; not running: it's picked up and moved. */
  live: boolean;
  selected: boolean;
  onGeometry: (id: string, geo: Geometry) => void;
  onElement: (id: string, el: HTMLElement | null) => void;
  onInput: (id: string, name: string, value: unknown) => void;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}

/** A part this workspace has no drawing for (from a pasted Wokwi diagram): a labelled box. */
function unsupported(type: string): HTMLElement {
  const box = document.createElement("div");
  box.textContent = `${type.replace(/^wokwi-/, "")} (not supported yet)`;
  box.style.cssText = "padding:6px 8px;border:1px dashed var(--border-light);border-radius:6px;font:11px var(--font-mono);color:var(--text-muted);background:var(--bg-panel);white-space:nowrap";
  return box;
}

function measure(el: any): Geometry {
  const pins: PinInfo[] = (el.pinInfo ?? []).map((p: any) => ({ name: String(p.name), x: Number(p.x), y: Number(p.y) }));
  return { w: el.offsetWidth, h: el.offsetHeight, pins };
}

export default function PartElement({ part, live, selected, onGeometry, onElement, onInput, onPointerDown }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const elRef = useRef<any>(null);
  const handlers = useRef({ onGeometry, onElement, onInput });
  handlers.current = { onGeometry, onElement, onInput };

  // The element itself, made once per part (and again when its type changes).
  useLayoutEffect(() => {
    const known = !!customElements.get(part.type);
    const el = (known ? document.createElement(part.type) : unsupported(part.type)) as any;
    el.style.display = "block";
    applyAttrs(el, part.attrs ?? {});
    host.current!.appendChild(el);
    elRef.current = el;
    handlers.current.onElement(part.id, el);
    let gone = false;
    const report = () => { if (!gone) handlers.current.onGeometry(part.id, measure(el)); };
    const ready: Promise<unknown> = el.updateComplete ?? Promise.resolve();
    void ready.then(report);
    el.addEventListener("pininfo-change", () => void (el.updateComplete ?? Promise.resolve()).then(report));
    const unbind = bindInputs(part.type, el, (name, value) => handlers.current.onInput(part.id, name, value));
    return () => {
      gone = true;
      unbind();
      handlers.current.onElement(part.id, null);
      el.remove();
      elRef.current = null;
    };
  }, [part.id, part.type]);

  // Settings changed: onto the drawing, and measure again (pins can move).
  const attrsKey = JSON.stringify(part.attrs ?? {});
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    applyAttrs(el, part.attrs ?? {});
    void (el.updateComplete ?? Promise.resolve()).then(() => handlers.current.onGeometry(part.id, measure(el)));
  }, [attrsKey, part.id]);

  return (
    <div
      className="absolute"
      data-part={part.id}
      style={{ left: part.left, top: part.top, transform: part.rotate ? `rotate(${part.rotate}deg)` : undefined, transformOrigin: "center" }}
      // Running: a tap still picks the part (for a sensor's controls), and the drawing gets it too.
      onPointerDownCapture={live ? (e) => onPointerDown(e, part.id) : undefined}
    >
      <div ref={host} style={{ pointerEvents: live ? "auto" : "none" }} />
      {/* Not running: a cover over the drawing, to pick it up and move it. */}
      <div
        className={`absolute inset-0 rounded-sm ${live ? "pointer-events-none" : "cursor-grab active:cursor-grabbing"}`}
        style={{ outline: selected ? "1.5px dashed var(--accent-primary)" : undefined, outlineOffset: 3 }}
        onPointerDown={live ? undefined : (e) => onPointerDown(e, part.id)}
      />
    </div>
  );
}
