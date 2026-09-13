import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Cpu, Wallet, TerminalSquare, X, Loader2, Zap,
  Mail, Lock, User as UserIcon, ArrowRight, Sparkles,
  MessageSquare, FileCode2, FlaskConical, Activity, Chrome, Bell, Check, Smartphone
} from "lucide-react";
import { useAuth } from "./contexts/AuthContext";
import { useDocumentScroll } from "./useDocumentScroll";

type AuthMode = "signin" | "signup";

function AuthModal({ mode, onClose, onSwitchMode }: { mode: AuthMode; onClose: () => void; onSwitchMode: (m: AuthMode) => void }) {
  const { signInWithEmail, signUpWithEmail, signInWithGoogle, error, clearError } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

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

  const handleGoogle = async () => {
    setGoogleSubmitting(true);
    try {
      await signInWithGoogle();
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
            onClick={handleGoogle}
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
// Hero demo — the actual thesis of the page: a scripted, looping replay of
// the product's core loop (a plain-English request becomes working firmware
// and a wired schematic), so a visitor sees the real value before ever
// signing in.
// ---------------------------------------------------------------------------
const DEMO_PROMPT = "Blink an LED connected to pin 4, once a second";
const DEMO_CODE = `#include <Arduino.h>

#define LED_PIN 4

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(1000);
  digitalWrite(LED_PIN, LOW);
  delay(1000);
}`;

function AgentDemoPanel() {
  // 0: typing prompt, 1: prompt sent (pause), 2: code typing, 3: schematic reveal (hold), then loop
  const [phase, setPhase] = useState(0);
  const [typedPrompt, setTypedPrompt] = useState("");
  const [typedCode, setTypedCode] = useState("");
  const [heroFailed, setHeroFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));

    async function run() {
      while (!cancelled) {
        setPhase(0); setTypedPrompt(""); setTypedCode("");
        for (let i = 1; i <= DEMO_PROMPT.length; i++) {
          if (cancelled) return;
          setTypedPrompt(DEMO_PROMPT.slice(0, i));
          await wait(18);
        }
        await wait(500);
        if (cancelled) return;
        setPhase(2);
        const lines = DEMO_CODE;
        for (let i = 1; i <= lines.length; i += 3) {
          if (cancelled) return;
          setTypedCode(lines.slice(0, i));
          await wait(8);
        }
        setTypedCode(lines);
        await wait(400);
        if (cancelled) return;
        setPhase(3);
        await wait(3200);
      }
    }
    run();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, []);

  return (
    <div className="rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] shadow-2xl overflow-hidden">
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[var(--border-main)] bg-[var(--bg-root)]">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
        <span className="ml-2 text-[10px] font-mono text-[var(--text-subtle)]">joint-agent</span>
      </div>

      {/* The real hardware, held still at the top. Deliberately outside the
          typing loop — it's context for what the agent is driving, not part
          of the choreography, so it shouldn't flicker in and out.
          If the photo is missing we drop the whole band rather than render a
          broken-image icon, which looked worse than having no photo at all. */}
      {!heroFailed && (
        <img
          src="/hero-circuit.jpg"
          alt="An Arduino Uno wired to an LED on a breadboard"
          onError={() => setHeroFailed(true)}
          className="w-full h-28 sm:h-36 lg:h-44 object-cover border-b border-[var(--border-main)]"
        />
      )}

      <div className="p-4 min-h-[120px] flex flex-col justify-end">
        <div className="flex items-start gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-white" style={{ background: "var(--gradient-hero)" }}>
            <MessageSquare size={12} />
          </div>
          <p className="text-xs sm:text-[13px] text-[var(--text-main)] leading-relaxed pt-0.5">
            {typedPrompt}<span className="inline-block w-1.5 h-3.5 bg-[var(--accent-primary)] align-middle ml-0.5 animate-pulse" style={{ opacity: phase === 0 ? 1 : 0 }} />
          </p>
        </div>
      </div>

      {/* Fixed-height code pane.
 
          This used to move the whole page. The block mounted and unmounted with
          an animated height, and the <pre> also grew line by line as the code
          typed, so everything below it shifted on every frame of the loop —
          which on a narrow screen meant the waitlist form crawled up and down
          while you were trying to read or tap it.
 
          Now a full, invisible copy of the sketch reserves the final height and
          the progressively typed copy is laid over it, so the pane is always
          exactly as tall as the finished code no matter which phase the loop is
          in. Only opacity animates. Taking the height from the real content
          rather than a hardcoded pixel value means it stays correct if
          DEMO_CODE or the font size ever changes.
 
          overflow-hidden on the reserving copy matters: with whitespace-pre a
          long line would otherwise widen the container and reintroduce
          horizontal page scroll. */}
      <div className="relative border-t border-[var(--border-main)] bg-[var(--bg-root)]">
        <pre
          aria-hidden="true"
          className="invisible overflow-hidden text-[10.5px] sm:text-[11px] leading-relaxed p-4 font-mono whitespace-pre"
        >
          <code>{DEMO_CODE}</code>
        </pre>
        <motion.pre
          animate={{ opacity: phase >= 2 ? 1 : 0 }}
          transition={{ duration: 0.3 }}
          className="absolute inset-0 text-[10.5px] sm:text-[11px] leading-relaxed p-4 font-mono text-[var(--text-main)] overflow-x-auto whitespace-pre"
        >
          <code>{typedCode}</code>
        </motion.pre>
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
  { icon: TerminalSquare, title: "Compile & flash", desc: "A real PlatformIO toolchain runs in the browser — straight to your ESP32 or Arduino over USB." },
  { icon: Activity, title: "Watch it run", desc: "Live serial monitor and plotter, right next to the code that's driving them." },
];

const DIFFERENTIATORS = [
  { icon: Chrome, title: "Nothing to install", desc: "The whole toolchain runs in the browser tab. Chrome or Edge, since hardware access needs Web Serial — that's a browser limit, not ours." },
  { icon: FlaskConical, title: "466 boards, one workspace", desc: "Every ESP32 and AVR board PlatformIO supports, picked from a real catalog — not two hardcoded defaults." },
  { icon: Wallet, title: "Web3, when you need it", desc: "Bring on-chain data and wallet connections into a project without leaving the IDE." },
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
              While you're here — what should we build first? Five minutes, and it
              genuinely shapes what ships.
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
      {/* Hero */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-14 pb-24 grid lg:grid-cols-[1.05fr_1fr] gap-12 items-center">
        {/* min-w-0: a grid item defaults to min-width:auto, so the code
            panel's long unwrapped lines would otherwise force this column
            wider than the phone viewport and get silently clipped. */}
        <motion.div className="min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)] bg-[var(--accent-primary-soft)] border border-[var(--accent-primary)]/20 rounded-full px-3 py-1 mb-6">
            <Sparkles size={11} /> Autonomous Embedded AI Agent
          </div>
          <h1 className="font-display font-bold text-4xl sm:text-5xl leading-[1.1] tracking-tight text-balance">
            One Agent.<br />
            <span className="gradient-text">Your whole hardware stack.</span>
          </h1>
          <p className="mt-5 text-sm sm:text-base text-[var(--text-muted)] max-w-lg leading-relaxed">
            Joint-Agent IDE is an autonomous agent for embedded development — it writes firmware, compiles,
            debugs, and flashes real hardware from one browser tab, with auto circuit design &amp; simulation,
            companion apps, and Web3/plugin integrations rolling out next.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
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
          <p className="mt-4 text-[11px] text-[var(--text-subtle)] flex items-center gap-1.5">
            <Cpu size={12} /> {waitlistMode ? "Launching soon · one email, no spam" : "Free to start · no card required"}
          </p>
        </motion.div>

        <motion.div className="min-w-0" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 }}>
          <AgentDemoPanel />
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

      {/* Coming next — deliberately NOT in the feature lists above, which
          describe what works today. Phone flashing needs the Bridge Agent and
          has not shipped, so it carries an explicit badge: a visitor must never
          sign up expecting to flash from a phone tonight. On the waitlist page
          it is the strongest reason to leave an email, so it leads with that. */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-2xl border border-[var(--accent-primary)]/30 bg-[var(--accent-primary-soft)] px-6 sm:px-8 py-7">
          <div className="flex flex-col sm:flex-row sm:items-start gap-5">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: "var(--gradient-hero)" }}>
              <Smartphone size={18} />
            </div>
            <div className="flex-1">
              <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)] border border-[var(--accent-primary)]/40 rounded-full px-2.5 py-0.5 mb-2.5">
                Coming next
              </div>
              <h3 className="font-display font-bold text-base sm:text-lg mb-2 text-[var(--text-main)]">
                Build hardware with no laptop at all
              </h3>
              <p className="text-xs sm:text-[13px] text-[var(--text-muted)] leading-relaxed max-w-2xl">
                An OTG cable will turn any Android phone into the whole workbench — describe
                the project, watch it compile, flash it to the board. No computer in the loop.
                {waitlistMode
                  ? " If you have a phone and no laptop, this is the release to wait for."
                  : " Flashing needs a desktop browser today; the Bridge Agent removes that."}
              </p>
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

      {/* Never mounted in waitlist mode — AuthModal is the only thing here that
          calls useAuth(), so keeping it out lets this page render outside the
          AuthProvider entirely. */}
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

      {(!waitlistMode || inviteSignIn) && authModal && (
        <AuthModal mode={authModal} onClose={() => setAuthModal(null)} onSwitchMode={setAuthModal} />
      )}
    </div>
  );
}
