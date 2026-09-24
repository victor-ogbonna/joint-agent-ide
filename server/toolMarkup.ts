/**
 * Keeping the model's raw tool-call markup out of the chat.
 *
 * DeepSeek sometimes writes a tool call into its TEXT instead of making it,
 * in its own internal markup:
 *
 *   <｜DSML｜function_calls><｜DSML｜invoke name="execute_terminal_command">
 *   <｜DSML｜parameter name="command" string="true">pio device monitor -b 9600
 *   </｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>
 *
 * That was streamed to the browser verbatim and shown to the user as a chat
 * bubble of angle brackets, and the call it described never ran. Every such
 * format opens with "<｜" (full-width bar) or "<|", which ordinary prose and
 * the chat's text never contain — code travels in tool arguments, not text.
 * So everything from that marker on is withheld from the text stream and, at
 * the end, read back as the tool call the model meant to make.
 */

const MARKUP_START = /<\s*[｜|]/;

export class MarkupGuard {
  private hold = "";
  private inMarkup = false;
  /** The withheld markup, for parseTextToolCall(). */
  markup = "";

  constructor(private emit: (text: string) => void) {}

  push(text: string): void {
    if (this.inMarkup) { this.markup += text; return; }
    this.hold += text;
    const at = this.hold.search(MARKUP_START);
    if (at >= 0) {
      this.send(this.hold.slice(0, at));
      this.markup = this.hold.slice(at);
      this.hold = "";
      this.inMarkup = true;
      return;
    }
    // A "<" at the very end may be the first half of a marker split across
    // two deltas. Hold just that back until the next delta settles it.
    const lt = this.hold.lastIndexOf("<");
    if (lt >= 0 && /^<\s*$/.test(this.hold.slice(lt))) {
      this.send(this.hold.slice(0, lt));
      this.hold = this.hold.slice(lt);
    } else {
      this.send(this.hold);
      this.hold = "";
    }
  }

  /** End of stream: release anything held back that turned out to be text. */
  flush(): void {
    if (!this.inMarkup) this.send(this.hold);
    this.hold = "";
  }

  private send(text: string): void {
    if (text) this.emit(text);
  }
}

/**
 * Read a tool call back out of withheld markup. Returns undefined when there
 * is no recognisable invoke — the markup is then simply dropped, which is
 * still better than showing it.
 */
export function parseTextToolCall(markup: string): { name: string; args: Record<string, any> } | undefined {
  const invoke = markup.match(/invoke\s+name\s*=\s*"([^"]+)"/);
  if (!invoke) return undefined;
  const args: Record<string, any> = {};
  const param = /parameter\s+name\s*=\s*"([^"]+)"([^>]*)>([\s\S]*?)<\s*\//g;
  let m: RegExpExecArray | null;
  while ((m = param.exec(markup))) {
    const [, key, attrs, raw] = m;
    const value = raw.trim();
    if (/string\s*=\s*"true"/.test(attrs)) { args[key] = value; continue; }
    try { args[key] = JSON.parse(value); } catch { args[key] = value; }
  }
  return { name: invoke[1], args };
}
