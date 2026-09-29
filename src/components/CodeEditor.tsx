import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Cpu, Play, Zap, Bug, Copy, Check, Download, Sparkles, Wrench, BookOpen, MessageSquareText, Send, X, Library } from "lucide-react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";

interface CodeEditorProps {
  code: string;
  setCode: (c: string) => void;
  onCompile: () => void;
  onFlash: () => void;
  onDebug: () => void;
  isCompiling: boolean;
  isFlashing: boolean;
  isDebugging: boolean;
  autoDetectedMcu: string | null;
  onAutoDetect: () => void;
  appMode: "agentic" | "manual";
  fontSize?: number;
  wordWrap?: boolean;
  /** Agent-Mode's Ask AI: sends a request about the code to the agent chat. */
  onAskAi?: (request: AskAiRequest) => void;
  /** The agent is answering; Ask AI waits for it. */
  askAiBusy?: boolean;
  /** Opens the Libraries panel (both modes). */
  onOpenLibraries?: () => void;
}

export interface AskAiRequest {
  action: "fix" | "explain" | "comment" | "custom";
  /** The user's own question, for "custom". */
  question?: string;
  /** Lines selected in the editor, when there were any. */
  selection?: string;
}

export default function CodeEditor({
  code,
  setCode,
  onCompile,
  onFlash,
  onDebug,
  isCompiling,
  isFlashing,
  isDebugging,
  autoDetectedMcu,
  onAutoDetect,
  appMode,
  fontSize = 14,
  wordWrap = true,
  onAskAi,
  askAiBusy = false,
  onOpenLibraries
}: CodeEditorProps) {
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState("");
  const [askSelection, setAskSelection] = useState("");

  /** What is selected in the editor. Read as the button is pressed, before
   *  focus leaves the code and a phone drops the selection. */
  const captureSelection = () => {
    const ta = canvasRef.current?.querySelector("textarea");
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    setAskSelection(end > start ? ta.value.slice(start, end).trim() : "");
  };

  useEffect(() => {
    if (!askOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!askRef.current?.contains(e.target as Node)) setAskOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAskOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [askOpen]);

  const ask = (action: AskAiRequest["action"]) => {
    if (!onAskAi || askAiBusy) return;
    const question = askQuestion.trim();
    if (action === "custom" && !question) return;
    onAskAi({ action, question: action === "custom" ? question : undefined, selection: askSelection || undefined });
    setAskQuestion("");
    setAskOpen(false);
  };

  // Line numbers array
  const lineCount = code.split("\n").length;
  const lineNumbers = Array.from({ length: Math.max(15, lineCount) }, (_, i) => i + 1);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "main.cpp";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div id="code-editor-panel" className="bg-[var(--bg-root)] flex flex-col h-full w-full relative">
      {/* Top Toolbar */}
      <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0 z-20">
        <div className="flex items-center gap-3">
          {appMode !== "agentic" && (
            <>
              <button
                id="btn-compile"
                onClick={onCompile}
                disabled={isCompiling || isFlashing}
                className="flex items-center gap-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] disabled:opacity-50 text-[var(--text-main)] text-xs font-semibold px-3 py-1.5 rounded-md border border-[var(--border-light)] transition"
                title="Verify & Compile Code"
              >
                {isCompiling ? (
                  <motion.span
                    className="flex text-blue-400"
                    animate={{ rotate: 360, scale: [1, 1.15, 1] }}
                    transition={{ rotate: { duration: 0.9, repeat: Infinity, ease: "linear" }, scale: { duration: 0.9, repeat: Infinity, ease: "easeInOut" } }}
                  >
                    <Play size={12} />
                  </motion.span>
                ) : (
                  <Play size={12} className="text-[var(--text-muted)]" />
                )}
                <span>Compile</span>
              </button>

              <button
                id="btn-flash"
                onClick={onFlash}
                disabled={isCompiling || isFlashing || !autoDetectedMcu}
                className="flex items-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-md transition shadow-sm"
                title={autoDetectedMcu ? "Upload code to microcontroller" : "Auto-detect a board first"}
              >
                {isFlashing ? (
                  <motion.span
                    className="flex text-yellow-300"
                    animate={{ scale: [1, 1.3, 0.9, 1.2, 1], opacity: [1, 0.6, 1, 0.7, 1] }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <Zap size={12} />
                  </motion.span>
                ) : (
                  <Zap size={12} />
                )}
                <span>Flash to Device</span>
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onOpenLibraries && (
            <button
              id="btn-libraries"
              onClick={onOpenLibraries}
              className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded-md transition text-xs font-semibold"
              title="Libraries: search, add or import"
            >
              <Library size={14} />
              <span>Libraries</span>
            </button>
          )}
           <button
            id="btn-copy-code"
            onClick={handleCopy}
            className="p-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded-md transition"
            title="Copy Code to Clipboard"
          >
            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
          </button>
          <button
            id="btn-download-code"
            onClick={handleDownload}
            className="p-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded-md transition"
            title="Download Sketch file"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* Editor Main Canvas */}
      <div ref={canvasRef} className="flex-1 overflow-y-auto bg-[var(--bg-root)] relative">
        <div className="min-w-max flex min-h-full">
          {/* Editor Line Gutter */}
          <div className="bg-[var(--bg-root)] border-r border-[var(--border-main)] select-none text-right py-4 px-3 flex flex-col font-mono text-[11px] text-[var(--text-muted)] min-w-[3rem] shrink-0 sticky left-0 z-10">
            {lineNumbers.map((num) => (
              <span key={num} className="block leading-6 pr-1">
                {num}
              </span>
            ))}
          </div>

          <div className="flex-1 relative min-w-[400px]">
            <Editor
              value={code}
              onValueChange={setCode}
              highlight={code => Prism.highlight(code, Prism.languages.cpp, 'cpp')}
              padding={16}
              style={{
                fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
                fontSize: 13,
                lineHeight: '24px'
              }}
              className="editor-container w-full h-full text-[var(--text-main)] outline-none"
              textareaClassName="focus:outline-none"
            />
          </div>
        </div>

        {/* AI Copilot FAB */}
        {appMode !== "agentic" && (
          <button
            id="btn-floating-debug"
            onClick={onDebug}
            disabled={isDebugging}
            className="absolute bottom-4 right-4 flex items-center gap-1.5 bg-[var(--bg-surface)]/90 backdrop-blur border border-[var(--border-light)] hover:bg-[#2a2d2e] text-orange-600 transition py-1.5 px-3 rounded-md text-xs font-semibold shadow-lg z-20"
            title={appMode === "manual" ? "Generate & cross check code with Ask AI (Gemini)" : "Analyze and fix errors with Gemini"}
          >
            {isDebugging ? (
              <Bug size={14} className="animate-bounce" />
            ) : (
              appMode === "manual" ? <Sparkles size={14} /> : <Bug size={14} />
            )}
            <span>{isDebugging ? "Analyzing..." : (appMode === "manual" ? "Ask AI" : "Debug Code")}</span>
          </button>
        )}
      </div>

      {/* Agent-Mode's Ask AI: pinned to the panel, not the scrolling code, so
          it stays in reach however far down the sketch goes. */}
      {appMode === "agentic" && onAskAi && (
        <div ref={askRef} className="absolute bottom-3 right-3 z-30 flex flex-col items-end gap-2">
          {askOpen && (
            <div
              role="dialog"
              aria-label="Ask AI about this code"
              className="w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3 shadow-2xl animate-slide-up"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <p className="text-xs font-bold text-[var(--text-main)]">Ask AI about this code</p>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    {askSelection
                      ? `About the ${askSelection.split("\n").length} selected line${askSelection.split("\n").length === 1 ? "" : "s"}`
                      : "About the whole sketch. Select lines first to ask about just those."}
                  </p>
                </div>
                <button type="button" onClick={() => setAskOpen(false)} aria-label="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)] shrink-0">
                  <X size={14} />
                </button>
              </div>
              <div className="grid gap-1.5">
                {([
                  ["fix", Wrench, "Fix errors"],
                  ["explain", BookOpen, askSelection ? "Explain these lines" : "Explain this code"],
                  ["comment", MessageSquareText, "Add comments"],
                ] as const).map(([action, Icon, label]) => (
                  <button
                    key={action}
                    type="button"
                    disabled={askAiBusy}
                    onClick={() => ask(action)}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] px-2.5 py-2 text-left text-xs font-medium text-[var(--text-main)] hover:border-orange-500/50 hover:bg-[var(--bg-hover)] transition disabled:opacity-50"
                  >
                    <Icon size={13} className="text-orange-500 shrink-0" /> {label}
                  </button>
                ))}
              </div>
              <form
                className="mt-2 flex items-center gap-1.5"
                onSubmit={(e) => { e.preventDefault(); ask("custom"); }}
              >
                <input
                  value={askQuestion}
                  onChange={(e) => setAskQuestion(e.target.value)}
                  placeholder="Or ask anything about it…"
                  className="flex-1 min-w-0 rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-2.5 py-2 text-xs text-[var(--text-main)] placeholder:text-[var(--text-subtle)] focus:outline-none focus:border-orange-500/60"
                />
                <button
                  type="submit"
                  disabled={askAiBusy || !askQuestion.trim()}
                  aria-label="Ask"
                  className="p-2 rounded-lg text-white disabled:opacity-40"
                  style={{ background: "var(--gradient-hero)" }}
                >
                  <Send size={13} />
                </button>
              </form>
              {askAiBusy && <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">The agent is still answering. Ask again when it's done.</p>}
            </div>
          )}
          <button
            id="btn-ask-ai"
            type="button"
            onPointerDown={captureSelection}
            onClick={() => setAskOpen((o) => !o)}
            aria-expanded={askOpen}
            className="flex items-center gap-1.5 bg-[var(--bg-surface)]/90 backdrop-blur border border-[var(--border-light)] hover:bg-[var(--bg-hover)] text-orange-500 transition py-1.5 px-3 rounded-full text-xs font-semibold shadow-lg"
          >
            <Sparkles size={13} /> Ask AI
          </button>
        </div>
      )}
    </div>
  );
}
