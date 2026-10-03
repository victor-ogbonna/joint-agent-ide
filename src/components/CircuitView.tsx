/**
 * schematic.view for an account with circuits (server/circuits.ts): the
 * project's circuit, on the project's board, edited and simulated in
 * place. Play builds main.cpp as the Compile button does and runs it on the
 * circuit; what it prints goes to the app's Serial Monitor.
 *
 * A project with no circuit yet opens with its old schematic converted (or
 * just its board); nothing is saved until the circuit is changed.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import CircuitWorkspace from "../sim/ui/CircuitWorkspace";
import { boardOf, type Diagram } from "../sim/diagram";
import { BOARDS, type BoardId } from "../sim/boards";
import { diagramToLegacy, emptyCircuit, legacyToDiagram, simBoardFor, withBoard } from "../sim/project";
import { createAvrRunner, type Runner } from "../sim/runner";
import { createEsp32Runner } from "../sim/remote";
import { simSession, type SessionHooks, type Starter } from "../sim/session";

/** What a build gave: the program, or why there is none (already shown in the terminal). */
export type SimBuild =
  | { ok: true; data: { format: string; binary: string; bootloader?: string; partitions?: string; boot_app0?: string } }
  | { ok: false; message: string };

export interface CircuitViewProps {
  /** The project's own circuit, or null when it has none yet. */
  circuit: Diagram | null;
  /** The old schematic, shown converted while there is no circuit. */
  components: unknown[];
  connections: unknown[];
  /** The project's board: build target, and the catalog's chip and clock for it when known. */
  boardId: string;
  chip?: string | null;
  fcpu?: number | null;
  boardName: string;
  /** Family, for a board the simulator hasn't: which drawing to show. */
  mcu: "esp32" | "arduino";
  /** The sketch, so an unchanged one isn't built again. */
  code: string;
  /** Builds main.cpp for the board (as Compile does). */
  build: () => Promise<SimBuild>;
  /** Every finished change of the circuit, with its parts and wiring list for the share page and team views. */
  onChange: (next: Diagram, legacy: ReturnType<typeof diagramToLegacy>) => void;
  /** Handed the running simulation's controls once, for the Serial Monitor and the project switch. */
  onSession?: (api: { send: (text: string) => void; stop: () => void }) => void;
  hooks: SessionHooks;
  /** Signs a request to the server (the ESP32 runs there). */
  authToken: () => Promise<string | null>;
  playRequest: number;
  projectName?: string;
}

// The last program built, by board and sketch: Play again (or Restart) on an
// unchanged sketch runs it straight away instead of building it again.
let lastBuild: { key: string; data: Extract<SimBuild, { ok: true }>["data"] } | null = null;

export default function CircuitView(p: CircuitViewProps) {
  const simBoard = simBoardFor(p.boardId, p.chip, p.fcpu);
  // A board the simulator hasn't: the circuit is still shown and edited, on the nearest drawing.
  const shownBoard: BoardId = simBoard ?? (p.circuit ? boardOf(p.circuit)?.board.id : undefined) ?? (p.mcu === "esp32" ? "esp32" : "uno");

  const { diagram, dropped } = useMemo(() => {
    if (p.circuit) return withBoard(p.circuit, shownBoard);
    if (p.components.length || p.connections.length) return legacyToDiagram(p.components, p.connections, shownBoard);
    return { diagram: emptyCircuit(shownBoard), dropped: 0 };
  }, [p.circuit, p.components, p.connections, shownBoard]);

  const playBlocked = simBoard
    ? null
    : `This project's board (${p.boardName}) can't be simulated yet. The simulator runs the ${BOARDS.uno.name}, ${BOARDS.nano.name}, ${BOARDS.mega.name} and ${BOARDS.esp32.name}.`;

  const props = useRef(p);
  props.current = p;

  const start: Starter = useMemo(() => async (circuit, onSerial): Promise<Runner | null> => {
    const cur = props.current;
    const board = simBoardFor(cur.boardId, cur.chip, cur.fcpu);
    if (!board) throw new Error("This project's board can't be simulated yet.");
    const key = `${cur.boardId}\n${cur.code}`;
    let data = lastBuild?.key === key ? lastBuild.data : null;
    if (!data) {
      const built = await cur.build();
      if ("message" in built) throw new Error(built.message);
      data = built.data;
      lastBuild = { key, data };
    }
    if (board === "esp32") {
      if (data.format !== "bin") throw new Error("That build isn't an ESP32 program. Build again and press Play.");
      return createEsp32Runner(circuit, data, onSerial, cur.authToken);
    }
    if (data.format !== "hex") throw new Error("That build isn't an Arduino program. Build again and press Play.");
    let hex: string;
    try { hex = atob(data.binary); } catch { throw new Error("The built program couldn't be read. Build again and press Play."); }
    return createAvrRunner(circuit, hex, onSerial);
  }, []);

  const onSession = p.onSession;
  useEffect(() => {
    onSession?.({ send: (text) => simSession.serialWrite(text), stop: () => simSession.stop() });
  }, [onSession]);

  const onChange = useMemo(() => (next: Diagram) => props.current.onChange(next, diagramToLegacy(next)), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dropped > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-main)] bg-[var(--bg-panel)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <AlertTriangle size={12} className="shrink-0 text-[var(--term-serial)]" />
          {dropped} wire{dropped > 1 ? "s" : ""} or part{dropped > 1 ? "s" : ""} from before couldn't be placed on the {BOARDS[shownBoard].name} and {dropped > 1 ? "are" : "is"} left out.
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CircuitWorkspace
          diagram={diagram}
          onChange={onChange}
          board={shownBoard}
          start={start}
          hooks={p.hooks}
          playBlocked={playBlocked}
          playRequest={p.playRequest}
          title={p.projectName}
        />
      </div>
    </div>
  );
}
