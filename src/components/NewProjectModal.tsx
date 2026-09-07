import React, { useState, useEffect, useMemo } from "react";
import { X, Plus, Loader2, Search, ChevronLeft, Cpu } from "lucide-react";
import { BoardInfo, MCUType } from "../types";

interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (name: string, board: BoardInfo) => Promise<void> | void;
  initialName?: string;
  mode?: "create" | "import";
}

const MAX_VISIBLE_BOARDS = 150;

export default function NewProjectModal({ onClose, onCreate, initialName, mode = "create" }: NewProjectModalProps) {
  const [step, setStep] = useState<"name" | "board">("name");
  const [name, setName] = useState(initialName || "");
  const [creating, setCreating] = useState(false);

  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [family, setFamily] = useState<MCUType>("esp32");
  const [search, setSearch] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState<string>("esp32dev");

  useEffect(() => {
    fetch("/api/boards")
      .then((r) => r.json())
      .then((data) => setBoards(data.boards || []))
      .catch(() => setBoards([]))
      .finally(() => setBoardsLoading(false));
  }, []);

  const familyBoards = useMemo(() => boards.filter((b) => b.family === family), [boards, family]);
  const filteredBoards = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q
      ? familyBoards.filter((b) => b.name.toLowerCase().includes(q) || b.mcu.toLowerCase().includes(q) || b.vendor.toLowerCase().includes(q))
      : familyBoards;
    return matches.slice(0, MAX_VISIBLE_BOARDS);
  }, [familyBoards, search]);

  // Falls back to the current family's first board whenever selectedBoardId
  // doesn't belong to it (e.g. right after switching the ESP32/Arduino tab) —
  // otherwise the Create button could silently target a board from whichever
  // family was selected last, mismatched with what's visually active.
  const selectedBoard = familyBoards.find((b) => b.id === selectedBoardId) || familyBoards[0];

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStep("board");
  };

  const handleCreate = async () => {
    const board = selectedBoard || familyBoards[0];
    if (!board) return;
    setCreating(true);
    try {
      await onCreate(name.trim() || "Untitled Project", board);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)]">
          <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
            {step === "board" && (
              <button type="button" onClick={() => setStep("name")} className="text-[var(--text-muted)] hover:text-[var(--text-main)] -ml-1">
                <ChevronLeft size={16} />
              </button>
            )}
            <Plus size={15} className="text-[var(--accent-primary)]" /> {mode === "import" ? "Import Arduino Project" : "New Project"}
          </h2>
          <button type="button" onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={16} />
          </button>
        </div>

        {step === "name" ? (
          <form onSubmit={handleNameSubmit} className="p-5 space-y-4">
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name (e.g. Smart Thermostat)"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-semibold py-2.5 rounded-lg transition shadow-sm"
              style={{ background: "var(--gradient-accent)" }}
            >
              Next — Choose a board
            </button>
          </form>
        ) : (
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex bg-[var(--bg-root)] p-[3px] rounded-lg border border-[var(--border-main)]">
                {(["esp32", "arduino"] as MCUType[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setFamily(f); setSearch(""); }}
                    className={`px-3 py-1 rounded-md text-[11px] font-semibold transition ${family === f ? "text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                    style={family === f ? { background: "var(--gradient-hero)" } : undefined}
                  >
                    {f === "esp32" ? "ESP32" : "Arduino / AVR"}
                  </button>
                ))}
              </div>
              <span className="text-[10px] font-mono text-[var(--text-subtle)] bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-1.5 py-0.5">
                Framework: Arduino
              </span>
            </div>

            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${familyBoards.length} boards…`}
                className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-8 pr-3 py-2 text-xs text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
              />
            </div>

            <div className="h-64 overflow-y-auto terminal-scrollbar border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)]">
              {boardsLoading ? (
                <div className="h-full flex items-center justify-center text-[var(--text-muted)]">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : filteredBoards.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">No boards match "{search}"</div>
              ) : (
                filteredBoards.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    onClick={() => setSelectedBoardId(board.id)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 transition ${selectedBoardId === board.id ? "bg-[var(--bg-hover)]" : "hover:bg-[var(--bg-hover)]"}`}
                  >
                    <Cpu size={13} className={selectedBoardId === board.id ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-[var(--text-main)] truncate">{board.name}</p>
                      <p className="text-[10px] text-[var(--text-muted)] truncate">{board.mcu} · {board.vendor}</p>
                    </div>
                  </button>
                ))
              )}
            </div>

            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || boardsLoading || !selectedBoard}
              className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-semibold py-2.5 rounded-lg transition disabled:opacity-60 shadow-sm"
              style={{ background: "var(--gradient-accent)" }}
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : `Create on ${selectedBoard?.name || "…"}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
