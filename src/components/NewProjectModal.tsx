import React, { useState, useEffect, useMemo } from "react";
import { X, Plus, Loader2, Search, ChevronLeft, Cpu } from "lucide-react";
import { BoardInfo, MCUType } from "../types";

interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (name: string, board: BoardInfo) => Promise<void> | void;
  initialName?: string;
  mode?: "create" | "import";
  /** Catalogue board id the connected USB device identified itself as, if any. */
  detectedBoardId?: string | null;
  detectedFamily?: MCUType | null;
  detectedName?: string | null;
}

const MAX_VISIBLE_BOARDS = 150;

// Ranked search. A plain substring filter is useless on this catalogue: "mega"
// appears inside ATmega328P, so it matched 190 of the 224 AVR boards and buried
// the actual Arduino Mega under every Uno-class clone. Scoring by WHERE the
// match lands fixes that -- a whole word in the board's name beats a substring
// buried in its MCU part number.
const FIRST_PARTY_VENDOR: Record<string, string> = { arduino: "Arduino", esp32: "Espressif" };

const scoreBoard = (b: BoardInfo, tokens: string[]): number => {
  const id = b.id.toLowerCase();
  const name = b.name.toLowerCase();
  const mcu = (b.mcu || "").toLowerCase();
  const vendor = (b.vendor || "").toLowerCase();
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);

  let total = 0;
  for (const t of tokens) {
    let best: number;
    if (id === t || name === t) best = 1000;
    else if (words.includes(t)) best = 80;
    else if (words.some((w) => w.startsWith(t))) best = 60;
    else if (id.startsWith(t)) best = 55;
    else if (name.includes(t)) best = 40;
    else if (id.includes(t)) best = 35;
    else if (vendor.includes(t)) best = 20;
    else if (mcu.includes(t)) best = 10; // weakest: "mega" lives inside ATmega328P
    else return -1;                      // every token must match somewhere
    total += best;
  }
  // Tie-break toward first-party silicon: "mega" matches the Arduino Mega, the
  // Controllino Mega and the SparkFun Mega Pro equally on name, and the one the
  // person typing it almost always means is Arduino's own.
  if (b.vendor === FIRST_PARTY_VENDOR[b.family]) total += 25;
  return total;
};

const rankBoards = (list: BoardInfo[], query: string): BoardInfo[] => {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return list;
  return list
    .map((b) => ({ b, score: scoreBoard(b, tokens) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score || x.b.name.length - y.b.name.length || x.b.name.localeCompare(y.b.name))
    .map((x) => x.b);
};

export default function NewProjectModal({ onClose, onCreate, initialName, mode = "create", detectedBoardId, detectedFamily, detectedName }: NewProjectModalProps) {
  const [step, setStep] = useState<"name" | "board">("name");
  const [name, setName] = useState(initialName || "");
  const [creating, setCreating] = useState(false);

  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [family, setFamily] = useState<MCUType>(detectedFamily || "esp32");
  const [search, setSearch] = useState("");
  // The board deliberately chosen -- by a click, or by USB detection -- paired
  // with the search query it was chosen under. A choice only survives while
  // that query is unchanged. Keeping it across a retyped search is exactly how
  // searching "mega" and pressing Create produced an Arduino Uno project: the
  // Uno matched "mega" through ATmega328P, sat far down the list out of sight,
  // and stayed selected. Everything below derives from this -- there is no
  // second copy of the selection to fall out of step with the highlight.
  const [pick, setPick] = useState<{ id: string; q: string } | null>(null);

  useEffect(() => {
    fetch("/api/boards")
      .then((r) => r.json())
      .then((data) => setBoards(data.boards || []))
      .catch(() => setBoards([]))
      .finally(() => setBoardsLoading(false));
  }, []);

  const familyBoards = useMemo(() => boards.filter((b) => b.family === family), [boards, family]);
  const otherFamily: MCUType = family === "esp32" ? "arduino" : "esp32";
  const otherMatchCount = useMemo(
    () => (search.trim() ? rankBoards(boards.filter((b) => b.family === otherFamily), search).length : 0),
    [boards, otherFamily, search]
  );
  const ranked = useMemo(() => rankBoards(familyBoards, search), [familyBoards, search]);
  const pickedId = pick && pick.q === search ? pick.id : null;

  const filteredBoards = useMemo(() => {
    const shown = ranked.slice(0, MAX_VISIBLE_BOARDS);
    // The list is capped. Pin a chosen board into view so the cap can never
    // hide the thing the Create button is about to act on.
    if (pickedId && !shown.some((b) => b.id === pickedId)) {
      const hit = ranked.find((b) => b.id === pickedId);
      if (hit) return [hit, ...shown.slice(0, MAX_VISIBLE_BOARDS - 1)];
    }
    return shown;
  }, [ranked, pickedId]);

  // Searching "uno" while the ESP32 tab is active used to show "no boards
  // match" even though the Uno is right there in the other tab. Follow the
  // query instead of making the user guess which tab to be on.
  useEffect(() => {
    if (search.trim() && ranked.length === 0 && otherMatchCount > 0) setFamily(otherFamily);
  }, [search, ranked.length, otherMatchCount, otherFamily]);

  // Preselect the board the USB port actually identified, so plugging in a Mega
  // and hitting New Project does not quietly create an Uno project.
  useEffect(() => {
    if (!detectedBoardId || boards.length === 0) return;
    const hit = boards.find((b) => b.id === detectedBoardId);
    if (!hit) return;
    setFamily(hit.family);
    setSearch("");
    setPick({ id: hit.id, q: "" });
  }, [detectedBoardId, boards]);

  // Derived, never stored: whatever Create acts on is the row that is
  // highlighted, and it is always one of the rows currently on screen.
  const selectedBoard = (pickedId ? filteredBoards.find((b) => b.id === pickedId) : undefined) || filteredBoards[0] || familyBoards[0];
  const selectedBoardId = selectedBoard?.id;

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

            {detectedName && (
              <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
                <Cpu size={11} className="text-[var(--accent-primary)] shrink-0" />
                <span className="truncate">
                  {detectedName.replace(/^Connected:\s*/, "")} is plugged in
                  {detectedBoardId ? " \u2014 preselected below" : ". Pick its exact model below."}
                </span>
              </p>
            )}

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

            {/* Searching "uno" on the ESP32 tab finds two ESP32 boards with
                "Uno" in the name and hides the actual Arduino Uno in the other
                tab. Zero matches switches tabs automatically; when there ARE
                matches, say so rather than silently moving the tab under
                someone who is deliberately browsing ESP32. */}
            {search.trim() && ranked.length > 0 && otherMatchCount > 0 && (
              <button
                type="button"
                onClick={() => setFamily(otherFamily)}
                className="w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition -mt-1"
              >
                {otherMatchCount} {otherFamily === "esp32" ? "ESP32" : "Arduino / AVR"} board{otherMatchCount === 1 ? "" : "s"} also match &ldquo;{search.trim()}&rdquo; &mdash; switch tab
              </button>
            )}

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
                    onClick={() => setPick({ id: board.id, q: search })}
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
