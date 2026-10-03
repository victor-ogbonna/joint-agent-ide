/**
 * A running simulation, as the circuit canvas sees it: what each part shows,
 * the board's own LEDs, time and speed, and a way to press, turn and type.
 *
 * An Arduino board runs right here in the browser (avrInstructions on
 * avr8js). An ESP32 runs on the server and streams the same things back;
 * both look the same from here.
 */
import { Simulation } from "./circuit";
import { PART_MODELS } from "./parts";
import type { Diagram } from "./diagram";

export interface PartView {
  version: number;
  state: object;
}

export interface BoardLeds {
  led13: number;
  tx: boolean;
  rx: boolean;
  version: number;
}

export interface Runner {
  /** The board's id in the diagram it runs. */
  readonly boardPartId: string;
  /** Runs for `realMs` milliseconds of real time (as much as it can in a frame's budget). */
  frame(realMs: number): void;
  /** What each part with a model shows now. */
  views(): Iterable<[string, PartView]>;
  readonly boardLeds: BoardLeds;
  /** Simulated time, in milliseconds. */
  readonly timeMs: number;
  /** Simulated time against real time over the last moments (1 = real time). */
  readonly speed: number;
  readonly shorted: boolean;
  /** A failure that stopped it (shown, then the run ends). */
  readonly error: string | null;
  input(partId: string, name: string, value: unknown): void;
  serialWrite(text: string): void;
  /** A program running elsewhere (an ESP32 on the server) holds still while paused. */
  pause?(): void;
  resume?(): void;
  dispose(): void;
}

/** An Arduino board (ATmega328P or ATmega2560) in the browser, running the program `hex`. */
export function createAvrRunner(diagram: Diagram, hex: string, onSerial: (text: string) => void): Runner {
  const sim = new Simulation(diagram, hex, { models: PART_MODELS, onSerial });
  const budgetMs = 12;
  let speed = 1;
  let acc = { real: 0, sim: 0 };
  let error: string | null = null;
  return {
    boardPartId: sim.boardPart.id,
    frame(realMs: number) {
      if (error) return;
      const want = realMs * (sim.hz / 1000);
      const chunk = sim.hz / 500;
      const deadline = performance.now() + budgetMs;
      let done = 0;
      try {
        while (done < want) {
          const c = Math.min(chunk, want - done);
          sim.advance(c);
          done += c;
          if (performance.now() > deadline) break;
        }
        sim.settle();
      } catch (err: any) {
        error = `The simulation stopped: ${err?.message || err}`;
        return;
      }
      acc.real += realMs;
      acc.sim += (done / sim.hz) * 1000;
      if (acc.real >= 400) {
        speed = acc.sim / acc.real;
        acc = { real: 0, sim: 0 };
      }
    },
    *views() {
      for (const [id, model] of sim.models) yield [id, { version: model.version, state: model.state }];
    },
    get boardLeds() { return sim.boardLeds; },
    get timeMs() { return sim.timeMs; },
    get speed() { return speed; },
    get shorted() { return sim.shorted; },
    get error() { return error; },
    input: (partId, name, value) => sim.input(partId, name, value),
    serialWrite: (text) => sim.serialWrite(text),
    dispose() { /* nothing held outside the page */ },
  };
}
