/**
 * The simulated board's Serial: what the program prints, and a line to
 * type back to it. Also shows the compiler's messages when a build fails.
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { Send, Eraser, AlertTriangle, TerminalSquare } from "lucide-react";

export interface BuildProblem {
  error: string;
  output?: string;
  hint?: string;
}

interface Props {
  text: string;
  problem: BuildProblem | null;
  tab: "serial" | "output";
  onTab: (t: "serial" | "output") => void;
  canSend: boolean;
  onSend: (line: string) => void;
  onClear: () => void;
}

export default function SerialMonitor({ text, problem, tab, onTab, canSend, onSend, onClear }: Props) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [line, setLine] = useState("");

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, tab, problem]);

  const send = () => {
    if (!canSend) return;
    onSend(`${line}\n`);
    setLine("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-panel)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-main)] px-2">
        {(["serial", "output"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            className={`flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[11px] font-medium transition ${tab === t ? "border-[var(--accent-primary)] text-[var(--text-main)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
          >
            {t === "serial" ? <TerminalSquare size={12} /> : <AlertTriangle size={12} className={problem ? "text-[var(--term-error)]" : ""} />}
            {t === "serial" ? "Serial Monitor" : "Build output"}
          </button>
        ))}
        {tab === "serial" && (
          <button type="button" onClick={onClear} className="ml-auto rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]" title="Clear" aria-label="Clear the serial monitor">
            <Eraser size={13} />
          </button>
        )}
      </div>
      <pre
        ref={box}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-5 text-[var(--text-main)]"
        aria-live="off"
      >
        {tab === "serial" && (text || <span className="text-[var(--text-subtle)]">What the program prints with Serial appears here.</span>)}
        {tab === "output" && (problem ? (
          <>
            <span className="text-[var(--term-error)]">{problem.error}</span>
            {problem.hint && <>{"\n"}<span className="text-[var(--term-serial)]">{problem.hint}</span></>}
            {problem.output && <>{"\n\n"}{problem.output}</>}
          </>
        ) : <span className="text-[var(--text-subtle)]">Compiler messages appear here.</span>)}
      </pre>
      {tab === "serial" && (
        <form className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border-main)] p-1.5" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            disabled={!canSend}
            placeholder={canSend ? "Type a message for Serial, then Enter" : "Start the simulation to type to Serial"}
            className="min-w-0 flex-1 rounded-md border border-[var(--border-main)] bg-[var(--bg-surface)] px-2 py-1 font-mono text-[12px] text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-60"
          />
          <button type="submit" disabled={!canSend} className="rounded-md bg-[var(--accent-primary)] p-1.5 text-white transition hover:opacity-90 disabled:opacity-40" aria-label="Send">
            <Send size={13} />
          </button>
        </form>
      )}
    </div>
  );
}
