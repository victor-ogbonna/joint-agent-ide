import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Cpu, Puzzle, TerminalSquare, X, Loader2, Zap,
  Mail, Lock, User as UserIcon, ArrowRight, Sparkles,
  MessageSquare, FileCode2, FlaskConical, Activity, Chrome, Bell, Check, Smartphone, Play, Pause
} from "lucide-react";
import { useAuth } from "./contexts/AuthContext";
import { useResetOnReturn } from "./components/GoogleSignInButton";
import { useDocumentScroll } from "./useDocumentScroll";

type AuthMode = "signin" | "signup";

/**
 * Back from signing in with Google in this tab, with an error: the sign-in
 * box opens again to show it. Its own component so that HomePage itself never
 * calls useAuth() (in waitlist mode it renders outside the AuthProvider).
 */
function OpenOnReturnedError({ onOpen }: { onOpen: () => void }) {
  const { returnedWithError } = useAuth();
  useEffect(() => {
    if (returnedWithError) onOpen();
  }, [returnedWithError]);
  return null;
}

function AuthModal({ mode, onClose, onSwitchMode }: { mode: AuthMode; onClose: () => void; onSwitchMode: (m: AuthMode) => void }) {
  const { signInWithEmail, signUpWithEmail, signInWithGoogle, signInWithGoogleHere, offerSignInHere, error, clearError } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  useResetOnReturn(() => setGoogleSubmitting(false));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === "signup") {
        await signUpWithEmail(name, email, password);
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err) {
      // error already captured in context
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogle = async (inThisTab = false) => {
    setGoogleSubmitting(true);
    try {
      await (inThisTab ? signInWithGoogleHere() : signInWithGoogle());
    } catch (err) {
      // handled in context
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    // Scroll lives on the overlay, with an inner min-h-full flex wrapper: when
    // the card is taller than the viewport (landscape phone, short window) the
    // wrapper grows past full height instead of the card overflowing a centered
    // flex box, which would otherwise make the top unreachable by scrolling.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-2xl shadow-2xl overflow-hidden animate-slide-up">
        <div className="relative px-6 pt-6 pb-4 text-center">
          {/* w-11/h-11 = a 44px touch target (the accessibility floor for
              fingers) while the icon itself stays visually small. */}
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-2 top-2 w-11 h-11 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] transition rounded-md hover:bg-[var(--bg-hover)]"
          >
            <X size={16} />
          </button>
          <img src="/logo.png" alt="Joint-Agent IDE" className="w-11 h-11 mx-auto rounded-xl shadow-lg mb-3" />
          <h2 className="font-display font-bold text-lg text-[var(--text-main)]">
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {mode === "signup" ? "Start building with Joint-Agent IDE." : "Sign in to pick up where you left off."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-2 space-y-3">
          {mode === "signup" && (
            <div className="relative">
              <UserIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-9 pr-3 py-2.5 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
              />
            </div>
          )}
          <div className="relative">
            <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-9 pr-3 py-2.5 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
          </div>
          <div className="relative">
            <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-9 pr-3 py-2.5 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || googleSubmitting}
            className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-semibold py-2.5 rounded-lg transition disabled:opacity-60 shadow-sm"
            style={{ background: "var(--gradient-accent)" }}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : mode === "signup" ? "Create Account" : "Sign In"}
          </button>
        </form>

        <div className="px-6 flex items-center gap-3 py-3">
          <div className="flex-1 h-px bg-[var(--border-main)]" />
          <span className="text-[10px] text-[var(--text-subtle)] uppercase tracking-wider">or</span>
          <div className="flex-1 h-px bg-[var(--border-main)]" />
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={() => void handleGoogle()}
            disabled={submitting || googleSubmitting}
            className="w-full flex items-center justify-center gap-2 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-main)] text-[var(--text-main)] text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
          >
            {googleSubmitting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <svg width="15" height="15" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/>
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/>
                <path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.9 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.5 5.5C39.9 36.6 44 31 44 24c0-1.3-.1-2.7-.4-3.5z"/>
              </svg>
            )}
            Continue with Google
          </button>
          {/* The pop-up closed before it finished (see the message above). */}
          {offerSignInHere && !googleSubmitting && (
            <button
              type="button"
              onClick={() => void handleGoogle(true)}
              disabled={submitting}
              className="mt-2 w-full flex items-center justify-center bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-main)] text-[var(--accent-secondary)] text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
            >
              Continue with Google in this tab
            </button>
          )}
        </div>

        <div className="px-6 pb-6 text-center text-xs text-[var(--text-muted)]">
          {mode === "signup" ? (
            <>Already have an account?{" "}
              <button onClick={() => { clearError(); onSwitchMode("signin"); }} className="text-[var(--accent-secondary)] hover:underline font-medium py-2 px-1 -my-1 inline-block">Sign in</button>
            </>
          ) : (
            <>New here?{" "}
              <button onClick={() => { clearError(); onSwitchMode("signup"); }} className="text-[var(--accent-secondary)] hover:underline font-medium py-2 px-1 -my-1 inline-block">Create an account</button>
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ambient backdrop — a sparse field of PCB-trace-style lines with the
// occasional pulse of "signal" traveling along one. Canvas rather than
// hand-authored SVG paths, and inert (a static faint grid, no animation) for
// prefers-reduced-motion.
// ---------------------------------------------------------------------------
function CircuitBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const lineColor = isDark ? "255,255,255" : "20,15,10";

    let width = 0, height = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    let traces: { pts: { x: number; y: number }[] }[] = [];
    let pulses: { traceIdx: number; t: number; speed: number }[] = [];
    let raf = 0;

    function resize() {
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildTraces();
    }

    // Orthogonal PCB-style traces: horizontal run, one right-angle turn, then
    // a vertical run — evokes a circuit board without drawing a literal one.
    function buildTraces() {
      traces = [];
      const rows = Math.max(4, Math.floor(height / 140));
      for (let i = 0; i < rows; i++) {
        const y0 = (height / rows) * (i + 0.5) + (Math.random() - 0.5) * 40;
        const xStart = Math.random() * width * 0.3;
        const xTurn = xStart + width * (0.25 + Math.random() * 0.35);
        const y1 = y0 + (Math.random() > 0.5 ? 1 : -1) * (60 + Math.random() * 100);
        const xEnd = Math.min(width, xTurn + 60 + Math.random() * 160);
        traces.push({ pts: [{ x: xStart, y: y0 }, { x: xTurn, y: y0 }, { x: xTurn, y: y1 }, { x: xEnd, y: y1 }] });
      }
      pulses = traces.map((_, idx) => ({ traceIdx: idx, t: Math.random(), speed: 0.0025 + Math.random() * 0.003 }));
    }

    function traceLength(pts: { x: number; y: number }[]) {
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      return len;
    }

    function pointAt(pts: { x: number; y: number }[], t: number) {
      const total = traceLength(pts);
      let target = total * t;
      for (let i = 1; i < pts.length; i++) {
        const segLen = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (target <= segLen) {
          const f = segLen === 0 ? 0 : target / segLen;
          return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
        }
        target -= segLen;
      }
      return pts[pts.length - 1];
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      ctx!.lineWidth = 1;
      ctx!.strokeStyle = `rgba(${lineColor},0.07)`;
      for (const tr of traces) {
        ctx!.beginPath();
        ctx!.moveTo(tr.pts[0].x, tr.pts[0].y);
        for (let i = 1; i < tr.pts.length; i++) ctx!.lineTo(tr.pts[i].x, tr.pts[i].y);
        ctx!.stroke();
        // via dots at the turns
        ctx!.fillStyle = `rgba(${lineColor},0.12)`;
        for (let i = 1; i < tr.pts.length - 1; i++) {
          ctx!.beginPath();
          ctx!.arc(tr.pts[i].x, tr.pts[i].y, 2, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      if (!reduceMotion) {
        for (const p of pulses) {
          p.t += p.speed;
          if (p.t > 1) p.t = 0;
          const pos = pointAt(traces[p.traceIdx].pts, p.t);
          const grad = ctx!.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 5);
          grad.addColorStop(0, "rgba(249,115,22,0.9)");
          grad.addColorStop(1, "rgba(249,115,22,0)");
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
          ctx!.fill();
        }
        raf = requestAnimationFrame(draw);
      }
    }

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Hero story — the thesis of the page, played on a real board. On top, the
// Arduino with its LED dark; below, a plain-English request to blink it; the
// agent runs, streams the firmware, applies it to the codespace and flashes
// it; then the photo blinks between the same board's LED-off and LED-on
// shots at the sketch's own 500 ms, and the story starts again. Both photos
// load up front, so every switch is a crossfade, never a late pop-in.
//
// It plays with reduced motion switched on too — many phones ship with it on,
// and a still frame told no story at all. Under reduced motion nothing slides
// or breathes; text types and photos crossfade, and a pause button stops it.
//
// Every state occupies the same space. Status rows are always rendered and
// only fade, and the prompt and code reserve their final size with invisible
// copies, so nothing below the hero moves while it plays.
// ---------------------------------------------------------------------------
const STORY_PROMPT = "Blink the LED connected to pin 4 of my Arduino";
const STORY_CODE = `#include <Arduino.h>

const int LED_PIN = 4;  // LED on pin 4

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);  // on
  delay(500);
  digitalWrite(LED_PIN, LOW);   // off
  delay(500);
}`;

// The lines a flash really prints, in the order the IDE's terminal shows them.
const STORY_FLASH_LOG = [
  "[COMPILER] Build succeeded.",
  "[FLASH] Bootloader responded.",
  "[FLASH] Writing… 100%",
  "[FLASH] Upload complete — the board is running your code.",
];

// Minimal C++ colouring: comment, #include, header, keyword, Arduino call,
// constant, number — in that order of precedence.
const CODE_TOKEN = /(\/\/[^\n]*)|(#include)|(<[\w.]+>)|\b(const|int|void)\b|\b(pinMode|digitalWrite|delay|setup|loop|Serial|println|begin)\b|\b(HIGH|LOW|OUTPUT)\b|\b(\d+)\b|("[^"\n]*")/g;
const CODE_COLOURS = [
  "var(--text-subtle)", "var(--accent-secondary)", "var(--term-success)", "var(--accent-secondary)",
  "var(--accent-primary)", "var(--term-serial)", "var(--term-serial)", "var(--term-success)",
];
type CodeToken = { text: string; colour?: string };
function tokenizeSketch(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const m of code.matchAll(CODE_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) tokens.push({ text: code.slice(last, at) });
    tokens.push({ text: m[0], colour: CODE_COLOURS[m.slice(1).findIndex(Boolean)] });
    last = at + m[0].length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  return tokens;
}
const STORY_TOKENS = tokenizeSketch(STORY_CODE);

/** The first `count` characters of a tokenized sketch, coloured. */
function renderSketch(count: number, tokens: CodeToken[] = STORY_TOKENS) {
  const out: React.ReactNode[] = [];
  let shown = 0;
  for (let i = 0; i < tokens.length && shown < count; i++) {
    const { text, colour } = tokens[i];
    const part = text.slice(0, count - shown);
    out.push(<span key={i} style={colour ? { color: colour } : undefined}>{part}</span>);
    shown += part.length;
  }
  return out;
}

type StoryStep = "prompt" | "running" | "coding" | "applied" | "flashing" | "blinking";
const STEP_ORDER: StoryStep[] = ["prompt", "running", "coding", "applied", "flashing", "blinking"];
const reached = (step: StoryStep, at: StoryStep) => STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(at);
const BLINK_TOGGLES = 10;  // five full blinks at 500 ms before the story starts over

function StatusRow({ show, busy, still, children }: { show: boolean; busy: boolean; still: boolean; children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 text-xs transition-all duration-300"
      style={{ opacity: show ? 1 : 0, transform: show || still ? "none" : "translateY(3px)" }}
    >
      <span
        className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
        style={{ background: busy ? "var(--accent-primary-soft)" : "color-mix(in srgb, var(--term-success) 16%, transparent)" }}
      >
        {busy
          ? <Loader2 size={10} className={`text-[var(--accent-primary)] ${still ? "" : "animate-spin"}`} />
          : <Check size={10} strokeWidth={3} className="text-[var(--term-success)]" />}
      </span>
      <span className={`min-w-0 truncate ${busy ? "text-[var(--text-main)]" : "text-[var(--text-muted)]"}`}>{children}</span>
    </div>
  );
}

function AgentStory() {
  const [reduceMotion] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
  const [step, setStep] = useState<StoryStep>("prompt");
  const [typed, setTyped] = useState("");
  const [codeShown, setCodeShown] = useState(0);
  const [logShown, setLogShown] = useState(0);
  const [ledOn, setLedOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [photosFailed, setPhotosFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
    // Time only runs while the story is visible and not paused.
    const wait = async (ms: number) => {
      let left = ms;
      while (left > 0 && !cancelled) {
        const step = Math.min(left, 40);
        await sleep(step);
        if (!pausedRef.current && !document.hidden) left -= step;
      }
    };

    async function play() {
      while (!cancelled) {
        setStep("prompt"); setTyped(""); setCodeShown(0); setLogShown(0); setLedOn(false);
        await wait(1000);
        for (let i = 1; i <= STORY_PROMPT.length; i++) {
          if (cancelled) return;
          setTyped(STORY_PROMPT.slice(0, i));
          await wait(30);
        }
        await wait(450);
        if (cancelled) return;
        setStep("running");
        await wait(1100);
        if (cancelled) return;
        setStep("coding");
        for (let i = 3; i < STORY_CODE.length; i += 3) {
          if (cancelled) return;
          setCodeShown(i);
          await wait(16);
        }
        setCodeShown(STORY_CODE.length);
        await wait(350);
        if (cancelled) return;
        setStep("applied");
        await wait(900);
        if (cancelled) return;
        setStep("flashing");
        for (let i = 1; i <= STORY_FLASH_LOG.length; i++) {
          if (cancelled) return;
          setLogShown(i);
          await wait(i === 3 ? 600 : 380);
        }
        if (cancelled) return;
        // The sketch is running: the LED blinks at its 500 ms.
        setStep("blinking");
        for (let t = 0; t < BLINK_TOGGLES; t++) {
          if (cancelled) return;
          setLedOn(t % 2 === 0);
          await wait(500);
        }
        setLedOn(false);
        await wait(700);
      }
    }
    play();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, []);

  const running = step === "running" || step === "coding";
  const done = step === "blinking";
  const stepLabel =
    step === "prompt" ? "Waiting for a prompt"
    : running ? "Agent is running"
    : step === "applied" ? "Firmware applied"
    : step === "flashing" ? "Flashing the board"
    : "Blinking on the board";
  // Photos crossfade quickly while blinking so the LED reads as blinking.
  const fadeMs = done ? 180 : 700;

  // The streamed sketch. On a phone it sits in the conversation, between the
  // agent running and the firmware being applied; on a wide screen it has
  // the right-hand column.
  const codeBlock = (
    <div
      className="rounded-lg border bg-[var(--bg-root)] overflow-hidden transition-[border-color,opacity] duration-500"
      style={{
        opacity: reached(step, "coding") ? 1 : 0.35,
        borderColor: step === "applied" ? "var(--term-success)" : "var(--border-main)",
      }}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-main)] text-[10px] font-mono text-[var(--text-subtle)]">
        <FileCode2 size={11} /> src/main.cpp
      </div>
      <div className="relative">
        <pre className="invisible overflow-hidden text-[10.5px] sm:text-[11px] leading-[1.65] px-3 py-2.5 font-mono whitespace-pre">
          <code>{STORY_CODE}</code>
        </pre>
        <pre className="absolute inset-0 text-[10.5px] sm:text-[11px] leading-[1.65] px-3 py-2.5 font-mono whitespace-pre overflow-hidden text-[var(--text-main)]">
          <code>{renderSketch(codeShown)}</code>
        </pre>
        {/* The agent thinking, before the first line arrives. */}
        {step === "running" && (
          <div className="absolute inset-0 px-3 py-3.5 flex flex-col gap-3">
            {[52, 0, 78, 0, 44, 70, 18, 0, 40, 72, 30, 60, 20].map((w, i) => (
              <div key={i} className={w ? `${reduceMotion ? "bg-[var(--bg-hover)]" : "shimmer"} h-2 rounded` : "h-2"} style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] shadow-2xl overflow-hidden">
      <p className="sr-only">
        A demo of the agent. You ask it to blink the LED connected to pin 4 of an Arduino. The agent runs,
        writes the firmware, applies it to the codespace, compiles it and flashes the board — and the LED,
        dark in the first photo, starts blinking.
      </p>

      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--border-main)] bg-[var(--bg-root)]">
        <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
        <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
        <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
        <span aria-hidden="true" className="ml-2 text-[10px] font-mono text-[var(--text-subtle)] truncate">joint-agent<span className="hidden sm:inline"> — led-demo</span></span>
        <span aria-hidden="true" className="ml-auto flex items-center gap-1.5 text-[10px] font-mono text-[var(--text-subtle)] shrink-0">
          <Cpu size={11} /> Arduino Uno · USB
        </span>
        <button
          onClick={() => setPaused((p) => !p)}
          className="ml-2 w-7 h-7 -mr-1.5 flex items-center justify-center rounded-md text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition shrink-0"
          aria-label={paused ? "Play the demo" : "Pause the demo"}
          title={paused ? "Play" : "Pause"}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
      </div>

      <div aria-hidden="true">
        {/* The bench, on top at every size: the story opens on the dark LED. */}
        <div className="relative aspect-[3/2] sm:aspect-[2/1] overflow-hidden bg-[#1a120c] border-b border-[var(--border-main)]">
          {photosFailed ? (
            // No photos: a drawn LED still carries the off-and-on beat.
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="w-10 h-10 rounded-full"
                style={{
                  transition: `all ${fadeMs}ms ease-out`,
                  background: ledOn ? "radial-gradient(circle, #ffd2c2 0%, #ff4d2e 45%, #b91c1c 100%)" : "#3a2a24",
                  boxShadow: ledOn ? "0 0 40px 14px rgba(255, 77, 46, 0.55)" : "none",
                }}
              />
            </div>
          ) : (<>
            <img
              src="/hero-circuit-off.jpg" width={1024} height={683} alt="" decoding="async"
              onError={() => setPhotosFailed(true)}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <img
              src="/hero-circuit.jpg" width={1800} height={1200} alt="" decoding="async"
              onError={() => setPhotosFailed(true)}
              className="absolute inset-0 w-full h-full object-cover"
              style={{ opacity: ledOn ? 1 : 0, transition: `opacity ${fadeMs}ms ease-out` }}
            />
            {/* A bloom over the LED itself — at (88%, 50%) in both photos, and
                a centred crop keeps it there. */}
            <div
              className="pointer-events-none absolute"
              style={{ left: "88%", top: "50%", width: "34%", aspectRatio: "1", transform: "translate(-50%, -50%)", opacity: ledOn ? 1 : 0, transition: `opacity ${fadeMs}ms ease-out` }}
            >
              <div
                className="w-full h-full rounded-full"
                style={{
                  background: "radial-gradient(circle, rgba(255, 90, 50, 0.5) 0%, rgba(255, 70, 40, 0.16) 38%, transparent 66%)",
                  mixBlendMode: "screen",
                }}
              />
            </div>
          </>)}

          {/* What the agent is doing, on the photo itself, so the story reads
              even when the chat below is out of view on a phone. */}
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 backdrop-blur-sm px-2.5 py-1 text-[10px] font-medium text-white">
            <span
              className={`w-1.5 h-1.5 rounded-full ${(running || step === "flashing") && !reduceMotion ? "animate-pulse" : ""}`}
              style={{ background: done ? "#34d399" : step === "prompt" ? "rgba(255,255,255,0.45)" : "#f97316" }}
            />
            {stepLabel}
          </div>
          <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-full bg-black/55 backdrop-blur-sm px-2.5 py-1 text-[10px] font-mono text-white/85">
            LED · pin 4
            <span
              className="rounded-full px-1.5 py-px text-[9px] font-bold tracking-wider"
              style={{ transition: `background-color ${fadeMs}ms`, background: ledOn ? "#ef4444" : "rgba(255,255,255,0.14)", color: ledOn ? "#fff" : "rgba(255,255,255,0.7)" }}
            >
              {ledOn ? "ON" : "OFF"}
            </span>
          </div>
        </div>

        {/* The conversation and the code, under the photo. */}
        <div className="grid lg:grid-cols-[1fr_1.1fr]">
          <div className="min-w-0 p-4 sm:p-5 flex flex-col gap-3 lg:border-r border-[var(--border-main)]">
            <div className="flex items-start gap-2.5">
              <span className="w-6 h-6 rounded-md bg-[var(--bg-surface)] border border-[var(--border-light)] flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                <UserIcon size={12} />
              </span>
              {/* An invisible copy of the whole prompt holds its final height,
                  so wrapping mid-typing on a phone moves nothing. The caret
                  hides by visibility: animate-pulse owns its opacity. */}
              <p className="relative flex-1 min-w-0 text-[13px] text-[var(--text-main)] leading-relaxed pt-0.5">
                <span className="invisible">{STORY_PROMPT}<span className="inline-block w-1.5 ml-0.5" /></span>
                <span className="absolute inset-0 pt-0.5">
                  {typed}
                  <span
                    className={`inline-block w-1.5 h-3.5 bg-[var(--accent-primary)] align-middle ml-0.5 ${reduceMotion ? "" : "animate-pulse"}`}
                    style={{ visibility: step === "prompt" ? "visible" : "hidden" }}
                  />
                </span>
              </p>
            </div>

            <div className="flex items-start gap-2.5">
              <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-white" style={{ background: "var(--gradient-hero)" }}>
                <Sparkles size={12} />
              </span>
              <div className="flex-1 min-w-0 flex flex-col gap-2.5 pt-1">
                <StatusRow show={reached(step, "running")} busy={running} still={reduceMotion}>
                  {running ? "Agent is running…" : "Agent wrote the firmware"}
                </StatusRow>
                <div className="lg:hidden">{codeBlock}</div>
                <StatusRow show={reached(step, "applied")} busy={false} still={reduceMotion}>
                  Firmware auto-applied to codespace
                </StatusRow>
                <StatusRow show={reached(step, "flashing")} busy={step === "flashing"} still={reduceMotion}>
                  {done ? "Flashed to Arduino Uno" : "Flashing Arduino Uno…"}
                </StatusRow>
              </div>
            </div>

            {/* The flash, as the IDE's terminal prints it. */}
            <div className="hidden sm:block mt-1 rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.7]">
              {STORY_FLASH_LOG.map((line, i) => (
                <div
                  key={line}
                  className="truncate transition-opacity duration-300"
                  style={{
                    opacity: i < logShown ? 1 : 0,
                    color: i === STORY_FLASH_LOG.length - 1 ? "var(--term-success)" : "var(--text-muted)",
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>

          <div className="hidden lg:block min-w-0 p-5">
            {codeBlock}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Works on a phone — a phone showing the IDE's Code section as it looks on
// Android: the sketch on top, the terminal under it printing the flash line
// by line with its timestamps. The lines are the ones a real flash on an
// Android phone printed; it plays once, when it scrolls into view.
// ---------------------------------------------------------------------------
const PHONE_SKETCH = `void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);
  Serial.println("LED ON");
  delay(1000);
  digitalWrite(LED, LOW);
  Serial.println("LED OFF");
  delay(1000);
}`;
const PHONE_SKETCH_TOKENS = tokenizeSketch(PHONE_SKETCH);

const PHONE_LOG: Array<{ at: string; text: string; tone: "info" | "ok" | "serial" }> = [
  { at: "10:41:02", text: "[USB] Transport: WebUSB.", tone: "info" },
  { at: "10:41:03", text: "[USB] Connected: USB serial device (FTDI FT232R).", tone: "ok" },
  { at: "10:41:05", text: "[COMPILER] Sending code to cloud build server…", tone: "info" },
  { at: "10:41:09", text: "[COMPILER] Build succeeded!", tone: "ok" },
  { at: "10:41:10", text: "[FLASH] Resetting board into bootloader…", tone: "info" },
  { at: "10:41:10", text: "[FLASH] Bootloader responded.", tone: "info" },
  { at: "10:41:11", text: "[FLASH] Writing… 100%", tone: "info" },
  { at: "10:41:12", text: "[FLASH] Upload complete — the board is running your code.", tone: "ok" },
  { at: "10:41:13", text: "LED ON", tone: "serial" },
  { at: "10:41:14", text: "LED OFF", tone: "serial" },
];

function PhoneFlashMock() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-[248px] sm:w-[264px]">
      {/* Side buttons */}
      <span className="absolute -left-[3px] top-24 w-[3px] h-10 rounded-l bg-[var(--border-light)]" />
      <span className="absolute -right-[3px] top-20 w-[3px] h-14 rounded-r bg-[var(--border-light)]" />
      <div className="rounded-[2.6rem] border border-[var(--border-light)] bg-[#050507] p-[9px] shadow-2xl">
        <div className="relative rounded-[2.1rem] overflow-hidden bg-[#0b0c10] aspect-[9/19.5] flex flex-col">
          {/* Status bar with the camera cut-out */}
          <div className="relative flex items-center justify-between px-5 pt-2.5 pb-1.5 text-[9px] font-semibold text-white/80 shrink-0">
            <span>10:41</span>
            <span className="absolute left-1/2 top-2 -translate-x-1/2 w-16 h-[18px] rounded-full bg-black" />
            <span className="flex items-center gap-1">
              <span className="w-3 h-1.5 rounded-[2px] border border-white/70" />
            </span>
          </div>
          {/* App header */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/5 shrink-0">
            <img src="/logo.png" alt="" className="w-4 h-4 rounded" />
            <span className="text-[10px] font-semibold text-white/80">Joint-Agent IDE</span>
            <span className="ml-auto flex items-center gap-1 text-[9px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> USB
            </span>
          </div>
          {/* The code, on top */}
          <div className="border-b border-white/5 shrink-0">
            <div className="px-3 py-1 text-[8.5px] font-mono text-white/40 border-b border-white/5">main.cpp</div>
            <pre className="px-3 py-2 font-mono text-[8.5px] leading-[1.55] text-white/85 whitespace-pre overflow-hidden">
              <code>{renderSketch(PHONE_SKETCH.length, PHONE_SKETCH_TOKENS)}</code>
            </pre>
          </div>
          {/* The terminal, under it, filling line by line */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-1 text-[8.5px] font-mono uppercase tracking-wider text-white/40 border-b border-white/5">Terminal</div>
            <div className="flex-1 min-h-0 overflow-hidden px-2.5 py-1.5 font-mono text-[8px] leading-[1.55] space-y-0.5">
              {PHONE_LOG.map((line, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ duration: 0.2, delay: 0.3 + i * 0.45 }}
                  className="flex gap-1.5"
                >
                  <span className="text-white/30 shrink-0">{line.at}</span>
                  <span
                    className="min-w-0 break-words"
                    style={{ color: line.tone === "ok" ? "#34d399" : line.tone === "serial" ? "#fbbf24" : "rgba(255,255,255,0.62)" }}
                  >
                    {line.text}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
          {/* The app's bottom bar, Code selected */}
          <div className="grid grid-cols-3 border-t border-white/5 text-[8px] text-white/45 shrink-0 pb-2">
            <span className="text-center py-1.5">Workspace</span>
            <span className="text-center py-1.5">Agent</span>
            <span className="text-center py-1.5 text-orange-400 bg-orange-500/10">Code</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A genuine 4-step sequence (not decorative numbering) — this is literally
// the order the product operates in.
// ---------------------------------------------------------------------------
const WORKFLOW = [
  { icon: MessageSquare, title: "Describe it", desc: "Tell the agent what you're building, in plain English — no boilerplate to write first." },
  { icon: FileCode2, title: "It writes the firmware", desc: "Real C++ for your board, plus a wired schematic showing exactly how to connect it." },
  { icon: TerminalSquare, title: "Compile & flash", desc: "A real compiler toolchain runs in the cloud, then flashes your ESP32 or Arduino over USB — from a computer or an Android phone." },
  { icon: Activity, title: "Watch it run", desc: "Live serial monitor and plotter, right next to the code that's driving them." },
];

const DIFFERENTIATORS = [
  { icon: Chrome, title: "Nothing to install", desc: "The whole toolchain runs in a browser tab: Chrome or Edge on a computer, Chrome on Android. Reaching USB hardware needs one of those — a browser limit, not ours." },
  { icon: FlaskConical, title: "466 boards, one workspace", desc: "Every ESP32 and AVR board the engine supports, picked from a real catalog — not two hardcoded defaults." },
  { icon: Puzzle, title: "Plugins, when you need them", desc: "Add AI, Web3 and more to a project without leaving the IDE: on-device machine learning with Edge Impulse, on-chain data and wallet connections for Web3." },
];

// The discovery survey offered right after someone joins — the highest-intent
// moment we get, so it's worth asking there rather than in a later email.
//
// EDIT THIS ONE LINE when the form exists: paste the Google Form URL, or a
// custom short link (e.g. https://afrojoint.xyz/survey) pointed at it. Set it
// back to "" to hide the offer entirely — nothing else needs changing.
const SURVEY_URL = import.meta.env.VITE_SURVEY_URL ?? "";

// Additive, not a gate — the app above is already open and usable today.
// This just captures interest from visitors who'd rather be notified at the
// official launch than dig in right now.
function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Something went wrong.");
        setStatus("error");
        return;
      }
      // Hand off to /thanks, which confirms the signup and then opens the
      // discovery survey. Done here rather than inline so the ask gets a whole
      // page instead of a line under a form — this is the highest-intent
      // moment we get with someone.
      if (SURVEY_URL) {
        window.location.assign("/thanks");
        return;
      }
      setStatus("done");
    } catch {
      setErrorMsg("Could not reach the server.");
      setStatus("error");
    }
  };

  if (status === "done") {
    return (
      <div className="flex flex-col items-center gap-3 py-2.5">
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-[var(--success,#22c55e)]">
          <Check size={16} /> You're on the list — we'll email you at launch.
        </div>

        {SURVEY_URL && (
          <div className="max-w-sm text-center border-t border-[var(--border-main)] pt-3">
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              While you're here — what should we build first? Your answers
              genuinely shape what ships.
            </p>
            <a
              href={SURVEY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-2.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline"
            >
              Answer a few questions <ArrowRight size={13} />
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch gap-2 max-w-sm mx-auto">
      <div className="relative flex-1">
        <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-9 pr-3 py-2.5 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
        />
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        className="flex items-center justify-center gap-1.5 text-sm font-semibold text-white px-4 py-2.5 rounded-lg shadow-sm btn-lift disabled:opacity-60 whitespace-nowrap"
        style={{ background: "var(--gradient-accent)" }}
      >
        {status === "submitting" ? <Loader2 size={15} className="animate-spin" /> : <>Join waitlist <Bell size={14} /></>}
      </button>
      {status === "error" && (
        <p className="text-xs text-red-400 sm:absolute sm:mt-11">{errorMsg}</p>
      )}
    </form>
  );
}

// waitlistMode renders the same marketing page with every route into the
// product removed — no Sign In, no Launch, no auth modal — leaving the
// waitlist form as the only thing to do. It's the link you hand out before
// public launch: all the substance, none of the doors.
//
// Sharing one component rather than duplicating the copy into a second page
// means the pitch link can never drift out of sync with the real homepage.
export default function HomePage({
  waitlistMode = false,
  // Set while the pre-launch lock is on. The page still hides Launch — the
  // product is not open — but invited accounts need some door, otherwise a
  // granted VC has no way to sign in and the grant is worthless. Deliberately
  // NOT set on the /waitlist share link, which is handed to people who have no
  // account and should see no sign-in at all.
  inviteSignIn = false,
  // True when someone just signed in, was refused, and was signed back out.
  // Without this they bounce back to this page with no explanation.
  accessDenied = false,
}: { waitlistMode?: boolean; inviteSignIn?: boolean; accessDenied?: boolean }) {
  useDocumentScroll();
  const [authModal, setAuthModal] = useState<AuthMode | null>(null);

  return (
    // h-full, not min-h-screen: #root is height:100%/overflow:hidden for the
    // IDE's fixed-viewport layout, so a min-height here just grows past the
    // root and gets clipped — overflow-y-auto never engages and the page can't
    // be scrolled at all. A definite height makes this a real scroll container.
    <div className="min-h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] overflow-x-hidden relative">
      <div className="absolute inset-0 opacity-70">
        <CircuitBackdrop />
      </div>
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background: "radial-gradient(600px circle at 12% 8%, var(--glow-primary), transparent 60%), radial-gradient(600px circle at 88% 24%, var(--glow-secondary), transparent 60%)"
        }}
      />

      {/* Header */}
      {/* px-4 on phones: at 375px the logo block plus both buttons need more
          width than px-6 leaves, which is what forced the button labels to
          wrap onto two lines. */}
      <header className="relative z-10 px-4 sm:px-6 py-4 flex items-center justify-between gap-2 max-w-6xl mx-auto">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Joint-Agent IDE" className="w-8 h-8 rounded-lg shadow-md" />
          <div className="flex flex-col">
            <span className="font-display font-bold text-sm leading-tight">
              Joint-Agent <span className="gradient-text">IDE</span>
            </span>
            <span className="text-[8px] text-[var(--text-subtle)] font-mono tracking-[0.2em] uppercase">v1.0</span>
          </div>
        </div>
        {!waitlistMode && (
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          <button
            onClick={() => setAuthModal("signin")}
            className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-2 sm:px-3 py-1.5 whitespace-nowrap"
          >
            Sign In
          </button>
          <button
            onClick={() => setAuthModal("signup")}
            className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 sm:px-4 py-1.5 rounded-lg transition shadow-sm btn-lift whitespace-nowrap"
            style={{ background: "var(--gradient-accent)" }}
          >
            {/* Full product name doesn't fit beside Sign In on a phone; the
                page title is right there, so "Launch" carries it alone. */}
            <Zap size={12} /> Launch<span className="hidden sm:inline">&nbsp;Joint-Agent IDE</span>
          </button>
        </div>
        )}
        {waitlistMode && inviteSignIn && (
          <button
            onClick={() => setAuthModal("signin")}
            className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-2 sm:px-3 py-1.5 whitespace-nowrap shrink-0"
          >
            Invited? <span className="text-[var(--accent-primary)]">Sign in</span>
          </button>
        )}
        {waitlistMode && (
          <a
            href="#waitlist"
            className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 sm:px-4 py-1.5 rounded-lg transition shadow-sm btn-lift whitespace-nowrap shrink-0"
            style={{ background: "var(--gradient-accent)" }}
          >
            <Bell size={12} /> Join<span className="hidden sm:inline">&nbsp;waitlist</span>
          </a>
        )}
      </header>

      <main>
      {/* Hero — the claim, then the proof: the story plays full width under
          it, because the payoff is a photo and a photo needs room. */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-12 sm:pt-16 pb-24">
        <motion.div className="text-center max-w-2xl mx-auto" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)] bg-[var(--accent-primary-soft)] border border-[var(--accent-primary)]/20 rounded-full px-3 py-1 mb-6">
            <Sparkles size={11} /> Autonomous Embedded AI Agent
          </div>
          <h1 className="font-display font-bold text-4xl sm:text-5xl leading-[1.1] tracking-tight text-balance">
            One Agent.<br />
            <span className="gradient-text">Your whole hardware stack.</span>
          </h1>
          <p className="mt-5 text-sm sm:text-base text-[var(--text-muted)] max-w-xl mx-auto leading-relaxed text-balance">
            Say what you want your board to do. Joint-Agent writes the firmware, compiles it, flashes it and
            debugs it on real hardware — from one browser tab, on a computer or an Android phone. Auto circuit
            design &amp; simulation, companion apps and Web3/plugin integrations are rolling out next.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {waitlistMode ? (
              <a
                href="#waitlist"
                className="flex items-center gap-1.5 text-sm font-semibold text-white px-5 py-2.5 rounded-lg shadow-lg btn-lift"
                style={{ background: "var(--gradient-accent)", boxShadow: "var(--shadow-glow)" }}
              >
                Join the waitlist <ArrowRight size={15} />
              </a>
            ) : (<>
            <button
              onClick={() => setAuthModal("signup")}
              className="flex items-center gap-1.5 text-sm font-semibold text-white px-5 py-2.5 rounded-lg shadow-lg btn-lift"
              style={{ background: "var(--gradient-accent)", boxShadow: "var(--shadow-glow)" }}
            >
              Launch Joint-Agent IDE <ArrowRight size={15} />
            </button>
            <button
              onClick={() => setAuthModal("signin")}
              className="text-sm font-semibold text-[var(--text-main)] px-5 py-2.5 rounded-lg border border-[var(--border-main)] hover:bg-[var(--bg-hover)] transition"
            >
              Sign In
            </button>
            </>)}
          </div>
          <p className="mt-4 text-[11px] text-[var(--text-subtle)] flex items-center justify-center gap-1.5">
            <Cpu size={12} /> {waitlistMode ? "Launching soon · one email, no spam" : "Free to start · no card required"}
          </p>
        </motion.div>

        {/* min-w-0 keeps the code pane's unwrapped lines from widening the
            page past a phone's viewport. */}
        <motion.div className="min-w-0 mt-12 max-w-4xl mx-auto" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 }}>
          <AgentStory />
          <p className="mt-3 text-center text-[11px] text-[var(--text-subtle)]">
            One prompt, start to finish: the agent writes the sketch, applies it, flashes the Uno — and pin 4 starts blinking.
          </p>
        </motion.div>
      </div>

      {/* Workflow — a real sequence, numbered because the order is the point */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 pb-24">
        <h2 className="font-display font-bold text-xl text-center mb-2 text-balance">From idea to blinking LED, in order</h2>
        <p className="text-xs text-[var(--text-muted)] text-center mb-10">This is the actual loop — not a feature list, the sequence you'll run every time.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {WORKFLOW.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="starter-card bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 text-left relative"
            >
              <span className="absolute top-4 right-4 text-[10px] font-mono text-[var(--text-subtle)]">0{i + 1}</span>
              <div className="w-9 h-9 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-light)] flex items-center justify-center text-[var(--accent-primary)] mb-3">
                <f.icon size={17} />
              </div>
              <h3 className="font-display font-semibold text-sm text-[var(--text-main)] mb-1">{f.title}</h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Differentiators */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {DIFFERENTIATORS.map((d) => (
            <div key={d.title} className="text-left">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white mb-3" style={{ background: "var(--gradient-hero)" }}>
                <d.icon size={15} />
              </div>
              <h3 className="font-display font-semibold text-sm mb-1.5">{d.title}</h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{d.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* On a phone — shipped, so it is stated as working, with the two things
          it needs and the one platform it cannot reach. The log is from a real
          flash on an Android phone. */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-2xl border border-[var(--accent-primary)]/30 bg-[var(--accent-primary-soft)] px-6 sm:px-10 py-8 sm:py-10">
          <div className="grid md:grid-cols-[1.15fr_1fr] gap-10 items-center">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4 }}
            >
              <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)] border border-[var(--accent-primary)]/40 rounded-full px-2.5 py-0.5 mb-3">
                <Smartphone size={11} /> Now on your phone
              </div>
              <h2 className="font-display font-bold text-xl sm:text-2xl mb-3 text-[var(--text-main)] text-balance">
                No laptop? Your phone is the whole workbench.
              </h2>
              <p className="text-xs sm:text-[13px] text-[var(--text-muted)] leading-relaxed max-w-md">
                Plug your board into an Android phone with a USB OTG adapter and open Joint-Agent in Chrome.
                Describe the project, watch it compile, flash it and read the serial monitor — the same loop
                as on a computer, with no computer in it.
              </p>
              <ul className="mt-5 flex flex-wrap gap-2">
                {["Android · Chrome", "USB OTG adapter", "ESP32 & Arduino boards"].map((t) => (
                  <li key={t} className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-main)] bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-full px-3 py-1">
                    <Check size={11} className="text-[var(--accent-primary)]" /> {t}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[11px] text-[var(--text-subtle)] leading-relaxed max-w-md">
                iPhone browsers can't reach USB devices — an Apple limit, not ours. On a Mac, it works in
                Chrome or Edge.
              </p>
            </motion.div>
            <div>
              <PhoneFlashMock />
              <p className="mt-3 text-center text-[10px] text-[var(--text-subtle)]">The lines a real flash printed on an Android phone.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Waitlist — additive on the live homepage; in waitlistMode it is the
          page's only call to action, so it gets the heading that closes. */}
      <section id="waitlist" className="relative z-10 max-w-3xl mx-auto px-6 pb-24 text-center scroll-mt-8">
        <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] px-8 py-10 shadow-xl">
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)] bg-[var(--accent-primary-soft)] border border-[var(--accent-primary)]/20 rounded-full px-3 py-1 mb-4">
            <Bell size={11} /> Get notified at launch
          </div>
          <h2 className="font-display font-bold text-xl mb-2 text-balance">
            {waitlistMode ? "Get early access." : "Not ready to dive in yet?"}
          </h2>
          <p className="text-xs text-[var(--text-muted)] mb-6 max-w-sm mx-auto">
            {waitlistMode
              ? "Joint-Agent IDE is being opened up gradually. Leave your email and we'll let you in as soon as a place is free."
              : "Join the waitlist and we'll email you the moment Joint-Agent IDE officially launches."}
          </p>
          <WaitlistForm />
        </div>
      </section>

      {/* Final CTA — in waitlist mode the section above already carries the
          only call to action, so a second one would just compete with it. */}
      {!waitlistMode && (
      <section className="relative z-10 max-w-3xl mx-auto px-6 pb-24 text-center">
        <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] px-8 py-12 shadow-xl">
          <h2 className="font-display font-bold text-2xl mb-3 text-balance">Your next board is one prompt away.</h2>
          <p className="text-xs text-[var(--text-muted)] mb-6 max-w-sm mx-auto">
            Sign up, connect a board over USB, and have code running on real hardware in the next few minutes.
          </p>
          <button
            onClick={() => setAuthModal("signup")}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white px-6 py-3 rounded-lg shadow-lg btn-lift"
            style={{ background: "var(--gradient-accent)", boxShadow: "var(--shadow-glow)" }}
          >
            Launch Joint-Agent IDE <ArrowRight size={15} />
          </button>
        </div>
      </section>
      )}
      </main>

      {/* pb accounts for iOS home-indicator inset so the last line isn't sitting
          under the gesture bar on a phone. The attribution was previously 10px
          of the faintest token at 70% opacity — legible in theory, invisible in
          practice, so it gets real size and contrast here. */}
      <footer className="relative z-10 text-center px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] text-[10px] text-[var(--text-subtle)] font-mono uppercase tracking-widest">
        <div>Joint-Agent IDE · IoT · Blockchain · AI</div>
        <div className="mt-2.5 text-[12px] normal-case tracking-normal text-[var(--text-muted)]">
          Powered by <span className="font-semibold text-[var(--text-main)]">Ogbontor Engineering Enterprise</span>
        </div>
        <a href="/privacy" className="mt-2 inline-block text-[11px] normal-case tracking-normal text-[var(--text-muted)] hover:text-[var(--text-main)] hover:underline transition">
          Privacy Policy
        </a>
      </footer>

      {/* Never mounted in waitlist mode — AuthModal and OpenOnReturnedError are
          the only things here that call useAuth(), so keeping them out lets
          this page render outside the AuthProvider entirely. */}
      {accessDenied && (
        <div className="fixed inset-x-0 top-0 z-40 px-4 pt-3 flex justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-md w-full rounded-xl border border-[var(--accent-primary)]/40 bg-[var(--bg-panel)] shadow-2xl px-4 py-3 text-center">
            <p className="text-xs text-[var(--text-main)] leading-relaxed">
              That account doesn't have early access yet. Joint-Agent IDE hasn't
              launched — join the waitlist below and we'll let you in as soon as
              a place is free.
            </p>
          </div>
        </div>
      )}

      {(!waitlistMode || inviteSignIn) && (
        <OpenOnReturnedError onOpen={() => setAuthModal((m) => m ?? "signin")} />
      )}
      {(!waitlistMode || inviteSignIn) && authModal && (
        <AuthModal mode={authModal} onClose={() => setAuthModal(null)} onSwitchMode={setAuthModal} />
      )}
    </div>
  );
}
