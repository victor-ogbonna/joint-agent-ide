import React, { lazy, type ComponentType } from "react";
import { Loader2 } from "lucide-react";

/**
 * A heavy part of the app (the circuit drawing, the serial plotter's chart,
 * the Web3 panel) downloaded the first time it shows, instead of with the
 * rest of the app, so the app itself opens sooner. Show it inside
 * <Suspense fallback={<PartLoading />}>. A failed download is tried once more
 * after a moment; after that PartFailed shows in its place.
 */
export function lazyPart<P>(load: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(() =>
    load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 1500)).then(load))
      .catch(() => ({ default: PartFailed as ComponentType<P> })),
  );
}

export function PartLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="h-full min-h-[80px] w-full flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {label}
    </div>
  );
}

function PartFailed() {
  return (
    <div className="h-full min-h-[80px] w-full flex flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-[var(--text-muted)]">
      <span>This part couldn't load. Check your connection, then reload the page.</span>
      <button type="button" onClick={() => window.location.reload()} className="rounded-md border border-[var(--border-main)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-main)] hover:bg-[var(--bg-hover)]">
        Reload
      </button>
    </div>
  );
}
