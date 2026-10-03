/**
 * The circuit of a project, in schematic.view: edited here, and simulated
 * here with Play.
 *
 * Stopped, the circuit is edited: parts are added from the library, moved,
 * turned and set up; wires are drawn pin to pin, with bends where the
 * canvas is tapped on the way. Every finished change goes to the project
 * (onChange), where it is saved. Play builds the project's main.cpp for its
 * board and runs it on this circuit: parts light, move, sound and show,
 * buttons, knobs and sensors can be worked by hand, and what the program
 * prints goes to the Serial Monitor.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Pause, Square, RotateCcw, Plus, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Download, Upload, Volume2, VolumeX,
  Loader2, ChevronDown, ClipboardPaste, AlertTriangle, X, Activity,
} from "lucide-react";
import { PART_MODELS } from "../parts";
import { boardOf, isBoardType, parseDiagram, splitPin, type Diagram, type DiagramConnection, type DiagramPart } from "../diagram";
import { own, type BoardId } from "../boards";
import { nextId, specFor, type PartSpec } from "../catalog";
import { bridgedPath, pathOf, routeFrom, wirePoints, type Point } from "../wires";
import { simSession, useSimSession, type SessionHooks, type Starter } from "../session";
import { colourFor, withBoard } from "../project";
import PartElement, { type Geometry } from "./PartElement";
import PartsLibrary from "./PartsLibrary";
import SidePanel from "./SidePanel";

type Selection = { kind: "part"; id: string } | { kind: "wire"; index: number } | null;

const HISTORY_MAX = 100;

export interface CircuitWorkspaceProps {
  /** The project's circuit. A different one from outside (the agent, another project) starts the editor afresh. */
  diagram: Diagram;
  /** Every finished change: a part placed, moved, set up; a wire drawn or removed. */
  onChange: (next: Diagram) => void;
  /** The project's board: a circuit opened from a file is moved onto it. */
  board: BoardId;
  /** Builds main.cpp and starts it on the circuit. */
  start: Starter;
  hooks: SessionHooks;
  /** Why Play can't run (a board the simulator hasn't), or null. */
  playBlocked?: string | null;
  /** Bumped to press Play from elsewhere (the agent's Simulate). */
  playRequest?: number;
  /** Shown beside the board when nothing is selected, e.g. its project. */
  title?: string;
}

/** A point turned about the middle of a w×h box (CSS rotate, y down). */
function turn(x: number, y: number, w: number, h: number, deg: number): Point {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  switch (((deg % 360) + 360) % 360) {
    case 90: return { x: cx - dy, y: cy + dx };
    case 180: return { x: cx - dx, y: cy - dy };
    case 270: return { x: cx + dy, y: cy - dx };
    default: return { x, y };
  }
}

// The last Play pressed from elsewhere that has been acted on: the view can
// be drawn again (another pane on a phone) without pressing it twice.
let handledPlayRequest = 0;

export default function CircuitWorkspace({ diagram: outside, onChange, board, start, hooks, playBlocked, playRequest = 0, title }: CircuitWorkspaceProps) {
  const sim = useSimSession();
  const running = sim.state === "running" || sim.state === "paused";

  const [diagram, setDiagram] = useState<Diagram>(outside);
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  // What the project last had: an edit of ours comes back as the same object.
  const known = useRef<Diagram>(outside);
  const past = useRef<Diagram[]>([]);
  const future = useRef<Diagram[]>([]);
  const [, setHistoryTick] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 0.9 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [menu, setMenu] = useState<null | "file">(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Geometry of each drawn part (size and pins), for wires.
  const geo = useRef(new Map<string, Geometry>());
  const [geoTick, setGeoTick] = useState(0);
  const elements = useRef(new Map<string, HTMLElement>());
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ from: string; bends: Point[]; cursor: Point } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pruneAfterMeasure = useRef(new Set<string>());
  const fitPending = useRef(true);
  const root = useRef<HTMLDivElement>(null);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  // ---- The project's circuit, in and out ----

  /** A change made here: kept for undo, shown, and handed to the project. */
  const commit = useCallback((next: Diagram, before: Diagram = diagramRef.current) => {
    past.current.push(before);
    if (past.current.length > HISTORY_MAX) past.current.shift();
    future.current = [];
    diagramRef.current = next;
    known.current = next;
    setDiagram(next);
    setHistoryTick((t) => t + 1);
    onChangeRef.current(next);
  }, []);

  /** A change of drawing only (a part's pins measured): handed on, not an undo step. */
  const settle = useCallback((next: Diagram) => {
    diagramRef.current = next;
    known.current = next;
    setDiagram(next);
    onChangeRef.current(next);
  }, []);

  // A different circuit from outside: the agent built one, or another project opened.
  useEffect(() => {
    if (outside === known.current) return;
    known.current = outside;
    if (simSession.running || simSession.state === "compiling") simSession.stop();
    past.current = [];
    future.current = [];
    diagramRef.current = outside;
    setDiagram(outside);
    setSelection(null);
    setDraft(null);
    setHistoryTick((t) => t + 1);
    fitPending.current = true;
  }, [outside]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(diagramRef.current);
    diagramRef.current = prev;
    known.current = prev;
    setDiagram(prev);
    setSelection(null);
    setHistoryTick((t) => t + 1);
    onChangeRef.current(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(diagramRef.current);
    diagramRef.current = next;
    known.current = next;
    setDiagram(next);
    setSelection(null);
    setHistoryTick((t) => t + 1);
    onChangeRef.current(next);
  }, []);

  // ---- Geometry ----

  const onGeometry = useCallback((id: string, g: Geometry) => {
    const old = geo.current.get(id);
    if (old && old.w === g.w && old.h === g.h && JSON.stringify(old.pins) === JSON.stringify(g.pins)) return;
    geo.current.set(id, g);
    setGeoTick((t) => t + 1);
    // A setting that changes the pins: wires to pins that are gone go too.
    if (pruneAfterMeasure.current.has(id)) {
      pruneAfterMeasure.current.delete(id);
      const names = new Set(g.pins.map((p) => p.name));
      const d = diagramRef.current;
      const kept = d.connections.filter((c) => [c[0], c[1]].every((ref) => { const s = splitPin(ref); return !s || s[0] !== id || names.has(s[1]); }));
      if (kept.length !== d.connections.length) settle({ ...d, connections: kept });
    }
  }, [settle]);

  const onElement = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      elements.current.set(id, el);
      simSession.redraw(id);
    } else {
      elements.current.delete(id);
    }
  }, []);

  // The running simulation draws onto this circuit while it is on screen.
  useEffect(() => {
    const els = elements.current;
    simSession.attach(els);
    return () => simSession.detach(els);
  }, []);

  const partById = useMemo(() => new Map(diagram.parts.map((p) => [p.id, p])), [diagram]);

  /** Where a pin is on the canvas, and which way a wire leaves it. */
  const pinAt = useCallback((ref: string): { pt: Point; axis: "h" | "v" } | null => {
    const s = splitPin(ref);
    if (!s) return null;
    const part = partById.get(s[0]);
    const g = geo.current.get(s[0]);
    if (!part || !g) return null;
    const pin = g.pins.find((p) => p.name === s[1]);
    if (!pin) return null;
    const local = turn(pin.x, pin.y, g.w, g.h, part.rotate ?? 0);
    const edgeIsTopBottom = Math.min(pin.y, g.h - pin.y) <= Math.min(pin.x, g.w - pin.x);
    const quarter = ((part.rotate ?? 0) / 90) % 2 === 1;
    const axis: "h" | "v" = edgeIsTopBottom !== quarter ? "v" : "h";
    return { pt: { x: part.left + local.x, y: part.top + local.y }, axis };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partById, geoTick]);

  const wires = useMemo(() => diagram.connections.map((c) => {
    const a = pinAt(c[0]);
    const b = pinAt(c[1]);
    return a && b ? wirePoints(a.pt, b.pt, c[3] ?? [], a.axis) : null;
  }), [diagram.connections, pinAt]);
  // Each wire drawn with bridges over the wires it crosses.
  const wirePaths = useMemo(() => wires.map((pts, i) => (pts ? bridgedPath(pts, wires.filter((o, j): o is Point[] => j !== i && !!o)) : "")), [wires]);

  // ---- Canvas: pan, zoom, drag ----

  const viewport = useRef<HTMLDivElement>(null);
  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const r = viewport.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const r = viewport.current?.getBoundingClientRect();
    if (!r) return;
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    setView((v) => {
      const zoom = Math.min(4, Math.max(0.2, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: cx - r.left - (cx - r.left - v.x) * k, y: cy - r.top - (cy - r.top - v.y) * k };
    });
  }, []);

  const fit = useCallback(() => {
    const r = viewport.current?.getBoundingClientRect();
    if (!r || r.width < 50 || r.height < 50) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const part of diagramRef.current.parts) {
      const g = geo.current.get(part.id);
      const w = g?.w ?? 60;
      const h = g?.h ?? 40;
      const quarter = ((part.rotate ?? 0) / 90) % 2 === 1;
      const bw = quarter ? h : w;
      const bh = quarter ? w : h;
      const x = part.left + w / 2 - bw / 2;
      const y = part.top + h / 2 - bh / 2;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + bw); maxY = Math.max(maxY, y + bh);
    }
    if (!Number.isFinite(minX)) return false;
    const pad = 40;
    const zoom = Math.min(2, Math.max(0.2, Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY))));
    setView({ zoom, x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (r.height - (maxY - minY) * zoom) / 2 - minY * zoom });
    return true;
  }, []);

  // Fit once the parts are drawn, and again for a new circuit. Out of sight
  // (another tab, size 0) it waits until it has a size.
  useEffect(() => {
    if (!fitPending.current) return;
    const drawn = diagram.parts.every((p) => geo.current.has(p.id));
    if (drawn && fit()) fitPending.current = false;
  }, [geoTick, diagram.parts, fit]);
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fitPending.current && diagramRef.current.parts.every((p) => geo.current.has(p.id)) && fit()) fitPending.current = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  type Drag =
    | { kind: "pan"; x: number; y: number; vx: number; vy: number; moved: boolean }
    | { kind: "part"; id: string; x: number; y: number; left: number; top: number; moved: boolean; before: Diagram };
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const finishDraft = useCallback((to: string) => {
    const dr = draftRef.current;
    if (!dr) return;
    setDraft(null);
    if (to === dr.from) return;
    const d = diagramRef.current;
    if (d.connections.some((c) => (c[0] === dr.from && c[1] === to) || (c[0] === to && c[1] === dr.from))) return;
    const start = pinAt(dr.from);
    const route = start ? routeFrom(start.pt, dr.bends) : [];
    const signals = d.connections.filter((c) => c[2] !== "black" && c[2] !== "red").length;
    commit({ ...d, connections: [...d.connections, [dr.from, to, colourFor(dr.from, to, signals), route]] });
    setSelection({ kind: "wire", index: d.connections.length });
  }, [commit, pinAt]);

  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) { setDraft(null); return; }
    // Running, a press on a part is the part's (a button, a knob), not a pan.
    if (e.target instanceof Element && e.target.closest("[data-part]")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.current?.focus({ preventScroll: true });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: viewRef.current.zoom };
      drag.current = null;
      return;
    }
    const v = viewRef.current;
    drag.current = { kind: "pan", x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false };
  };

  const onPartPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (simSession.running) {
      setSelection({ kind: "part", id });
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    viewport.current?.focus({ preventScroll: true });
    if (draftRef.current) {
      // Drawing a wire: a tap on a part is a bend, as on the empty canvas.
      const pt = toWorld(e.clientX, e.clientY);
      setDraft((dr) => (dr ? { ...dr, bends: [...dr.bends, { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 }] } : dr));
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setSelection({ kind: "part", id });
    const part = diagramRef.current.parts.find((p) => p.id === id);
    if (!part) return;
    drag.current = { kind: "part", id, x: e.clientX, y: e.clientY, left: part.left, top: part.top, moved: false, before: diagramRef.current };
  }, [toWorld]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const target = Math.min(4, Math.max(0.2, (pinch.current.zoom * dist) / Math.max(1, pinch.current.dist)));
        zoomAt(target / viewRef.current.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (draftRef.current && viewport.current) {
        const cursor = toWorld(e.clientX, e.clientY);
        setDraft((dr) => (dr ? { ...dr, cursor } : dr));
      }
      const dg = drag.current;
      if (!dg) return;
      const dx = e.clientX - dg.x;
      const dy = e.clientY - dg.y;
      if (!dg.moved && Math.hypot(dx, dy) < 4) return;
      dg.moved = true;
      if (dg.kind === "pan") {
        setView((v) => ({ ...v, x: dg.vx + dx, y: dg.vy + dy }));
      } else {
        const z = viewRef.current.zoom;
        const left = Math.round((dg.left + dx / z) * 10) / 10;
        const top = Math.round((dg.top + dy / z) * 10) / 10;
        const d = diagramRef.current;
        const next = { ...d, parts: d.parts.map((p) => (p.id === dg.id ? { ...p, left, top } : p)) };
        diagramRef.current = next;
        setDiagram(next);
      }
    };
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      const dg = drag.current;
      drag.current = null;
      if (!dg) return;
      if (dg.kind === "part") {
        if (dg.moved) commit(diagramRef.current, dg.before);
        return;
      }
      if (!dg.moved && viewport.current && e.target instanceof Node && viewport.current.contains(e.target)) {
        // A tap on the empty canvas: a bend in the wire being drawn, or nothing selected.
        if (draftRef.current) {
          const pt = toWorld(e.clientX, e.clientY);
          setDraft((dr) => (dr ? { ...dr, bends: [...dr.bends, { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 }] } : dr));
        } else {
          setSelection(null);
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [commit, toWorld, zoomAt]);

  const onPinDown = (e: React.PointerEvent, ref: string) => {
    e.stopPropagation();
    viewport.current?.focus({ preventScroll: true });
    if (running) return;
    if (draftRef.current) { finishDraft(ref); return; }
    const at = pinAt(ref);
    if (!at) return;
    setSelection(null);
    setDraft({ from: ref, bends: [], cursor: at.pt });
  };

  const onWireDown = (e: React.PointerEvent, index: number) => {
    if (running || draftRef.current) return;
    e.stopPropagation();
    viewport.current?.focus({ preventScroll: true });
    setSelection({ kind: "wire", index });
  };

  // ---- Changing parts ----

  const addPart = useCallback((spec: PartSpec) => {
    setLibraryOpen(false);
    const d = diagramRef.current;
    const id = nextId(spec.prefix, d.parts.map((p) => p.id));
    const r = viewport.current?.getBoundingClientRect();
    const v = viewRef.current;
    const centre = r ? { x: (r.width / 2 - v.x) / v.zoom, y: (r.height / 2 - v.y) / v.zoom } : { x: 100, y: 100 };
    const part: DiagramPart = { id, type: spec.type, left: Math.round(centre.x - 30), top: Math.round(centre.y - 30), rotate: 0, attrs: { ...(spec.attrs ?? {}) } };
    commit({ ...d, parts: [...d.parts, part] });
    setSelection({ kind: "part", id });
  }, [commit]);

  const setAttr = useCallback((id: string, key: string, value: string) => {
    const d = diagramRef.current;
    const part = d.parts.find((p) => p.id === id);
    if (!part) return;
    const spec = specFor(part.type, part.attrs);
    const prop = spec?.props?.find((x) => x.key === key);
    if (prop?.pins) pruneAfterMeasure.current.add(id);
    commit({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, attrs: { ...(p.attrs ?? {}), [key]: value } } : p)) });
  }, [commit]);

  const rotateSelected = useCallback(() => {
    if (selection?.kind !== "part") return;
    const d = diagramRef.current;
    commit({ ...d, parts: d.parts.map((p) => (p.id === selection.id ? { ...p, rotate: ((p.rotate ?? 0) + 90) % 360 } : p)) });
  }, [selection, commit]);

  const deleteSelected = useCallback(() => {
    const d = diagramRef.current;
    if (selection?.kind === "wire") {
      commit({ ...d, connections: d.connections.filter((_, i) => i !== selection.index) });
      setSelection(null);
    } else if (selection?.kind === "part") {
      if (boardOf(d)?.part.id === selection.id) { flash("The board is the project's own board, so it stays."); return; }
      commit({
        ...d,
        parts: d.parts.filter((p) => p.id !== selection.id),
        connections: d.connections.filter((c) => splitPin(c[0])?.[0] !== selection.id && splitPin(c[1])?.[0] !== selection.id),
      });
      setSelection(null);
    }
  }, [selection, commit, flash]);

  const duplicateSelected = useCallback(() => {
    if (selection?.kind !== "part") return;
    const d = diagramRef.current;
    const part = d.parts.find((p) => p.id === selection.id);
    if (!part || boardOf(d)?.part.id === part.id) return;
    const spec = specFor(part.type, part.attrs);
    const id = nextId(spec?.prefix ?? part.type.replace(/^wokwi-/, ""), d.parts.map((p) => p.id));
    commit({ ...d, parts: [...d.parts, { ...part, id, left: part.left + 24, top: part.top + 24, attrs: { ...(part.attrs ?? {}) } }] });
    setSelection({ kind: "part", id });
  }, [selection, commit]);

  const setWireColour = useCallback((colour: string) => {
    if (selection?.kind !== "wire") return;
    const d = diagramRef.current;
    commit({ ...d, connections: d.connections.map((c, i) => (i === selection.index ? [c[0], c[1], colour, c[3] ?? []] as DiagramConnection : c)) });
  }, [selection, commit]);

  // ---- Running ----

  const blockedRef = useRef(playBlocked);
  blockedRef.current = playBlocked;
  const play = useCallback(() => {
    if (blockedRef.current) { flash(blockedRef.current); return; }
    setDraft(null);
    void simSession.play(diagramRef.current, start, hooks);
  }, [start, hooks, flash]);

  // Play pressed elsewhere (the agent's Simulate): once per press.
  useEffect(() => {
    if (playRequest <= handledPlayRequest) return;
    handledPlayRequest = playRequest;
    if (simSession.running) simSession.stop();
    play();
  }, [playRequest, play]);

  const onPartInput = useCallback((id: string, name: string, value: unknown) => simSession.input(id, name, value), []);

  const onLive = useCallback((input: string, value: number | boolean) => {
    if (selection?.kind !== "part") return;
    simSession.live(selection.id, input, value);
  }, [selection]);

  // ---- Keyboard: only while the circuit has the focus ----

  const pressedKeys = useRef(new Set<string>());
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const inside = () => !!root.current && root.current.contains(document.activeElement);
    const buttonsFor = (key: string) => diagramRef.current.parts.filter((p) => (p.type === "wokwi-pushbutton" || p.type === "wokwi-pushbutton-6mm") && p.attrs?.key && p.attrs.key.toLowerCase() === key.toLowerCase());
    const down = (e: KeyboardEvent) => {
      if (!inside()) return;
      if (e.key === "Escape") setMenu(null);
      if (typing(e.target)) return;
      if (simSession.running) {
        const buttons = buttonsFor(e.key);
        if (buttons.length) {
          e.preventDefault();
          if (pressedKeys.current.has(e.key)) return;
          pressedKeys.current.add(e.key);
          for (const b of buttons) simSession.input(b.id, "press", true);
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      else if ((e.key === "r" || e.key === "R") && !mod) rotateSelected();
      else if (e.key === "Escape") { setDraft(null); setSelection(null); }
    };
    const up = (e: KeyboardEvent) => {
      if (!pressedKeys.current.delete(e.key)) return;
      for (const b of buttonsFor(e.key)) simSession.input(b.id, "press", false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [undo, redo, deleteSelected, rotateSelected, duplicateSelected]);

  // ---- Files ----

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagramRef.current, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** A Wokwi diagram.json opened or pasted: on the project's board, replacing this circuit (undo brings it back). */
  const importText = (text: string) => {
    try {
      const parsed = parseDiagram(text);
      const { diagram: onBoard, dropped } = withBoard(parsed, board);
      if (simSession.running || simSession.state === "compiling") simSession.stop();
      commit(onBoard);
      setSelection(null);
      fitPending.current = true;
      setGeoTick((t) => t + 1);
      const other = boardOf(parsed) && boardOf(parsed)!.board.id !== board;
      flash(dropped
        ? `Circuit loaded onto this project's board. ${dropped} wire${dropped > 1 ? "s" : ""} went to pins it doesn't have and ${dropped > 1 ? "were" : "was"} left out.`
        : other ? "Circuit loaded, moved onto this project's board." : "Circuit loaded.");
      return true;
    } catch (err: any) {
      flash(err?.message || "That isn't a diagram.");
      return false;
    }
  };

  const fileInput = useRef<HTMLInputElement>(null);

  // ---- Drawing ----

  const selectedPart = selection?.kind === "part" ? partById.get(selection.id) ?? null : null;
  const selectedWire = selection?.kind === "wire" ? diagram.connections[selection.index] ?? null : null;
  const unsupported = diagram.parts.filter((p) => !own(PART_MODELS, p.type) && !isBoardType(p.type) && p.type !== "wokwi-resistor");
  const draftPoints = draft ? (() => {
    const a = pinAt(draft.from);
    if (!a) return null;
    return wirePoints(a.pt, draft.cursor, routeFrom(a.pt, draft.bends), a.axis);
  })() : null;
  const hoverAt = hoverPin ? pinAt(hoverPin) : null;

  const pins: { ref: string; pt: Point }[] = [];
  if (!running) {
    for (const part of diagram.parts) {
      const g = geo.current.get(part.id);
      if (!g) continue;
      for (const pin of g.pins) {
        const local = turn(pin.x, pin.y, g.w, g.h, part.rotate ?? 0);
        pins.push({ ref: `${part.id}:${pin.name}`, pt: { x: part.left + local.x, y: part.top + local.y } });
      }
    }
  }

  const btn = "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-[var(--text-main)] transition hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent";
  const iconBtn = "rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)] disabled:opacity-40 disabled:hover:bg-transparent";
  const seconds = sim.ms / 1000;
  const compiling = sim.state === "compiling";

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-root)]"
      onPointerDown={(e) => { if (menu && !(e.target instanceof Element && e.target.closest("[data-menu]"))) setMenu(null); }}
    >
      <div className="relative z-30 flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-main)] bg-[var(--bg-panel)] px-2 py-1.5">
        {sim.state === "running" ? (
          <button type="button" onClick={() => simSession.pause()} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--bg-hover)]" title="Pause" aria-label="Pause">
            <Pause size={14} /> <span className="hidden sm:inline">Pause</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={play}
            disabled={compiling}
            data-tour="simulate"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-70"
            style={{ background: "var(--gradient-accent)" }}
            title={playBlocked ?? (sim.state === "paused" ? "Resume" : "Simulate: build main.cpp and run it on this circuit")}
            aria-label={sim.state === "paused" ? "Resume" : "Simulate"}
          >
            {compiling ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            <span className="hidden sm:inline">{compiling ? "Building…" : sim.state === "paused" ? "Resume" : "Simulate"}</span>
          </button>
        )}
        <button type="button" onClick={() => void simSession.restart()} disabled={!running} className={iconBtn} title="Restart" aria-label="Restart"><RotateCcw size={15} /></button>
        <button type="button" onClick={() => simSession.stop()} disabled={sim.state === "stopped"} className={iconBtn} title="Stop" aria-label="Stop"><Square size={15} /></button>

        {running && (
          <span className="ml-1 flex items-center gap-2 font-mono text-[11px] text-[var(--text-muted)]" aria-live="off">
            <span>{seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`}</span>
            <span className={sim.speed < 0.9 ? "text-[var(--term-serial)]" : "text-[var(--term-success)]"} title="Simulated time against real time">{Math.round(sim.speed * 100)}%</span>
          </span>
        )}

        <div className="mx-1 h-5 w-px bg-[var(--border-main)]" />
        <button type="button" onClick={() => setLibraryOpen(true)} disabled={running} className={btn} title="Add a part" aria-label="Add a part"><Plus size={14} /> <span className="hidden sm:inline">Add part</span></button>
        <button type="button" onClick={undo} disabled={running || !past.current.length} className={iconBtn} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
        <button type="button" onClick={redo} disabled={running || !future.current.length} className={iconBtn} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={15} /></button>

        <div className="relative" data-menu>
          <button type="button" onClick={() => setMenu(menu === "file" ? null : "file")} className={btn} aria-expanded={menu === "file"} aria-label="File" title="File"><Download size={14} /> <span className="hidden sm:inline">File</span> <ChevronDown size={12} /></button>
          {menu === "file" && (
            <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] p-1 shadow-xl" role="menu">
              {[
                { icon: <Download size={13} />, label: "Download diagram.json", act: download, whileRunning: true },
                { icon: <Upload size={13} />, label: "Open a diagram.json…", act: () => fileInput.current?.click(), whileRunning: false },
                { icon: <ClipboardPaste size={13} />, label: "Paste a Wokwi diagram.json", act: () => setPasteOpen(true), whileRunning: false },
              ].map((item) => (
                <button key={item.label} type="button" role="menuitem" disabled={running && !item.whileRunning} onClick={() => { setMenu(null); item.act(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-40">
                  {item.icon} {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 2_000_000) { flash("That file is too big."); return; }
            importText(await f.text());
          }}
        />
        <div className="ml-auto flex items-center gap-0.5">
          {title && <span className="mr-1 hidden max-w-[12rem] truncate text-[11px] text-[var(--text-subtle)] lg:inline">{title}</span>}
          <button type="button" onClick={() => simSession.setMuted(!sim.muted)} className={iconBtn} title={sim.muted ? "Sound off" : "Sound on"} aria-label={sim.muted ? "Turn sound on" : "Turn sound off"}>{sim.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: "var(--bg-schematic)" }}>
        <div
          ref={viewport}
          tabIndex={0}
          className="absolute inset-0 outline-none"
          style={{
            touchAction: "none",
            cursor: draft ? "crosshair" : "default",
            backgroundImage: "radial-gradient(circle, var(--border-main) 1px, transparent 1.2px)",
            backgroundSize: `${19.2 * view.zoom}px ${19.2 * view.zoom}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onViewportPointerDown}
          onContextMenu={(e) => { e.preventDefault(); setDraft(null); }}
          aria-label="Circuit"
        >
          <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}>
            {diagram.parts.map((part) => (
              <PartElement
                key={`${part.id}:${part.type}:${sim.epoch}`}
                part={part}
                live={running}
                selected={selection?.kind === "part" && selection.id === part.id}
                onGeometry={onGeometry}
                onElement={onElement}
                onInput={onPartInput}
                onPointerDown={onPartPointerDown}
              />
            ))}
            <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1" style={{ pointerEvents: "none" }}>
              {wires.map((pts, i) => pts && (
                <g key={i}>
                  {selection?.kind === "wire" && selection.index === i && <path d={wirePaths[i]} stroke="var(--accent-primary)" strokeOpacity={0.45} strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                  <path d={wirePaths[i]} stroke={diagram.connections[i][2] || "green"} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
                  {!running && (
                    <path data-wire={i} d={pathOf(pts)} stroke="transparent" strokeWidth={10} fill="none" style={{ pointerEvents: "stroke", cursor: "pointer" }} onPointerDown={(e) => onWireDown(e, i)} />
                  )}
                </g>
              ))}
              {draftPoints && <path d={pathOf(draftPoints)} stroke="var(--accent-primary)" strokeWidth={2.4} strokeDasharray="5 4" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
              {pins.map(({ ref, pt }) => {
                const on = hoverPin === ref || draft?.from === ref;
                return (
                  <g key={ref}>
                    {on && <circle cx={pt.x} cy={pt.y} r={3.4} fill="var(--accent-primary)" stroke="white" strokeWidth={1} style={{ pointerEvents: "none" }} />}
                    <circle
                      data-pin={ref}
                      cx={pt.x}
                      cy={pt.y}
                      r={4.6}
                      fill="transparent"
                      style={{ pointerEvents: "all", cursor: "crosshair" }}
                      onPointerEnter={() => setHoverPin(ref)}
                      onPointerLeave={() => setHoverPin((h) => (h === ref ? null : h))}
                      onPointerDown={(e) => onPinDown(e, ref)}
                    />
                  </g>
                );
              })}
              {hoverAt && hoverPin && (
                <g transform={`translate(${hoverAt.pt.x}, ${hoverAt.pt.y - 10})`} style={{ pointerEvents: "none" }}>
                  <rect x={-(hoverPin.length * 3.3 + 6)} y={-14} width={hoverPin.length * 6.6 + 12} height={16} rx={4} fill="var(--bg-panel)" stroke="var(--border-light)" strokeWidth={0.8} />
                  <text x={0} y={-3} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill="var(--text-main)">{hoverPin}</text>
                </g>
              )}
            </svg>
          </div>
        </div>

        {/* Zoom */}
        <div className="absolute bottom-2 left-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)]/90 p-0.5 shadow backdrop-blur">
          <button type="button" onClick={() => zoomAt(1 / 1.2)} className={iconBtn} title="Zoom out" aria-label="Zoom out"><ZoomOut size={14} /></button>
          <span className="w-10 text-center font-mono text-[10px] text-[var(--text-muted)]">{Math.round(view.zoom * 100)}%</span>
          <button type="button" onClick={() => zoomAt(1.2)} className={iconBtn} title="Zoom in" aria-label="Zoom in"><ZoomIn size={14} /></button>
          <button type="button" onClick={() => fit()} className={iconBtn} title="Fit the circuit" aria-label="Fit the circuit"><Maximize size={14} /></button>
        </div>

        {/* What's going on */}
        {(draft || notice || (sim.shorted && running) || sim.error || (unsupported.length > 0 && !running) || (playBlocked && !running)) && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex w-max max-w-[92%] -translate-x-1/2 flex-col items-center gap-1 text-center">
            {draft && <div className="rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-main)] shadow">Tap another pin to connect · tap the canvas to bend · Esc to cancel</div>}
            {notice && <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-main)] shadow">{notice}</div>}
            {sim.error && <div className="flex items-center gap-1.5 rounded-2xl border border-[var(--term-error)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--term-error)] shadow"><AlertTriangle size={12} className="shrink-0" /> {sim.error}</div>}
            {sim.shorted && running && <div className="flex items-center gap-1.5 rounded-2xl border border-[var(--term-error)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--term-error)] shadow"><AlertTriangle size={12} className="shrink-0" /> Short circuit: two outputs (or power and ground) are wired together.</div>}
            {playBlocked && !running && !notice && <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-muted)] shadow">{playBlocked}</div>}
            {unsupported.length > 0 && !running && <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-muted)] shadow">{unsupported.length} part{unsupported.length > 1 ? "s" : ""} in this circuit {unsupported.length > 1 ? "aren't" : "isn't"} simulated yet and won't do anything.</div>}
          </div>
        )}
        {running && !selectedPart && !selectedWire && (
          <div className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-center gap-1.5 rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)]/90 px-2.5 py-1 text-[10px] text-[var(--text-muted)] shadow">
            <Activity size={11} className="text-[var(--term-success)]" /> Output in the Serial Monitor
          </div>
        )}
        {(selectedPart || selectedWire) && (
          <div className="absolute right-2 top-2 z-30 w-[calc(100%-1rem)] sm:w-auto">
            <SidePanel
              part={selectedPart}
              wire={selectedWire}
              running={running}
              isBoard={!!selectedPart && boardOf(diagram)?.part.id === selectedPart.id}
              liveValues={(selectedPart && sim.live[selectedPart.id]) || {}}
              onLive={onLive}
              onAttr={(k, v) => selectedPart && setAttr(selectedPart.id, k, v)}
              onRotate={rotateSelected}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
              onWireColour={setWireColour}
              onClose={() => setSelection(null)}
            />
          </div>
        )}
        {libraryOpen && <PartsLibrary onAdd={addPart} onClose={() => setLibraryOpen(false)} />}
      </div>

      {pasteOpen && (
        <PasteDialog
          onClose={() => setPasteOpen(false)}
          onLoad={(text) => { if (importText(text)) setPasteOpen(false); }}
        />
      )}
    </div>
  );
}

function PasteDialog({ onClose, onLoad }: { onClose: () => void; onLoad: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] shadow-2xl" role="dialog" aria-label="Paste a diagram">
        <div className="flex items-center justify-between border-b border-[var(--border-main)] px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-[var(--text-main)]">Paste a Wokwi diagram.json</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]" aria-label="Close"><X size={14} /></button>
        </div>
        <div className="space-y-3 p-4">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder='{ "version": 1, "parts": [ … ], "connections": [ … ] }'
            className="w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] p-2 font-mono text-[11px] text-[var(--text-main)] outline-none focus:border-[var(--accent-primary)]"
          />
          <p className="text-[11px] text-[var(--text-muted)]">It replaces this circuit (Undo brings it back), on this project's board.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">Cancel</button>
            <button type="button" onClick={() => onLoad(text)} disabled={!text.trim()} className="rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">Load circuit</button>
          </div>
        </div>
      </div>
    </div>
  );
}
