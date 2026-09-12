import { useEffect, useState } from "react";
import { Check, ArrowRight, Clock } from "lucide-react";
import { useDocumentScroll } from "./useDocumentScroll";

const SURVEY_URL = import.meta.env.VITE_SURVEY_URL ?? "";

// Seconds before the survey opens on its own. Long enough to read the
// confirmation and notice the Skip link — a hard, instant redirect would throw
// people onto a Google Form before they had seen that their signup worked,
// which reads as a broken site rather than a helpful one.
const REDIRECT_SECONDS = 8;

export default function ThanksPage() {
  useDocumentScroll();
  const [left, setLeft] = useState(REDIRECT_SECONDS);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    if (cancelled || !SURVEY_URL) return;
    if (left <= 0) {
      window.location.assign(SURVEY_URL);
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, cancelled]);

  return (
    <div className="min-h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <img src="/logo.png" alt="Joint-Agent IDE" className="w-12 h-12 mx-auto mb-6" />

        <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--success,#22c55e)] mb-4">
          <Check size={15} /> You're on the waitlist
        </div>

        <h1 className="font-display font-bold text-2xl mb-3 text-balance">
          One favour before you go?
        </h1>

        <p className="text-sm text-[var(--text-muted)] leading-relaxed mb-7">
          We're deciding what to build next, and a few minutes from you counts for
          more than any amount of guessing on our side. Five minutes, no wrong
          answers — and honest criticism helps more than encouragement.
        </p>

        {SURVEY_URL ? (
          <>
            <a
              href={SURVEY_URL}
              className="inline-flex items-center justify-center gap-2 w-full text-white text-sm font-semibold py-3 rounded-xl transition shadow-sm"
              style={{ background: "var(--gradient-accent)" }}
            >
              Answer a few questions <ArrowRight size={15} />
            </a>

            <div className="mt-4 min-h-[1.25rem] text-xs text-[var(--text-subtle)]">
              {cancelled ? (
                <a href="/" className="hover:text-[var(--text-main)] transition">Back to the homepage</a>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={12} /> Opening in {left}s ·{" "}
                  <button
                    type="button"
                    onClick={() => setCancelled(true)}
                    className="underline hover:text-[var(--text-main)] transition"
                  >
                    skip
                  </button>
                </span>
              )}
            </div>
          </>
        ) : (
          <a href="/" className="text-xs text-[var(--text-subtle)] hover:text-[var(--text-main)] transition">
            Back to the homepage
          </a>
        )}
      </div>
    </div>
  );
}
