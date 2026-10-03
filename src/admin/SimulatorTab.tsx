/**
 * The circuit simulator, admin only while it's being tried out. The
 * workspace (and the part drawings it needs) loads only when this tab opens.
 */
import React, { Suspense, lazy, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { unwrapHeldOpen } from "../lib/resilientFetch";
import type { CompileResult } from "../sim/ui/SimWorkspace";
import type { BoardId } from "../sim/boards";

const SimWorkspace = lazy(() => import("../sim/ui/SimWorkspace"));

type AdminPost = (path: string, body: unknown) => Promise<Response | null>;

export default function SimulatorTab({ post }: { post: AdminPost }) {
  const compile = useCallback(async (code: string, board: BoardId): Promise<CompileResult> => {
    const sent = await post("/api/admin/sim/compile", { code, board });
    if (!sent) return { error: "Your admin session expired. Sign in again." };
    const res = await unwrapHeldOpen(sent);
    const data = await res.json().catch(() => ({} as any));
    if (res.ok && typeof data.hex === "string") return { hex: data.hex };
    return { error: data.error || `The compiler answered ${res.status}.`, output: data.output, hint: data.hint };
  }, [post]);

  return (
    <div className="h-[calc(100dvh-98px)] min-h-[520px]">
      <Suspense
        fallback={(
          <div className="flex h-full items-center justify-center gap-2 rounded-xl border border-[var(--border-main)] text-[12px] text-[var(--text-muted)]">
            <Loader2 size={15} className="animate-spin" /> Loading the simulator…
          </div>
        )}
      >
        <SimWorkspace compile={compile} />
      </Suspense>
    </div>
  );
}
