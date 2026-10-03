/**
 * Compiles a sketch for the circuit simulator (admin only while it's being
 * tried out). The simulator runs Arduino Uno, Nano and Mega programs, so
 * only those boards are built here; the program comes back as Intel HEX
 * text for the simulator to load.
 *
 * Builds the same way /api/compile does, with its safeguards: a file path in
 * #include is refused, only known catalogue libraries are fetched, the
 * build runs under the build account, takes its turn in the build queue and
 * is stopped if it runs too long. It doesn't count against anyone's compiles.
 */
import type express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { runBuild, COMPILE_TIMEOUT_MS, fileSystemInclude } from "./buildRun";
import { detectLibDeps, isSafeLibDep } from "./libraryDeps";
import { missingLibraryHint } from "./libraries";
import { scrubToolchainNames } from "./scrub";
import { holdOpen } from "./holdOpen";
import { compilerOptions, handOver } from "./buildUser";
import { buildQueue, ServerBusyError } from "./buildQueue";
import { useBuildCache, readyBuildCache } from "./buildCache";

/** The simulator's boards, by its own names, and their build targets. */
export const SIM_BOARDS: Record<string, string> = {
  uno: "uno",
  nano: "nanoatmega328",
  mega: "megaatmega2560",
};

export const SIM_MAX_CODE_BYTES = 256 * 1024;

/** The platformio.ini for a simulator build: the board, and the libraries its #includes need. */
export function simPlatformioIni(board: string, code: string): string {
  const libs = detectLibDeps(code).filter(isSafeLibDep);
  return `
[env:${board}]
platform = atmelavr
board = ${board}
framework = arduino
lib_deps =
${libs.map((l) => `  ${l}`).join("\n")}
`;
}

export function registerSimRoutes(app: express.Express, requireAdmin: express.RequestHandler, coreDir: string) {
  app.post("/api/admin/sim/compile", requireAdmin, async (req, res) => {
    holdOpen(res);
    const { code, board } = req.body || {};
    // Own keys only: "__proto__" or "constructor" is not a board.
    const target = typeof board === "string" && Object.prototype.hasOwnProperty.call(SIM_BOARDS, board) ? SIM_BOARDS[board] : undefined;
    if (typeof code !== "string" || !code.trim() || !target) {
      return res.status(400).json({ error: "Send the sketch and a board (uno, nano or mega)." });
    }
    if (Buffer.byteLength(code) > SIM_MAX_CODE_BYTES) {
      return res.status(400).json({ error: "That sketch is too big to compile here." });
    }
    const badInclude = fileSystemInclude(code);
    if (badInclude !== null) {
      return res.status(400).json({
        error: `#include "${badInclude.slice(0, 80)}" names a file path. Include a library header instead, like #include <Wire.h>.`,
      });
    }

    const finalCode = code.includes("#include <Arduino.h>") ? code : `#include <Arduino.h>\n${code}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pio_sim_"));
    try {
      fs.mkdirSync(path.join(tempDir, "src"));
      fs.writeFileSync(path.join(tempDir, "src", "main.cpp"), finalCode);
      fs.writeFileSync(path.join(tempDir, "platformio.ini"), simPlatformioIni(target, finalCode) + useBuildCache(tempDir, coreDir));
      let pioPath = path.join(coreDir, "penv", "bin", "pio");
      if (!fs.existsSync(pioPath)) pioPath = "pio";
      handOver(tempDir);
      const { stdout } = await buildQueue.run(async () => {
        const options = await compilerOptions(coreDir);
        readyBuildCache(coreDir, options.uid, options.gid);
        return runBuild(pioPath, ["run"], { cwd: tempDir, ...options, maxBuffer: 1024 * 1024 * 50, timeoutMs: COMPILE_TIMEOUT_MS });
      }, undefined, "admin-simulator");
      const hexFile = path.join(tempDir, ".pio", "build", target, "firmware.hex");
      if (!fs.existsSync(hexFile)) {
        return res.status(500).json({ error: "The build finished but produced no program. Try again." });
      }
      res.json({ success: true, hex: fs.readFileSync(hexFile, "utf8"), stdout: scrubToolchainNames(stdout || "") });
    } catch (err: any) {
      if (err instanceof ServerBusyError) return res.status(503).json({ error: err.message });
      const output = `${err?.stdout || ""}\n${err?.stderr || ""}`;
      res.status(422).json({
        error: err?.timedOut ? err.message : "Compilation failed.",
        output: scrubToolchainNames(output.trim()).split("\n").slice(-60).join("\n"),
        hint: missingLibraryHint(output) || undefined,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
