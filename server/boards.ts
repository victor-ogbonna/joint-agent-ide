import { execFile } from "child_process";
import util from "util";
import path from "path";
import fs from "fs";

const execFilePromise = util.promisify(execFile);

export type BoardFamily = "esp32" | "arduino";

export interface BoardInfo {
  id: string;
  name: string;
  mcu: string;
  fcpu: number;
  ram: number;
  rom: number;
  vendor: string;
  platform: string;
  family: BoardFamily;
}

// Scope decision: only these two platforms are pre-cached and compile fully
// offline here — every other PlatformIO platform needs a slow network
// install per board, which is a bad fit for Cloud Run cold starts. See the
// project plan for the full reasoning.
const PLATFORM_FAMILY: Record<string, BoardFamily> = {
  espressif32: "esp32",
  atmelavr: "arduino",
};

export const DEFAULT_BOARD_ID: Record<BoardFamily, string> = {
  esp32: "esp32dev",
  arduino: "uno",
};

let catalog: BoardInfo[] = [];
let catalogById = new Map<string, BoardInfo>();
let loaded = false;

// Computed once at process start and cached in memory — `pio boards
// --json-output` is a ~0.8s local-cache read (not a network call), but
// still too slow to repeat on every request from a board picker UI.
export async function loadBoardCatalog(): Promise<void> {
  try {
    let pioPath = path.join(process.cwd(), ".platformio", "penv", "bin", "pio");
    if (!fs.existsSync(pioPath)) pioPath = "pio";
    const { stdout } = await execFilePromise(pioPath, ["boards", "--json-output"], {
      env: { ...process.env, PLATFORMIO_CORE_DIR: path.join(process.cwd(), ".platformio") },
      maxBuffer: 1024 * 1024 * 20,
    });
    const raw = JSON.parse(stdout);
    catalog = raw
      .filter((b: any) => PLATFORM_FAMILY.hasOwnProperty(b.platform))
      .map((b: any) => ({
        id: b.id,
        name: b.name,
        mcu: b.mcu,
        fcpu: b.fcpu,
        ram: b.ram,
        rom: b.rom,
        vendor: b.vendor || "",
        platform: b.platform,
        family: PLATFORM_FAMILY[b.platform],
      }))
      .sort((a: BoardInfo, b: BoardInfo) => {
        // Pin each family's default board first — e.g. "Espressif ESP32 Dev
        // Module" heads the ESP32 list — since it's what most people are
        // looking for and shouldn't require scrolling through ~240 boards
        // sorted alphabetically to find.
        const aIsDefault = a.id === DEFAULT_BOARD_ID[a.family];
        const bIsDefault = b.id === DEFAULT_BOARD_ID[b.family];
        if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    catalogById = new Map(catalog.map((b) => [b.id, b]));
    loaded = true;
    console.log(`[Boards] Loaded ${catalog.length} boards (espressif32 + atmelavr).`);
  } catch (err) {
    console.error("[Boards] Failed to load board catalog:", err);
  }
}

export function getBoardCatalog(): { boards: BoardInfo[]; loaded: boolean } {
  return { boards: catalog, loaded };
}

export function getBoardById(id: string | undefined | null): BoardInfo | undefined {
  if (!id) return undefined;
  return catalogById.get(id);
}

// Falls back to 'esp32' so any pre-existing caller that never sends a
// boardId (legacy projects, the two hardcoded starter boards) keeps working.
export function boardFamily(boardId: string | undefined | null): BoardFamily {
  return getBoardById(boardId)?.family || "esp32";
}

// Resolves a request's boardId to a real board, falling back to the
// original hardcoded default for the given `mcu` family when boardId is
// missing/unknown (legacy projects created before this feature existed).
export function resolveBoard(boardId: string | undefined | null, mcu: string): BoardInfo {
  const requested = getBoardById(boardId);
  if (requested) return requested;

  const family: BoardFamily = mcu === "esp32" ? "esp32" : "arduino";
  const fallbackId = DEFAULT_BOARD_ID[family];
  const fallback = getBoardById(fallbackId);
  if (fallback) return fallback;

  // Catalog hasn't finished loading yet (e.g. request came in during the
  // brief startup window) — synthesize the same minimal info the old
  // hardcoded templates used, so compile/flash still work.
  return family === "esp32"
    ? { id: "esp32dev", name: "Espressif ESP32 Dev Module", mcu: "ESP32", fcpu: 240000000, ram: 327680, rom: 4194304, vendor: "Espressif", platform: "espressif32", family: "esp32" }
    : { id: "uno", name: "Arduino Uno", mcu: "ATMEGA328P", fcpu: 16000000, ram: 2048, rom: 32256, vendor: "Arduino", platform: "atmelavr", family: "arduino" };
}

// Pin names stay bucketed by family (not per-board) because the schematic
// canvas only has calibrated visuals for exactly 2 boards (see
// SchematicViewer.tsx's ESP32_PIN_OFFSETS/ARDUINO_PIN_OFFSETS) — telling the
// agent a specific board's real GPIO numbering would let it generate wiring
// that doesn't match what's actually drawn.
const FAMILY_PINS: Record<BoardFamily, { pins: string; powerPin: string }> = {
  esp32: {
    pins: "GPIO pins D2, D4, D5, D12, D13, D14, D15, D18, D19, D21, D22, D23, RXD2, TXD2, 3V3, GND, VIN",
    powerPin: "3V3",
  },
  arduino: {
    pins: "digital pins D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, analog pins A0, A1, A2, A3, A4, A5, 5V, 3.3V, GND, VIN",
    powerPin: "5V",
  },
};

// Board-aware replacement for the old 2-way mcuDescription ternary — real
// name/mcu/ram/rom for whichever of the 466 boards was actually selected,
// plus the existing family-bucketed pin list so generated code keeps
// referencing pins that exist on the rendered schematic.
export function describeBoardForPrompt(boardId: string | undefined | null, mcu: string): { description: string; powerPin: string; specs: string; family: BoardFamily } {
  const board = resolveBoard(boardId, mcu);
  const pinInfo = FAMILY_PINS[board.family];
  const specs = `${board.name} (${board.mcu}, ${Math.round(board.fcpu / 1e6)}MHz, ${Math.round(board.ram / 1024)}KB RAM, ${Math.round(board.rom / 1024)}KB Flash)`;
  return {
    description: `${specs}. Pins include ${pinInfo.pins}.`,
    powerPin: pinInfo.powerPin,
    specs,
    family: board.family,
  };
}

// Family-only variant (no per-board specs) — the part of the board
// description that's identical for every board in a family (only 2 values
// exist: esp32, arduino), used for the cacheable system-instruction variant
// in server/geminiCache.ts. The per-board specs stay out of anything cached
// since caching a distinct prompt per specific board (466 of them) isn't
// practical, and get sent fresh per-request instead.
export function describeFamilyForPrompt(family: BoardFamily): { description: string; powerPin: string } {
  const pinInfo = FAMILY_PINS[family];
  return { description: `Pins include ${pinInfo.pins}.`, powerPin: pinInfo.powerPin };
}
