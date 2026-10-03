/**
 * An ESP32 on the simulation server (server/esp32Sim.ts), as a Runner: the
 * chip and the circuit run there, and what each part shows streams back
 * here to be drawn. Presses, turns and typed text go the other way.
 */
import type { Diagram } from "./diagram";
import type { BoardLeds, PartView, Runner } from "./runner";
import { decodeState } from "./stream";

export interface Esp32Firmware {
  binary: string;
  bootloader?: string;
  partitions?: string;
  boot_app0?: string;
}

const READY_TIMEOUT_MS = 45_000;

/** Starts the program on the server; resolves once the chip runs. */
export function createEsp32Runner(
  diagram: Diagram,
  firmware: Esp32Firmware,
  onSerial: (text: string) => void,
  authToken: () => Promise<string | null>,
): Promise<Runner> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const token = await authToken();
      if (!token) { reject(new Error("Sign in to simulate an ESP32.")); return; }
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws/esp32`);
      } catch {
        reject(new Error("Couldn't reach the simulation server."));
        return;
      }
      const views = new Map<string, PartView>();
      let leds: BoardLeds = { led13: 0, tx: false, rx: false, version: 0 };
      let timeMs = 0;
      let speed = 1;
      let shorted = false;
      let error: string | null = null;
      let ready = false;
      let closed = false;
      const send = (msg: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
      const timer = window.setTimeout(() => {
        if (ready) return;
        closed = true;
        ws.close();
        reject(new Error("The ESP32 didn't start in time. Try again in a moment."));
      }, READY_TIMEOUT_MS);

      const runner: Runner = {
        boardPartId: diagram.parts.find((p) => p.type === "wokwi-esp32-devkit-v1")?.id ?? "esp32",
        frame() { /* the server keeps time; frames arrive by themselves */ },
        views: () => views.entries(),
        get boardLeds() { return leds; },
        get timeMs() { return timeMs; },
        get speed() { return speed; },
        get shorted() { return shorted; },
        get error() { return error; },
        input: (part, name, value) => send({ type: "input", part, name, value }),
        serialWrite: (text) => send({ type: "serial", text }),
        pause: () => send({ type: "pause" }),
        resume: () => send({ type: "resume" }),
        dispose() {
          closed = true;
          window.clearTimeout(timer);
          try { ws.close(); } catch { /* already closed */ }
        },
      };

      ws.onopen = () => send({
        type: "start",
        token,
        diagram,
        firmware: { app: firmware.binary, bootloader: firmware.bootloader, partitions: firmware.partitions, bootApp0: firmware.boot_app0 },
      });
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg?.type === "ready") {
          ready = true;
          window.clearTimeout(timer);
          resolve(runner);
        } else if (msg?.type === "frame") {
          if (typeof msg.ms === "number") timeMs = msg.ms;
          if (typeof msg.speed === "number") speed = msg.speed;
          shorted = msg.shorted === true;
          for (const v of Array.isArray(msg.views) ? msg.views : []) {
            if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "number") continue;
            views.set(v[0], { version: v[1], state: decodeState(v[2]) as object });
          }
          if (msg.leds && typeof msg.leds === "object") leds = { led13: Number(msg.leds.led13) || 0, tx: !!msg.leds.tx, rx: !!msg.leds.rx, version: Number(msg.leds.version) || 0 };
        } else if (msg?.type === "serial" && typeof msg.text === "string") {
          onSerial(msg.text);
        } else if (msg?.type === "error") {
          const message = typeof msg.message === "string" ? msg.message : "The simulation stopped.";
          if (!ready) { closed = true; window.clearTimeout(timer); reject(new Error(message)); }
          else error = message;
        }
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        window.clearTimeout(timer);
        if (closed) return;
        closed = true;
        if (!ready) reject(new Error("Couldn't reach the simulation server."));
        else if (!error) error = "The connection to the simulation server was lost.";
      };
    })();
  });
}
