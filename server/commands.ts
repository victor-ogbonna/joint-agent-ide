/**
 * What the agent and the terminal endpoint are each allowed to run.
 *
 * Kept out of server.ts so it can be tested without booting the server.
 */
/**
 * Every command the workspace can actually run. The agent's tool used to be
 * described to the model as "execute a bash command", so it wrote shell
 * one-liners chaining pwd, ls and find with && — which the
 * workspace could not run and which printed the build system into the user's
 * chat on the way to being rejected. Describing the tool honestly, and
 * checking against this list before anything reaches the browser, makes that
 * impossible rather than merely discouraged.
 */
export const WORKSPACE_COMMANDS = [
  "help", "compile", "flash", "clear", "engine", "web3 status", "ret",
  "monitor", "serial monitor",
] as const;

export function isWorkspaceCommand(command: string): boolean {
  return (WORKSPACE_COMMANDS as readonly string[]).includes(String(command || "").trim().toLowerCase());
}

export const ALLOWED_COMMAND_PREFIXES = ['pio', 'platformio', 'ls', 'cat', 'echo', 'pwd', 'which'];

// Shell syntax that smuggles a second command past a first-word check, plus
// substitution and redirection. `pwd && find / -name ...` passed the old
// version because only "pwd" was ever examined.
const SHELL_ESCAPES = /[`$<>]/;

export function isCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_ESCAPES.test(trimmed)) return false;
  // Every segment of a chain has to stand on its own, not just the first.
  const segments = trimmed.split(/&&|\|\||[;|]/);
  return segments.every((segment) => {
    const firstWord = segment.trim().split(/\s+/)[0];
    if (!firstWord) return false;
    // Check the basename too, in case of absolute paths like /path/to/pio
    const basename = firstWord.split('/').pop() || firstWord;
    return ALLOWED_COMMAND_PREFIXES.includes(basename);
  });
}
