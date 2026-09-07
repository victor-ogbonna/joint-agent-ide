import React, { useState, useRef, useEffect } from "react";
import { Terminal as TerminalIcon, CornerDownLeft, Circle, ChevronRight, X, Trash2, Copy, Check } from "lucide-react";
import { TerminalLine } from "../types";

interface TerminalProps {
  lines: TerminalLine[];
  onExecuteCommand: (command: string) => void;
  onClear: () => void;
  onClose?: () => void;
}

export default function Terminal({ lines, onExecuteCommand, onClear, onClose }: TerminalProps) {
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom on new terminal lines
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  const handleCopy = () => {
    const textToCopy = lines.map(l => l.text).join('\n');
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onExecuteCommand(input.trim());
    setInput("");
  };

  const getLineColor = (type: TerminalLine["type"]) => {
    switch (type) {
      case "success":
        return "text-[var(--term-success)] font-medium";
      case "error":
        return "text-[var(--term-error)] font-semibold";
      case "input":
        return "text-[var(--term-input)] font-mono";
      case "serial":
        return "text-[var(--term-serial)] font-mono";
      default:
        return "text-[var(--text-main)]";
    }
  };

  return (
    <div id="terminal-panel" className="bg-[var(--bg-root)] border border-[var(--border-main)] rounded-xl flex flex-col h-full overflow-hidden shadow-lg font-mono">
      {/* Terminal Title Bar */}
      <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2.5 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-[var(--term-input)]" />
          <span className="font-display font-medium text-[11px] text-[var(--text-main)] uppercase tracking-wider">
            Embedded SDK Terminal
          </span>
        </div>

        {/* Console buttons mock */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
            title="Copy Output"
          >
            {copied ? (
              <><span className="text-green-500">Copied</span> <Check size={12} className="text-green-500" /></>
            ) : (
              <>Copy <Copy size={12} /></>
            )}
          </button>
          <button
            onClick={onClear}
            className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
            title="Clear Screen"
          >
            Clear Screen <X size={12} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-red-500 transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
              title="Delete Terminal"
            >
              <Trash2 size={12} />
            </button>
          )}
          <div className="flex gap-1">
            <Circle size={8} className="fill-red-500 stroke-none" />
            <Circle size={8} className="fill-yellow-500 stroke-none" />
            <Circle size={8} className="fill-green-500 stroke-none" />
          </div>
        </div>
      </div>

      {/* Output Console Lines */}
      <div
        ref={containerRef}
        className="flex-1 p-4 overflow-y-auto space-y-1.5 text-xs leading-normal terminal-scrollbar select-text bg-[var(--bg-root)]"
      >
        {lines.map((line) => (
          <div key={line.id} className="flex items-start gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)] select-none font-mono mt-0.5">{line.timestamp}</span>
            {line.type === "input" && <ChevronRight size={14} className="text-[var(--term-input)] shrink-0 mt-0.5" />}
            <pre className={`whitespace-pre-wrap font-mono flex-1 ${getLineColor(line.type)}`}>
              {line.text}
            </pre>
          </div>
        ))}
        {lines.length === 0 && (
          <div className="text-[var(--text-muted)] text-center py-8 text-[11px]">
            PlatformIO Core Toolchain Idle. Type <span className="text-[var(--term-input)]">help</span> to begin.
          </div>
        )}
      </div>

      {/* Terminal Input Form */}
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--bg-root)] border-t border-[var(--border-main)] flex items-center px-3 py-2 shrink-0"
      >
        <span className="text-[var(--term-input)] mr-2 font-mono text-xs select-none">guest@io-studio:~$</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1 bg-transparent border-0 outline-none text-[var(--text-main)] font-mono text-xs focus:ring-0 placeholder-[var(--text-muted)] min-w-0"
          placeholder="Type 'help', 'compile', 'flash', 'pio system', or 'web3 status'..."
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button
          type="submit"
          className="p-1 hover:bg-[var(--bg-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] transition shrink-0"
        >
          <CornerDownLeft size={12} />
        </button>
      </form>
    </div>
  );
}
