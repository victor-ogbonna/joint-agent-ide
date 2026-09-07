import React, { useState } from "react";
import { motion } from "motion/react";
import { Cpu, Play, Zap, Bug, Copy, Check, Download, Sparkles } from "lucide-react";
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
  wordWrap = true
}: CodeEditorProps) {
  const [copied, setCopied] = useState(false);

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
      <div className="flex-1 overflow-y-auto bg-[var(--bg-root)] relative">
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
    </div>
  );
}
