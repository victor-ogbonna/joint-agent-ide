/**
 * The simulation, run once for the whole app: started by Play in the
 * circuit view, it keeps running while that view is out of sight (another
 * tab, another pane on a phone) and draws onto the circuit whenever it is
 * on screen. What the program prints goes to the app's Serial Monitor.
 */
import { useSyncExternalStore } from "react";
import type { Diagram, DiagramPart } from "./diagram";
import type { Runner } from "./runner";
import { applyBoard, applyState } from "./view";
import { BuzzerSound } from "./audio";
import { specFor } from "./catalog";

export type RunState = "stopped" | "compiling" | "running" | "paused";

/** Starts the program on a circuit: the runner, or null when it couldn't (the reason already told). */
export type Starter = (diagram: Diagram, onSerial: (text: string) => void) => Promise<Runner | null>;

export interface SessionHooks {
  /** Text the program printed. */
  onSerial(text: string): void;
  /** Running, paused, stopped... */
  onState?(state: RunState): void;
}

export interface SessionSnapshot {
  state: RunState;
  /** Simulated time (ms) and speed against real time, refreshed a few times a second. */
  ms: number;
  speed: number;
  shorted: boolean;
  /** What stopped it, shown until the next run. */
  error: string | null;
  /** Each sensor's control value, by part and input. */
  live: Record<string, Record<string, number | boolean>>;
  /** Changes when the drawings must start afresh (stopped: LEDs off, knobs back). */
  epoch: number;
  muted: boolean;
}

export class SimSession {
  private snap: SessionSnapshot = { state: "stopped", ms: 0, speed: 1, shorted: false, error: null, live: {}, epoch: 0, muted: false };
  private listeners = new Set<() => void>();
  private runner: Runner | null = null;
  private parts = new Map<string, DiagramPart>();
  private elements: Map<string, HTMLElement> | null = null;
  private rendered = new Map<string, number>();
  private renderedBoard = -1;
  private sounded = new Map<string, number>();
  private raf = 0;
  private last = 0;
  private infoAt = 0;
  private ticket = 0;
  private hooks: SessionHooks | null = null;
  private lastStart: { diagram: Diagram; start: Starter } | null = null;
  readonly audio = new BuzzerSound();

  // ---- For React ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<SessionSnapshot>) {
    const before = this.snap.state;
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
    if (patch.state && patch.state !== before) this.hooks?.onState?.(patch.state);
  }

  get state() { return this.snap.state; }
  get running() { return this.snap.state === "running" || this.snap.state === "paused"; }

  // ---- Running ----

  /** Play: resumes a paused run, or builds and starts a new one on `diagram`. */
  async play(diagram: Diagram, start: Starter, hooks: SessionHooks) {
    const state = this.snap.state;
    if (state === "compiling" || state === "running") return;
    this.audio.resume();
    if (state === "paused" && this.runner) {
      this.rendered.clear();
      this.renderedBoard = -1;
      this.runner.resume?.();
      this.set({ state: "running" });
      this.kick();
      return;
    }
    const ticket = ++this.ticket;
    this.hooks = hooks;
    this.lastStart = { diagram, start };
    this.set({ state: "compiling", error: null, shorted: false });
    let runner: Runner | null = null;
    try {
      runner = await start(diagram, (text) => { if (ticket === this.ticket) this.hooks?.onSerial(text); });
    } catch (err: any) {
      if (ticket === this.ticket) this.set({ state: "stopped", error: err?.message || String(err) });
      return;
    }
    if (ticket !== this.ticket) { runner?.dispose(); return; }
    if (!runner) { this.set({ state: "stopped" }); return; }
    this.runner = runner;
    this.parts = new Map(diagram.parts.map((p) => [p.id, p]));
    this.rendered.clear();
    this.renderedBoard = -1;
    this.sounded.clear();
    const live: SessionSnapshot["live"] = {};
    for (const part of diagram.parts) {
      const spec = specFor(part.type, part.attrs);
      for (const l of spec?.live ?? []) {
        live[part.id] = live[part.id] ?? {};
        if (l.attr) live[part.id][l.input] = Number(part.attrs?.[l.attr] ?? spec?.attrs?.[l.attr] ?? l.fallback ?? 0);
        else if (l.kind === "toggle") live[part.id][l.input] = false;
      }
    }
    this.set({ state: "running", ms: 0, speed: 1, live });
    this.kick();
  }

  pause() {
    if (this.snap.state !== "running") return;
    cancelAnimationFrame(this.raf);
    this.audio.silence();
    this.runner?.pause?.();
    this.set({ state: "paused", ms: this.runner?.timeMs ?? this.snap.ms });
  }

  /** Stops, and the drawings start afresh. */
  stop() {
    this.ticket++;
    cancelAnimationFrame(this.raf);
    this.audio.silence();
    this.runner?.dispose();
    this.runner = null;
    if (this.snap.state === "stopped") return;
    this.set({ state: "stopped", shorted: false, epoch: this.snap.epoch + 1 });
  }

  /** From the start again, on the same circuit and program. */
  async restart() {
    const last = this.lastStart;
    const hooks = this.hooks;
    if (!last || !hooks) return;
    this.stop();
    await this.play(last.diagram, last.start, hooks);
  }

  private kick() {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    const runner = this.runner;
    if (!runner || this.snap.state !== "running") return;
    const realMs = Math.min(Math.max(now - this.last, 0), 50);
    this.last = now;
    runner.frame(realMs);
    if (runner.error) {
      this.audio.silence();
      runner.pause?.();
      this.set({ state: "paused", error: runner.error, ms: runner.timeMs });
      return;
    }
    this.paint();
    if (now - this.infoAt > 250) {
      this.infoAt = now;
      this.set({ ms: runner.timeMs, speed: runner.speed, shorted: runner.shorted });
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** What each part shows, onto its drawing (when the circuit is on screen), and the buzzers' sound. */
  private paint() {
    const runner = this.runner;
    if (!runner) return;
    for (const [id, view] of runner.views()) {
      const part = this.parts.get(id);
      if (!part) continue;
      if (part.type === "wokwi-buzzer" && this.sounded.get(id) !== view.version) {
        this.sounded.set(id, view.version);
        this.audio.set(id, (view.state as { frequency: number }).frequency);
      }
      if (!this.elements || this.rendered.get(id) === view.version) continue;
      const el = this.elements.get(id);
      if (!el) continue;
      this.rendered.set(id, view.version);
      applyState(part.type, el as any, view.state, part.attrs ?? {});
    }
    const leds = runner.boardLeds;
    if (this.elements && this.renderedBoard !== leds.version) {
      const el = this.elements.get(runner.boardPartId);
      if (el) {
        this.renderedBoard = leds.version;
        applyBoard(el as any, leds, true);
      }
    }
  }

  // ---- The circuit on screen ----

  /** The circuit's drawings, by part id, while it is on screen. */
  attach(elements: Map<string, HTMLElement>) {
    this.elements = elements;
    this.rendered.clear();
    this.renderedBoard = -1;
    if (this.runner) this.paint();
  }

  detach(elements: Map<string, HTMLElement>) {
    if (this.elements === elements) this.elements = null;
  }

  /** A drawing was made again (the circuit came back on screen): it shows the run's state on the next frame. */
  redraw(id: string) {
    this.rendered.delete(id);
    if (this.runner && this.parts.get(id) && this.runner.boardPartId === id) this.renderedBoard = -1;
    if (this.snap.state === "paused") this.paint();
  }

  // ---- Working the parts ----

  input(partId: string, name: string, value: unknown) {
    if (!this.running) return;
    this.runner?.input(partId, name, value);
  }

  /** A sensor's control in the side panel. */
  live(partId: string, input: string, value: number | boolean) {
    if (!this.running) return;
    this.runner?.input(partId, input, value);
    if (typeof value === "number" || input !== "motion") {
      this.set({ live: { ...this.snap.live, [partId]: { ...(this.snap.live[partId] ?? {}), [input]: value } } });
    }
  }

  serialWrite(text: string) {
    if (this.snap.state !== "running") return;
    this.runner?.serialWrite(text);
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
    this.set({ muted });
  }
}

/** The one simulation of the app. */
export const simSession = new SimSession();

export function useSimSession(): SessionSnapshot {
  return useSyncExternalStore(simSession.subscribe, simSession.getSnapshot, simSession.getSnapshot);
}
