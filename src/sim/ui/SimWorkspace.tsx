/**
 * The circuit simulator workspace: the sketch, the circuit, and the
 * simulated board running one with the other.
 *
 * Not running, the circuit is edited: parts are added from the library,
 * moved, turned and set up; wires are drawn pin to pin, with bends where
 * the canvas is tapped on the way. Running, the program is compiled once
 * and run on the simulated chip in real time: parts light, move, sound and
 * show, and buttons, knobs and sensors can be worked by hand.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  Play, Pause, Square, RotateCcw, Plus, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Download, Upload, BookOpen, Volume2, VolumeX,
  Loader2, ChevronDown, Code2, CircuitBoard, TerminalSquare, ClipboardPaste, FilePlus2, AlertTriangle, X,
} from "lucide-react";
import { Simulation } from "../circuit";
import { PART_MODELS } from "../parts";
import { boardOf, isBoardType, parseDiagram, splitPin, type Diagram, type DiagramConnection, type DiagramPart } from "../diagram";
import { own, type BoardId } from "../boards";
import { BOARD_PARTS, nextId, specFor, type PartSpec } from "../catalog";
import { EXAMPLES, DEFAULT_EXAMPLE, type Example } from "../examples";
import { pathOf, routeFrom, wirePoints, type Point } from "../wires";
import { applyBoard, applyState } from "../view";
import { BuzzerSound } from "../audio";
import PartElement, { type Geometry } from "./PartElement";
import PartsLibrary from "./PartsLibrary";
import SidePanel from "./SidePanel";
import SerialMonitor, { type BuildProblem } from "./SerialMonitor";

export interface CompileResult {
  hex?: string;
  error?: string;
  output?: string;
  hint?: string;
}

interface Props {
  /** Builds the sketch for a board: the program as Intel HEX, or what went wrong. */
  compile: (code: string, board: BoardId) => Promise<CompileResult>;
}

type RunState = "stopped" | "compiling" | "running" | "paused";
type Selection = { kind: "part"; id: string } | { kind: "wire"; index: number } | null;

const SAVE_KEY = "jointagent_sim_workspace_v1";
const SERIAL_MAX = 60_000;
const HISTORY_MAX = 100;

interface Saved {
  code: string;
  diagram: Diagram;
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data?.code !== "string") return null;
    const diagram = parseDiagram(JSON.stringify(data.diagram));
    return boardOf(diagram) ? { code: data.code, diagram } : null;
  } catch {
    return null;
  }
}

const isPowerPin = (pin: string) => /^(5V|3\.3V|3V3|VCC|VIN|VDD|V\+|IOREF)(\.\d+)?$/i.test(pin);
const isGroundPin = (pin: string) => /^(GND|VSS)(\.\d+)?$/i.test(pin);

/** A wire's colour by what it carries: black to ground, red to power, green otherwise. */
function wireColourFor(a: string, b: string): string {
  const pins = [a, b].map((r) => splitPin(r)?.[1] ?? "");
  if (pins.some(isGroundPin)) return "black";
  if (pins.some(isPowerPin)) return "red";
  return "green";
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

/** The pins of a board drawing, without drawing it. */
function boardPinNames(type: string): string[] {
  try {
    const el = document.createElement(type) as any;
    return (el.pinInfo ?? []).map((p: any) => String(p.name));
  } catch {
    return [];
  }
}

export default function SimWorkspace({ compile }: Props) {
  const initial = useMemo(() => loadSaved() ?? { code: DEFAULT_EXAMPLE.code, diagram: DEFAULT_EXAMPLE.diagram }, []);
  const [code, setCode] = useState(initial.code);
  const [diagram, setDiagram] = useState<Diagram>(initial.diagram);
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  const past = useRef<Diagram[]>([]);
  const future = useRef<Diagram[]>([]);
  const [, setHistoryTick] = useState(0);

  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 0.9 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [menu, setMenu] = useState<null | "examples" | "file">(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"circuit" | "code" | "serial">("circuit");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);

  // Geometry of each drawn part (size and pins), for wires.
  const geo = useRef(new Map<string, Geometry>());
  const [geoTick, setGeoTick] = useState(0);
  const elements = useRef(new Map<string, HTMLElement>());
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ from: string; bends: Point[]; cursor: Point } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pruneAfterMeasure = useRef(new Set<string>());

  // Running.
  const [runState, setRunState] = useState<RunState>("stopped");
  const runStateRef = useRef<RunState>("stopped");
  const simRef = useRef<Simulation | null>(null);
  const simParts = useRef(new Map<string, DiagramPart>());
  const rendered = useRef(new Map<string, number>());
  const renderedBoard = useRef(-1);
  const rafId = useRef(0);
  const lastFrame = useRef(0);
  const speedAcc = useRef({ real: 0, sim: 0 });
  const [simInfo, setSimInfo] = useState({ ms: 0, speed: 0 });
  const [serial, setSerial] = useState("");
  const serialBuf = useRef("");
  const [problem, setProblem] = useState<BuildProblem | null>(null);
  const [bottomTab, setBottomTab] = useState<"serial" | "output">("serial");
  const hexCache = useRef<{ key: string; hex: string } | null>(null);
  const audio = useRef<BuzzerSound | null>(null);
  if (!audio.current) audio.current = new BuzzerSound();
  const [muted, setMuted] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [liveValues, setLiveValues] = useState<Record<string, Record<string, number | boolean>>>({});
  const [shorted, setShorted] = useState(false);

  const running = runState === "running" || runState === "paused";
  const board = boardOf(diagram);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Saved as it changes, for the next visit.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify({ code, diagram })); } catch { /* storage full or blocked */ }
    }, 400);
    return () => clearTimeout(t);
  }, [code, diagram]);

  // ---- Editing, with undo ----

  const commit = useCallback((next: Diagram, before: Diagram = diagramRef.current) => {
    past.current.push(before);
    if (past.current.length > HISTORY_MAX) past.current.shift();
    future.current = [];
    diagramRef.current = next;
    setDiagram(next);
    setHistoryTick((t) => t + 1);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(diagramRef.current);
    diagramRef.current = prev;
    setDiagram(prev);
    setSelection(null);
    setHistoryTick((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(diagramRef.current);
    diagramRef.current = next;
    setDiagram(next);
    setSelection(null);
    setHistoryTick((t) => t + 1);
  }, []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 3500);
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
      if (kept.length !== d.connections.length) {
        const next = { ...d, connections: kept };
        diagramRef.current = next;
        setDiagram(next);
      }
    }
  }, []);

  const onElement = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el); else elements.current.delete(id);
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
    if (!r || r.width < 50 || r.height < 50) return;
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
    if (!Number.isFinite(minX)) return;
    const pad = 40;
    const zoom = Math.min(2, Math.max(0.2, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
    setView({ zoom, x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (r.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  }, []);

  // Fit once the parts are drawn, and again after loading an example.
  const fitPending = useRef(true);
  useEffect(() => {
    if (!fitPending.current) return;
    const drawn = diagram.parts.every((p) => geo.current.has(p.id));
    if (drawn) { fitPending.current = false; fit(); }
  }, [geoTick, diagram.parts, fit]);

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
  }, [zoomAt, narrow, mobileTab]);

  type Drag =
    | { kind: "pan"; x: number; y: number; vx: number; vy: number; moved: boolean; tap: boolean }
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
    commit({ ...d, connections: [...d.connections, [dr.from, to, wireColourFor(dr.from, to), route]] });
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
    drag.current = { kind: "pan", x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false, tap: true };
  };

  const onPartPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (runStateRef.current === "running" || runStateRef.current === "paused") {
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
    if (narrow) setMobileTab("circuit");
  }, [commit, narrow]);

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
      if (boardOf(d)?.part.id === selection.id) { flash("The board stays: change it with the board menu."); return; }
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

  /** Another board: the same wires, to the pins of the same name on it. */
  const changeBoard = useCallback((id: BoardId) => {
    const d = diagramRef.current;
    const current = boardOf(d);
    const target = BOARD_PARTS.find((b) => b.id === id)!;
    if (!current || current.part.type === target.type) return;
    const oldId = current.part.id;
    const newId = d.parts.some((p) => p.id === target.id && p !== current.part) ? nextId(target.id, d.parts.map((p) => p.id)) : target.id;
    const names = new Set(boardPinNames(target.type));
    const mapPin = (pin: string): string | null => {
      if (names.has(pin)) return pin;
      const bare = pin.replace(/\.\d+$/, "");
      if (names.has(bare)) return bare;
      if (names.has(`${bare}.1`)) return `${bare}.1`;
      return null;
    };
    let dropped = 0;
    const connections: DiagramConnection[] = [];
    for (const c of d.connections) {
      const ends = [c[0], c[1]].map((ref) => {
        const s = splitPin(ref);
        if (!s || s[0] !== oldId) return ref;
        const pin = mapPin(s[1]);
        return pin ? `${newId}:${pin}` : null;
      });
      if (ends[0] && ends[1]) connections.push([ends[0], ends[1], c[2], c[3] ?? []]);
      else dropped++;
    }
    hexCache.current = null;
    fitPending.current = true;
    commit({ ...d, parts: d.parts.map((p) => (p === current.part ? { ...p, id: newId, type: target.type, attrs: {} } : p)), connections });
    setSelection(null);
    if (dropped) flash(`${dropped} wire${dropped > 1 ? "s" : ""} went to pins the ${target.name} doesn't have, and ${dropped > 1 ? "were" : "was"} removed.`);
  }, [commit, flash]);

  // ---- Running ----

  const renderStates = useCallback((sim: Simulation) => {
    for (const [id, model] of sim.models) {
      if (rendered.current.get(id) === model.version) continue;
      rendered.current.set(id, model.version);
      const part = simParts.current.get(id);
      const el = elements.current.get(id);
      if (part && el) applyState(part.type, el as any, model.state, part.attrs ?? {});
      if (part?.type === "wokwi-buzzer") audio.current!.set(id, (model.state as { frequency: number }).frequency);
    }
    if (renderedBoard.current !== sim.boardLeds.version) {
      renderedBoard.current = sim.boardLeds.version;
      const el = elements.current.get(sim.boardPart.id);
      if (el) applyBoard(el as any, sim.boardLeds, true);
    }
  }, []);

  const loop = useCallback((now: number) => {
    const sim = simRef.current;
    if (!sim || runStateRef.current !== "running") return;
    const realMs = Math.min(Math.max(now - lastFrame.current, 0), 50);
    lastFrame.current = now;
    const want = realMs * (sim.hz / 1000);
    const chunk = sim.hz / 500;
    const deadline = performance.now() + 12;
    let done = 0;
    try {
      while (done < want) {
        const c = Math.min(chunk, want - done);
        sim.advance(c);
        done += c;
        if (performance.now() > deadline) break;
      }
      sim.settle();
    } catch (err: any) {
      runStateRef.current = "paused";
      setRunState("paused");
      setProblem({ error: `The simulation stopped: ${err?.message || err}` });
      return;
    }
    renderStates(sim);
    if (serialBuf.current) {
      const add = serialBuf.current;
      serialBuf.current = "";
      setSerial((s) => (s + add).slice(-SERIAL_MAX));
    }
    const acc = speedAcc.current;
    acc.real += realMs;
    acc.sim += (done / sim.hz) * 1000;
    if (acc.real >= 400) {
      setSimInfo({ ms: sim.timeMs, speed: acc.sim / acc.real });
      setShorted(sim.shorted);
      speedAcc.current = { real: 0, sim: 0 };
    }
    rafId.current = requestAnimationFrame(loop);
  }, [renderStates]);

  const setRun = (s: RunState) => { runStateRef.current = s; setRunState(s); };

  const startWith = useCallback((hex: string) => {
    const snapshot = diagramRef.current;
    let sim: Simulation;
    try {
      sim = new Simulation(snapshot, hex, { models: PART_MODELS, onSerial: (t) => { serialBuf.current += t; } });
    } catch (err: any) {
      setRun("stopped");
      setProblem({ error: err?.message || String(err) });
      setBottomTab("output");
      return;
    }
    simRef.current = sim;
    simParts.current = new Map(snapshot.parts.map((p) => [p.id, p]));
    rendered.current.clear();
    renderedBoard.current = -1;
    serialBuf.current = "";
    setSerial("");
    setSimInfo({ ms: 0, speed: 1 });
    speedAcc.current = { real: 0, sim: 0 };
    const values: Record<string, Record<string, number | boolean>> = {};
    for (const part of snapshot.parts) {
      const spec = specFor(part.type, part.attrs);
      for (const l of spec?.live ?? []) {
        values[part.id] = values[part.id] ?? {};
        if (l.attr) values[part.id][l.input] = Number(part.attrs?.[l.attr] ?? spec?.attrs?.[l.attr] ?? l.fallback ?? 0);
        else if (l.kind === "toggle") values[part.id][l.input] = false;
      }
    }
    setLiveValues(values);
    setDraft(null);
    setRun("running");
    lastFrame.current = performance.now();
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(loop);
  }, [loop]);

  const start = useCallback(async () => {
    const state = runStateRef.current;
    if (state === "compiling" || state === "running") return;
    audio.current!.resume();
    if (state === "paused") {
      rendered.current.clear();
      setRun("running");
      lastFrame.current = performance.now();
      rafId.current = requestAnimationFrame(loop);
      return;
    }
    const found = boardOf(diagramRef.current);
    if (!found) { setProblem({ error: "Add an Arduino board to the circuit first." }); setBottomTab("output"); return; }
    const key = `${found.board.id}\n${code}`;
    if (hexCache.current?.key === key) { setProblem(null); startWith(hexCache.current.hex); return; }
    setRun("compiling");
    setProblem(null);
    let result: CompileResult;
    try {
      result = await compile(code, found.board.id);
    } catch (err: any) {
      result = { error: err?.message || "Couldn't reach the compiler. Check your connection and try again." };
    }
    if (runStateRef.current !== "compiling") return;
    if (!result.hex) {
      setRun("stopped");
      setProblem({ error: result.error || "Compilation failed.", output: result.output, hint: result.hint });
      setBottomTab("output");
      if (narrow) setMobileTab("serial");
      return;
    }
    hexCache.current = { key, hex: result.hex };
    startWith(result.hex);
  }, [code, compile, loop, startWith, narrow]);

  const pause = useCallback(() => {
    if (runStateRef.current !== "running") return;
    cancelAnimationFrame(rafId.current);
    audio.current!.silence();
    setRun("paused");
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafId.current);
    audio.current!.silence();
    simRef.current = null;
    setRun("stopped");
    setShorted(false);
    // Drawn again from scratch: LEDs off, knobs back where they were set.
    setEpoch((e) => e + 1);
  }, []);

  const restart = useCallback(() => {
    const hex = hexCache.current?.hex;
    cancelAnimationFrame(rafId.current);
    audio.current!.silence();
    simRef.current = null;
    setEpoch((e) => e + 1);
    if (hex) requestAnimationFrame(() => startWith(hex)); else setRun("stopped");
  }, [startWith]);

  useEffect(() => () => { cancelAnimationFrame(rafId.current); audio.current?.dispose(); }, []);

  const onPartInput = useCallback((id: string, name: string, value: unknown) => {
    if (runStateRef.current === "stopped" || runStateRef.current === "compiling") return;
    simRef.current?.input(id, name, value);
  }, []);

  const onLive = useCallback((input: string, value: number | boolean) => {
    if (selection?.kind !== "part") return;
    const id = selection.id;
    simRef.current?.input(id, input, value);
    if (typeof value === "number" || input !== "motion") setLiveValues((lv) => ({ ...lv, [id]: { ...(lv[id] ?? {}), [input]: value } }));
  }, [selection]);

  // ---- Keyboard ----

  const pressedKeys = useRef(new Set<string>());
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const buttonsFor = (key: string) => diagramRef.current.parts.filter((p) => (p.type === "wokwi-pushbutton" || p.type === "wokwi-pushbutton-6mm") && p.attrs?.key && p.attrs.key.toLowerCase() === key.toLowerCase());
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
      if (typing(e.target)) return;
      const state = runStateRef.current;
      if (state === "running" || state === "paused") {
        const buttons = buttonsFor(e.key);
        if (buttons.length) {
          e.preventDefault();
          if (pressedKeys.current.has(e.key)) return;
          pressedKeys.current.add(e.key);
          for (const b of buttons) simRef.current?.input(b.id, "press", true);
        }
        return;
      }
      if (!viewport.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      else if (e.key === "r" || e.key === "R") { if (!mod) rotateSelected(); }
      else if (e.key === "Escape") { setDraft(null); setSelection(null); }
    };
    const up = (e: KeyboardEvent) => {
      if (!pressedKeys.current.delete(e.key)) return;
      for (const b of buttonsFor(e.key)) simRef.current?.input(b.id, "press", false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [undo, redo, deleteSelected, rotateSelected, duplicateSelected]);

  // ---- Files and examples ----

  const loadProject = useCallback((next: { code?: string; diagram: Diagram }) => {
    if (runStateRef.current !== "stopped") stop();
    commit(next.diagram);
    if (next.code !== undefined) setCode(next.code);
    hexCache.current = null;
    setSelection(null);
    setProblem(null);
    setSerial("");
    fitPending.current = true;
    geo.current.clear();
    setGeoTick((t) => t + 1);
    // Drawn afresh, so every part reports its pins again.
    setEpoch((e) => e + 1);
  }, [commit, stop]);

  const openExample = (ex: Example) => {
    setMenu(null);
    loadProject({ code: ex.code, diagram: JSON.parse(JSON.stringify(ex.diagram)) });
    flash(`Opened “${ex.name}”. Press Start to run it.`);
  };

  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importText = (text: string, fileName = "") => {
    if (/\.(ino|cpp|c|h)$/i.test(fileName)) { setCode(text); hexCache.current = null; flash("Sketch loaded."); return true; }
    try {
      const d = parseDiagram(text);
      if (!boardOf(d)) { flash("That diagram has no Arduino Uno, Nano or Mega in it."); return false; }
      loadProject({ diagram: d });
      flash("Circuit loaded.");
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
  const unsupported = diagram.parts.filter((p) => !own(PART_MODELS, p.type) && !isBoardType(p.type));
  const draftPoints = draft ? (() => {
    const a = pinAt(draft.from);
    if (!a) return null;
    const route = routeFrom(a.pt, draft.bends);
    return wirePoints(a.pt, draft.cursor, route, a.axis);
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
  const seconds = simInfo.ms / 1000;

  const toolbar = (
    <div className="relative z-30 flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-main)] bg-[var(--bg-panel)] px-2 py-1.5">
      <label className="sr-only" htmlFor="sim-board">Board</label>
      <select
        id="sim-board"
        value={board?.board.id ?? "uno"}
        disabled={running || runState === "compiling"}
        onChange={(e) => changeBoard(e.target.value as BoardId)}
        className="rounded-md border border-[var(--border-main)] bg-[var(--bg-surface)] px-2 py-1.5 text-[12px] font-medium text-[var(--text-main)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-60"
      >
        {BOARD_PARTS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>

      {runState === "running" ? (
        <button type="button" onClick={pause} className={`${btn} text-[var(--text-main)]`} title="Pause" aria-label="Pause"><Pause size={14} /> <span className="hidden sm:inline">Pause</span></button>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={runState === "compiling"}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-70"
          style={{ background: "var(--gradient-accent)" }}
          title={runState === "paused" ? "Resume" : "Compile and start"}
        >
          {runState === "compiling" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {runState === "compiling" ? "Compiling…" : runState === "paused" ? "Resume" : "Start"}
        </button>
      )}
      <button type="button" onClick={restart} disabled={!running} className={iconBtn} title="Restart" aria-label="Restart"><RotateCcw size={15} /></button>
      <button type="button" onClick={stop} disabled={runState === "stopped" || runState === "compiling"} className={iconBtn} title="Stop" aria-label="Stop"><Square size={15} /></button>

      {running && (
        <span className="ml-1 hidden items-center gap-2 font-mono text-[11px] text-[var(--text-muted)] sm:flex" aria-live="off">
          <span>{seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`}</span>
          <span className={simInfo.speed < 0.9 ? "text-[var(--term-serial)]" : "text-[var(--term-success)]"} title="Simulated time against real time">{Math.round(simInfo.speed * 100)}%</span>
        </span>
      )}

      <div className="mx-1 h-5 w-px bg-[var(--border-main)]" />
      <button type="button" onClick={() => setLibraryOpen(true)} disabled={running} className={btn} title="Add a part" aria-label="Add a part"><Plus size={14} /> <span className="hidden sm:inline">Add part</span></button>
      <button type="button" onClick={undo} disabled={running || !past.current.length} className={iconBtn} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
      <button type="button" onClick={redo} disabled={running || !future.current.length} className={iconBtn} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={15} /></button>

      <div className="relative" data-menu>
        <button type="button" onClick={() => setMenu(menu === "examples" ? null : "examples")} className={btn} aria-expanded={menu === "examples"} aria-label="Examples" title="Examples"><BookOpen size={14} /> <span className="hidden sm:inline">Examples</span> <ChevronDown size={12} /></button>
        {menu === "examples" && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-[60vh] w-72 overflow-y-auto rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] p-1 shadow-xl" role="menu">
            {EXAMPLES.map((ex) => (
              <button key={ex.id} type="button" role="menuitem" onClick={() => openExample(ex)} className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg-hover)]">
                <div className="text-[12px] font-medium text-[var(--text-main)]">{ex.name}</div>
                <div className="text-[11px] leading-snug text-[var(--text-muted)]">{ex.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="relative" data-menu>
        <button type="button" onClick={() => setMenu(menu === "file" ? null : "file")} className={btn} aria-expanded={menu === "file"} aria-label="File" title="File"><Download size={14} /> <span className="hidden sm:inline">File</span> <ChevronDown size={12} /></button>
        {menu === "file" && (
          <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] p-1 shadow-xl" role="menu">
            {[
              { icon: <FilePlus2 size={13} />, label: "New circuit", act: () => { if (confirm("Start a new circuit? The current one is replaced.")) loadProject({ code: "void setup() {\n\n}\n\nvoid loop() {\n\n}\n", diagram: { version: 1, editor: "joint-agent", parts: [{ id: board?.board.id ?? "uno", type: board?.part.type ?? "wokwi-arduino-uno", left: 0, top: 0, rotate: 0, attrs: {} }], connections: [] } }); } },
              { icon: <Upload size={13} />, label: "Open diagram.json or sketch…", act: () => fileInput.current?.click() },
              { icon: <ClipboardPaste size={13} />, label: "Paste a Wokwi diagram.json", act: () => setPasteOpen(true) },
              { icon: <Download size={13} />, label: "Download diagram.json", act: () => download("diagram.json", JSON.stringify(diagram, null, 2), "application/json") },
              { icon: <Download size={13} />, label: "Download sketch.ino", act: () => download("sketch.ino", code, "text/plain") },
            ].map((item) => (
              <button key={item.label} type="button" role="menuitem" disabled={running} onClick={() => { setMenu(null); item.act(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-40">
                {item.icon} {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.ino,.cpp,.c,.h,application/json,text/plain"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > 2_000_000) { flash("That file is too big."); return; }
          importText(await f.text(), f.name);
        }}
      />
      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" onClick={() => { const m = !muted; setMuted(m); audio.current!.setMuted(m); }} className={iconBtn} title={muted ? "Sound off" : "Sound on"} aria-label={muted ? "Turn sound on" : "Turn sound off"}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
      </div>
    </div>
  );

  const canvas = (
    <div className="relative h-full min-h-0 w-full overflow-hidden" style={{ background: "var(--bg-schematic)" }}>
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
              key={`${part.id}:${part.type}:${epoch}`}
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
                {selection?.kind === "wire" && selection.index === i && <path d={pathOf(pts)} stroke="var(--accent-primary)" strokeOpacity={0.45} strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                <path d={pathOf(pts)} stroke={diagram.connections[i][2] || "green"} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
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

      {/* Zoom, and what's going on */}
      <div className="absolute bottom-2 left-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)]/90 p-0.5 shadow backdrop-blur">
        <button type="button" onClick={() => zoomAt(1 / 1.2)} className={iconBtn} title="Zoom out" aria-label="Zoom out"><ZoomOut size={14} /></button>
        <span className="w-10 text-center font-mono text-[10px] text-[var(--text-muted)]">{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => zoomAt(1.2)} className={iconBtn} title="Zoom in" aria-label="Zoom in"><ZoomIn size={14} /></button>
        <button type="button" onClick={fit} className={iconBtn} title="Fit the circuit" aria-label="Fit the circuit"><Maximize size={14} /></button>
      </div>
      {(draft || notice || shorted || unsupported.length > 0) && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex max-w-[92%] -translate-x-1/2 flex-col items-center gap-1">
          {draft && <div className="rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-main)] shadow">Tap another pin to connect · tap the canvas to bend · Esc to cancel</div>}
          {notice && <div className="rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-main)] shadow">{notice}</div>}
          {shorted && running && <div className="flex items-center gap-1.5 rounded-full border border-[var(--term-error)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--term-error)] shadow"><AlertTriangle size={12} /> Short circuit: two outputs (or power and ground) are wired together.</div>}
          {unsupported.length > 0 && !running && <div className="rounded-full border border-[var(--border-main)] bg-[var(--bg-panel)]/95 px-3 py-1 text-[11px] text-[var(--text-muted)] shadow">{unsupported.length} part{unsupported.length > 1 ? "s" : ""} in this circuit {unsupported.length > 1 ? "aren't" : "isn't"} supported yet and won't do anything.</div>}
        </div>
      )}
      {(selectedPart || selectedWire) && (
        <div className="absolute right-2 top-2 z-30 w-[calc(100%-1rem)] sm:w-auto">
          <SidePanel
            part={selectedPart}
            wire={selectedWire}
            running={running}
            isBoard={!!selectedPart && boardOf(diagram)?.part.id === selectedPart.id}
            liveValues={(selectedPart && liveValues[selectedPart.id]) || {}}
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
  );

  const editor = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-root)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-main)] bg-[var(--bg-panel)] px-3 py-1.5">
        <Code2 size={13} className="text-[var(--accent-primary)]" />
        <span className="font-mono text-[11px] text-[var(--text-main)]">sketch.ino</span>
        {running && <span className="ml-auto text-[10px] text-[var(--text-subtle)]">Changes take effect on the next Start</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Editor
          value={code}
          onValueChange={(c) => setCode(c)}
          highlight={(c) => Prism.highlight(c, Prism.languages.cpp, "cpp")}
          padding={14}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: "22px", minHeight: "100%" }}
          className="editor-container text-[var(--text-main)]"
          textareaClassName="focus:outline-none"
          aria-label="Sketch"
        />
      </div>
    </div>
  );

  const monitor = (
    <SerialMonitor
      text={serial}
      problem={problem}
      tab={bottomTab}
      onTab={setBottomTab}
      canSend={runState === "running"}
      onSend={(t) => simRef.current?.serialWrite(t)}
      onClear={() => setSerial("")}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border-main)] bg-[var(--bg-root)]" onPointerDown={(e) => { if (menu && !(e.target instanceof Element && e.target.closest("[data-menu]"))) setMenu(null); }}>
      {toolbar}
      {narrow ? (
        <>
          <div className="flex shrink-0 border-b border-[var(--border-main)] bg-[var(--bg-panel)]" role="tablist">
            {([["circuit", "Circuit", CircuitBoard], ["code", "Code", Code2], ["serial", "Serial", TerminalSquare]] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mobileTab === id}
                onClick={() => setMobileTab(id)}
                className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2 text-[11px] font-medium transition ${mobileTab === id ? "border-[var(--accent-primary)] text-[var(--text-main)]" : "border-transparent text-[var(--text-muted)]"}`}
              >
                <Icon size={13} /> {label}
                {id === "serial" && problem && <span className="h-1.5 w-1.5 rounded-full bg-[var(--term-error)]" />}
              </button>
            ))}
          </div>
          <div className="relative min-h-0 flex-1">
            <div className={`absolute inset-0 ${mobileTab === "circuit" ? "" : "invisible"}`}>{canvas}</div>
            <div className={`absolute inset-0 ${mobileTab === "code" ? "" : "invisible"}`}>{editor}</div>
            <div className={`absolute inset-0 ${mobileTab === "serial" ? "" : "invisible"}`}>{monitor}</div>
          </div>
        </>
      ) : (
        <PanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <Panel defaultSize={38} minSize={20}>{editor}</Panel>
          <PanelResizeHandle className="w-[3px] bg-[var(--border-main)] transition hover:bg-[var(--accent-primary)]" />
          <Panel defaultSize={62} minSize={30}>
            <PanelGroup orientation="vertical">
              <Panel defaultSize={72} minSize={25}>{canvas}</Panel>
              <PanelResizeHandle className="h-[3px] bg-[var(--border-main)] transition hover:bg-[var(--accent-primary)]" />
              <Panel defaultSize={28} minSize={10}>{monitor}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      )}

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
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">Cancel</button>
            <button type="button" onClick={() => onLoad(text)} disabled={!text.trim()} className="rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">Load circuit</button>
          </div>
        </div>
      </div>
    </div>
  );
}
