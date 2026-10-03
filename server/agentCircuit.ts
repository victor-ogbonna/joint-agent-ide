/**
 * The agent building circuits, for accounts with circuits (server/circuits.ts):
 * generate_project takes the circuit with the code, from the parts the
 * simulator has (src/sim/agentParts.ts), wired pin to pin on the project's
 * board. With the person's switch off it writes only the code. Accounts
 * without circuits keep the agent exactly as it was.
 */
import { AGENT_PARTS, BOARD_PIN_NAMES } from "../src/sim/agentParts";
import { BOARDS, type BoardId } from "../src/sim/boards";
import { boardOf, parseDiagram, splitPin } from "../src/sim/diagram";
import { simBoardFor, specOfPart } from "../src/sim/project";
import type { ToolSpec } from "./deepseek";

/** "legacy": as before (no circuits). "circuit": the agent builds one. "code": code only. */
export type CircuitMode = "legacy" | "circuit" | "code";

export function circuitModeFor(access: boolean, buildCircuit: unknown): CircuitMode {
  if (!access) return "legacy";
  return buildCircuit === true ? "circuit" : "code";
}

/** The board the circuit is drawn with: the simulator's for the project's board, else the nearest. */
export function circuitBoardFor(boardId: string, chip: string | undefined, fcpu: number | undefined, family: string): BoardId {
  return simBoardFor(boardId, chip ?? null, fcpu ?? null) ?? (family === "esp32" ? "esp32" : "uno");
}

const CODE_AND_DESCRIPTION = {
  code: { type: "string", description: "Complete C++ code (.ino format)." },
  description: { type: "string", description: "A short paragraph describing the generated project." },
};

/** generate_project as each mode has it; "legacy" keeps the original declaration untouched. */
export function projectToolFor(mode: CircuitMode, legacy: ToolSpec): ToolSpec {
  if (mode === "legacy") return legacy;
  if (mode === "code") {
    return {
      type: "function",
      function: {
        name: "generate_project",
        description: "Write the microcontroller code for the current board.",
        parameters: { type: "object", properties: CODE_AND_DESCRIPTION, required: ["code", "description"] },
      },
    };
  }
  return {
    type: "function",
    function: {
      name: "generate_project",
      description: "Write the microcontroller code and build its circuit (the parts and every wire) for the current board, so it can be simulated.",
      parameters: {
        type: "object",
        properties: {
          ...CODE_AND_DESCRIPTION,
          circuit: {
            type: "object",
            description: "The circuit the code runs on: every part, and every wire between two pins. The board itself is 'mcu' and is not listed in parts.",
            properties: {
              parts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Unique id: letters and digits, starting with a letter, e.g. 'led1', 'r1', 'btn1'." },
                    type: { type: "string", enum: AGENT_PARTS.map((p) => p.key), description: "The part's type, from the parts list." },
                    settings: { type: "object", description: "Only the settings the parts list gives for this type, e.g. {\"color\": \"red\"} or {\"value\": \"220\"}." },
                  },
                  required: ["id", "type"],
                },
              },
              connections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string", description: "One end: 'partId:pin' (e.g. 'led1:A') or 'mcu:pin' (e.g. 'mcu:13')." },
                    to: { type: "string", description: "The other end, the same way." },
                  },
                  required: ["from", "to"],
                },
              },
            },
            required: ["parts", "connections"],
          },
        },
        required: ["code", "description", "circuit"],
      },
    },
  };
}

/** The board's pins, as the agent writes them after "mcu:". */
function boardPinsText(board: BoardId): string {
  const names = BOARD_PIN_NAMES[board];
  const notDuplicates = names.filter((n) => !/\.\d+$/.test(n) || /^GND\./.test(n));
  return notDuplicates.join(", ");
}

/** The instructions that replace the old schematic's, when the agent builds circuits. */
export function circuitInstruction(board: BoardId): string {
  const def = BOARDS[board];
  const esp = board === "esp32";
  const parts = AGENT_PARTS.map((p) => {
    const settings = p.settings ? ` Settings: ${Object.entries(p.settings).map(([k, v]) => `${k} (${v})`).join("; ")}.` : "";
    return `- ${p.key}: ${p.name}. Pins: ${p.pins.join(", ")}.${p.pinNotes ? ` ${p.pinNotes}.` : ""}${settings}`;
  }).join("\n");
  return `CIRCUIT — build it with the code, every time you call generate_project. The app draws it on the ${def.name} and simulates it, so it must be wired exactly as the code uses it.

The board is "mcu". Its pins, named exactly as on the ${def.name}: ${boardPinsText(board)}.${esp ? " Digital pins are D<gpio> (D2, D4, D23...); 3V3 is 3.3 V power and VIN 5 V." : " Digital pins are plain numbers (13, not D13); analog pins A0... ; power 5V and 3.3V; ground GND.1, GND.2, GND.3 (all the same ground)."}

Parts you can use (type: name. pins. settings):
${parts}

Rules:
1. Give each part a unique id (letters and digits, starting with a letter: led1, r1, btn1) and a type from the list above. Use only these types. If the project needs a part that isn't in the list, leave it out of the circuit and say so in one line of your reply.
2. A wire joins two pins: { "from": "r1:2", "to": "led1:A" }, or a pin to the board: { "from": "mcu:${esp ? "D4" : "13"}", "to": "r1:1" }. Use the pin names exactly as listed. One wire per connection; a pin may have several wires.
3. Wire every pin the code uses, at the pin number the code uses, and nothing the code doesn't use. The code and the circuit must agree exactly.
4. Power every part: its VCC/VDD/V+ pin to mcu ${esp ? "3V3 (or VIN for 5 V parts such as servos and HC-SR04)" : "5V"}, and every GND/VSS pin to mcu ${esp ? "GND.1" : "GND.1"}.
5. An LED goes through a resistor (220): board pin → resistor → LED A, LED C → GND. A pushbutton: one side (1.l) to the board pin, the other side (2.l) to GND, read with INPUT_PULLUP.
6. I2C parts: SDA to mcu ${esp ? "D21" : board === "mega" ? "SDA" : "A4"} and SCL to mcu ${esp ? "D22" : board === "mega" ? "SCL" : "A5"} (for the OLED: DATA is SDA, CLK is SCL).
7. Changing a project that already has a circuit (shown below when it does): send the whole circuit again, keeping every part and wire that stays, with the same ids, and change only what the request needs.

WIRING in your reply or the description: a bullet list, one connection per line, as before.`;
}

/** When the agent writes only code: no circuit, the wiring said in words. */
export const CODE_ONLY_INSTRUCTION = `CIRCUIT: this person has turned off automatic circuits, so generate_project takes only the code and the description. Don't build a circuit. When wiring matters, give it in the description as a bullet list, one connection per line ("- LED anode -> resistor -> pin 13").`;

/**
 * The project's circuit as it is, for the agent to change rather than redo:
 * its parts by type and settings, and its wires, in the agent's own terms.
 * Built from a checked diagram, never from the text as sent.
 */
export function currentCircuitNote(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  let d;
  try { d = parseDiagram(JSON.stringify(raw)); } catch { return ""; }
  const board = boardOf(d);
  const others = d.parts.filter((p) => p !== board?.part).slice(0, 80);
  if (!others.length && !d.connections.length) return "";
  const id = (who: string) => (who === board?.part.id ? "mcu" : who);
  const parts = others.map((p) => {
    const spec = specOfPart(p);
    const settings = spec?.settings ? Object.keys(spec.settings).filter((k) => p.attrs?.[k]).map((k) => `${k}=${p.attrs![k]}`) : [];
    return `- ${p.id}: ${spec?.key ?? p.type.replace(/^wokwi-/, "")}${settings.length ? ` (${settings.join(", ")})` : ""}`;
  });
  const wires = d.connections.slice(0, 300).map((c) => {
    const a = splitPin(c[0]);
    const b = splitPin(c[1]);
    return a && b ? `- ${id(a[0])}:${a[1]} -> ${id(b[0])}:${b[1]}` : null;
  }).filter(Boolean);
  return `The project's circuit as it is now (keep it, changing only what the request needs):\nParts:\n${parts.join("\n") || "- (none)"}\nWires:\n${wires.join("\n") || "- (none)"}`;
}
