/**
 * The model's raw tool-call markup must never reach the chat.
 *
 * The fixture is what a user saw in a chat bubble when they asked to
 * "activate serial monitor": the model wrote its tool call as text in its
 * own markup instead of making it. Streamed deltas split anywhere, so every
 * split point is tried.
 */
import { MarkupGuard, parseTextToolCall } from "../server/toolMarkup.ts";
import { toWorkspaceCommand } from "../server/commands.ts";

const B = "｜"; // full-width vertical bar, as DeepSeek writes it
const MARKUP =
  `<${B}DSML${B}function_calls><${B}DSML${B}invoke name="execute_terminal_command">` +
  `<${B}DSML${B}parameter name="command" string="true">pio device monitor -b 9600</${B}DSML${B}parameter>` +
  `</${B}DSML${B}invoke></${B}DSML${B}function_calls>`;

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

function run(chunks) {
  let shown = "";
  const g = new MarkupGuard((t) => { shown += t; });
  for (const c of chunks) g.push(c);
  g.flush();
  return { shown, markup: g.markup };
}

// 1. Markup alone, split at every position: nothing shown, call recovered.
{
  let leaks = 0, lost = 0;
  for (let i = 1; i < MARKUP.length; i++) {
    const { shown, markup } = run([MARKUP.slice(0, i), MARKUP.slice(i)]);
    if (shown) leaks++;
    const call = parseTextToolCall(markup);
    if (call?.name !== "execute_terminal_command" || call.args.command !== "pio device monitor -b 9600") lost++;
  }
  check(leaks === 0, "markup split at every position never reaches the chat", `(${leaks} leaks)`);
  check(lost === 0, "the intended tool call is read back every time", `(${lost} lost)`);
}

// 2. Prose before the markup still shows, and only the prose.
{
  const prose = "Sure — opening the serial monitor now.\n";
  const { shown } = run([prose.slice(0, 10), prose.slice(10) + MARKUP.slice(0, 5), MARKUP.slice(5)]);
  check(shown === prose, "prose ahead of the markup is shown unchanged", JSON.stringify(shown));
}

// 3. Ordinary text is untouched, including a lone "<" and a "<" at a chunk end.
{
  const text = "If x < 5 the LED stays off. Use <Wire.h> for I2C.";
  let allOk = true;
  for (let i = 1; i < text.length; i++) {
    if (run([text.slice(0, i), text.slice(i)]).shown !== text) allOk = false;
  }
  check(allOk, "ordinary text with '<' passes through at every split");
  check(run(["value <"]).shown === "value <", "a trailing '<' at the very end is still shown");
}

// 4. The ASCII-bar spelling is caught too.
{
  const ascii = MARKUP.replaceAll(B, "|");
  check(run([ascii]).shown === "", "the '<|' spelling is withheld as well");
}

// 5. The shell spelling of the monitor maps to the workspace's own command.
check(toWorkspaceCommand("pio device monitor -b 9600") === "monitor", "'pio device monitor -b 9600' means the monitor");
check(toWorkspaceCommand("monitor") === "monitor", "'monitor' stays 'monitor'");
check(toWorkspaceCommand("compile") === "compile", "other workspace commands are unchanged");
check(toWorkspaceCommand("ls -la && cat platformio.ini") === null, "a shell line that is not the monitor is still refused");

console.log(bad ? `\n${bad} failing case(s)` : "\nNo tool-call markup reaches the chat.");
process.exit(bad ? 1 : 0);
