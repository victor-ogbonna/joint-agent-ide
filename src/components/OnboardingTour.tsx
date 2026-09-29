import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, ArrowLeft, ArrowRight } from "lucide-react";

/**
 * A first-visit walk-through: one part of the screen at a time, lit up, with
 * a short card beside it. No library: each step names a `data-tour` element,
 * and may first switch the phone to the section that holds it. A step whose
 * element is not on screen (Manual-Mode has no agent chat, say) is passed
 * over in the direction the user was going, so the tour never points at
 * nothing.
 */
export interface TourStep {
  /** A CSS selector; the first match with a size on screen is lit up. None: a centred card. */
  target?: string;
  title: string;
  body: React.ReactNode;
  /** Runs before the step shows, e.g. switching the phone to the right section. */
  before?: () => void;
}

const PAD = 6;
const GAP = 12;
const SETTLE_MS = 320;

function findTarget(selector?: string): HTMLElement | null {
  if (!selector) return null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export default function OnboardingTour({ steps, onClose, finishAction }: {
  steps: TourStep[];
  /** completed: the user reached the end, rather than skipping. */
  onClose: (completed: boolean) => void;
  /** An optional call to action on the last card, e.g. a first prompt to try. */
  finishAction?: { label: string; onClick: () => void };
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ready, setReady] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const directionRef = useRef<1 | -1>(1);

  const step = steps[index];
  const last = index === steps.length - 1;

  // Show a step: run its setup, let the section settle, then find its element.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setCardPos(null);
    step.before?.();
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (step.target) {
        const el = findTarget(step.target);
        if (!el) {
          // Not on screen here: move on the way the user was going.
          const next = index + directionRef.current;
          if (next >= 0 && next < steps.length) setIndex(next);
          else { setRect(null); setReady(true); }
          return;
        }
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
      setReady(true);
    }, step.before ? SETTLE_MS : 60);
    return () => { cancelled = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Keep the light on the element as the page settles and changes: a phone
  // section's panels finish sizing a moment after they appear, so the first
  // measurement can be tens of pixels off. Re-measured on a short timer as
  // well as on resize and scroll; state only changes when the box moved.
  useEffect(() => {
    if (!ready || !step.target) return;
    const update = () => {
      const el = findTarget(step.target);
      const next = el ? el.getBoundingClientRect() : null;
      setRect((prev) => {
        if (!prev || !next) return next;
        const same = Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 &&
          Math.abs(prev.width - next.width) < 1 && Math.abs(prev.height - next.height) < 1;
        return same ? prev : next;
      });
    };
    const timer = window.setInterval(update, 150);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [ready, step.target]);

  // Place the card beside the element: below it if there is room, else above;
  // centred when there is no element.
  useLayoutEffect(() => {
    if (!ready) return;
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!rect) {
      setCardPos({ top: Math.max(GAP, (vh - ch) / 2), left: Math.max(GAP, (vw - cw) / 2) });
      return;
    }
    const clampTop = (t: number) => Math.max(GAP, Math.min(vh - ch - GAP, t));
    const clampLeft = (l: number) => Math.max(GAP, Math.min(vw - cw - GAP, l));
    const below = rect.bottom + PAD + GAP;
    const above = rect.top - PAD - GAP - ch;
    const right = rect.right + PAD + GAP;
    const left = rect.left - PAD - GAP - cw;
    const middle = rect.top + rect.height / 2 - ch / 2;
    // Below, then above, then beside (a tall panel on a wide screen), and only
    // then over the element itself, when it fills the screen.
    if (below + ch <= vh - GAP) setCardPos({ top: below, left: clampLeft(rect.left + rect.width / 2 - cw / 2) });
    else if (above >= GAP) setCardPos({ top: above, left: clampLeft(rect.left + rect.width / 2 - cw / 2) });
    else if (right + cw <= vw - GAP) setCardPos({ top: clampTop(middle), left: right });
    else if (left >= GAP) setCardPos({ top: clampTop(middle), left });
    else setCardPos({ top: clampTop(middle), left: clampLeft(rect.left + rect.width / 2 - cw / 2) });
  }, [ready, rect, index]);

  useEffect(() => { if (ready) nextRef.current?.focus({ preventScroll: true }); }, [ready, index]);

  const go = useCallback((delta: 1 | -1) => {
    const n = index + delta;
    if (n < 0) return;
    if (n >= steps.length) { onClose(true); return; }
    directionRef.current = delta;
    setIndex(n);
  }, [index, steps.length, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  return (
    <div className="fixed inset-0 z-[70]" aria-live="polite">
      {/* The dimmed page, with a hole cut around the element. It takes the
          taps, so nothing behind it is pressed by accident mid-tour. */}
      {rect ? (
        <div
          className="tour-spotlight pointer-events-none fixed rounded-xl"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(3, 5, 10, 0.72), 0 0 0 2px var(--accent-primary)",
          }}
        />
      ) : (
        <div className="fixed inset-0" style={{ background: "rgba(3, 5, 10, 0.72)" }} />
      )}
      <div className="fixed inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className="fixed w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4 shadow-2xl"
        style={{
          top: cardPos?.top ?? -9999,
          left: cardPos?.left ?? -9999,
          visibility: ready && cardPos ? "visible" : "hidden",
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent-primary)]">
            {index + 1} of {steps.length}
          </p>
          <button type="button" onClick={() => onClose(false)} aria-label="Skip the tour" className="-mt-1 -mr-1 p-1 text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={15} />
          </button>
        </div>
        <h2 id="tour-title" className="mt-1 font-display text-[15px] font-bold text-[var(--text-main)] leading-snug">{step.title}</h2>
        <div className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{step.body}</div>

        {last && finishAction && (
          <button
            type="button"
            onClick={() => { finishAction.onClick(); onClose(true); }}
            className="mt-3 w-full rounded-lg py-2.5 text-[13px] font-bold text-white shadow-md"
            style={{ background: "var(--gradient-hero)" }}
          >
            {finishAction.label}
          </button>
        )}

        <div className="mt-3 flex items-center gap-2">
          {!last && (
            <button type="button" onClick={() => onClose(false)} className="text-[12px] text-[var(--text-subtle)] hover:text-[var(--text-muted)]">
              Skip tour
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => go(-1)}
                className="flex items-center gap-1 rounded-lg border border-[var(--border-main)] px-3 py-2 text-[12px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
              >
                <ArrowLeft size={13} /> Back
              </button>
            )}
            <button
              ref={nextRef}
              type="button"
              onClick={() => go(1)}
              className={`flex items-center gap-1 rounded-lg px-3 py-2 text-[12px] font-bold ${last && finishAction ? "border border-[var(--border-main)] text-[var(--text-main)] hover:bg-[var(--bg-hover)]" : "text-white"}`}
              style={last && finishAction ? undefined : { background: "var(--gradient-hero)" }}
            >
              {last ? "Done" : <>Next <ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
