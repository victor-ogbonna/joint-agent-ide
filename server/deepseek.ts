// ---------------------------------------------------------------------------
// DeepSeek client — OpenAI-compatible, so this is plain fetch rather than
// another SDK dependency.
//
// Hybrid by design: DeepSeek handles chat/generate/debug, Gemini keeps
// /api/ai/transcribe because DeepSeek has no audio input. That split is the
// whole reason this is a separate module instead of a wholesale replacement.
//
// Deliberately no explicit cache management, unlike the Gemini path: DeepSeek
// caches repeated prefixes automatically and bills hits at ~1/50th the input
// rate, so the system instruction sitting at the front of every request is
// already discounted with no cache objects to create, name, or expire.
// ---------------------------------------------------------------------------

import { MarkupGuard, parseTextToolCall } from "./toolMarkup.js";

const BASE_URL = "https://api.deepseek.com";
// The canonical rolling name. "deepseek-v4-flash" was an undocumented alias
// that the API silently resolves to this same model (verified against
// /chat/completions, which echoes the model it actually served) — but only
// "deepseek-flash" and "deepseek-v4-pro" are advertised by /models, so the
// alias is the one that could be retired without warning.
// Rolling means a newer flash release is picked up with no code change.
export const DEEPSEEK_MODEL = "deepseek-flash";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export function isDeepSeekConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  };
}

// Same shape of transient failure Gemini had, so the same narrow policy:
// only overload/rate-limit retries. A bad key or malformed request is not
// transient and should surface immediately rather than after ~6.5s.
const RETRY_DELAYS_MS = [700, 1800, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function postWithRetry(path: string, body: any, label: string): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) return res;

      const detail = await res.text();
      if (!isRetryable(res.status) || attempt === RETRY_DELAYS_MS.length) {
        throw new Error(`DeepSeek ${res.status}: ${detail.slice(0, 400)}`);
      }
      lastErr = new Error(`DeepSeek ${res.status}`);
    } catch (err: any) {
      // A thrown non-retryable error above must not be swallowed into a retry.
      if (/DeepSeek \d{3}:/.test(err?.message || "")) throw err;
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length) break;
    }
    const wait = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400);
    console.warn(`[DeepSeek] ${label} failed (attempt ${attempt + 1}) — retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr;
}

/**
 * Output budget for one reply. 8192 was too small: a whole game for a 20x4
 * LCD, plus the wiring and explanation the same tool call carries, ran out of
 * room mid-call, the half-written arguments could not be parsed, and the user
 * was told "I didn't catch that" while "display hello world" worked fine.
 * A model that refuses the larger budget gets the old one, once, and keeps it.
 */
const LARGE_OUTPUT_TOKENS = 32768;
const SAFE_OUTPUT_TOKENS = 8192;
let maxOutputTokens = LARGE_OUTPUT_TOKENS;

async function postChat(body: any, label: string): Promise<Response> {
  try {
    return await postWithRetry("/chat/completions", { ...body, max_tokens: maxOutputTokens }, label);
  } catch (err: any) {
    const tooLarge = /DeepSeek 400:/.test(err?.message || "") && /max_tokens/i.test(err?.message || "");
    if (!tooLarge || maxOutputTokens === SAFE_OUTPUT_TOKENS) throw err;
    console.warn(`[DeepSeek] max_tokens ${maxOutputTokens} refused; using ${SAFE_OUTPUT_TOKENS} from now on`);
    maxOutputTokens = SAFE_OUTPUT_TOKENS;
    return await postWithRetry("/chat/completions", { ...body, max_tokens: maxOutputTokens }, label);
  }
}

export interface StreamHandlers {
  onText: (delta: string) => void;
  /** Called while a tool call's arguments accumulate, so the UI can show progress. */
  onToolProgress?: (toolName: string, argsSoFar: number) => void;
}

export interface StreamResult {
  toolCall?: { name: string; args: any };
  /** A tool call the model wrote into its text instead of making. Kept apart
   *  from toolCall so the caller decides whether this mode may act on it. */
  textToolCall?: { name: string; args: any };
  /** Whether any text actually reached the user once markup was removed. */
  sentText: boolean;
  /** The reply stopped because it hit the output limit, not because it ended. */
  truncated: boolean;
  outputTokens: number;
}

/**
 * Streams a chat completion, surfacing text deltas as they arrive and
 * accumulating any tool call for the caller to act on once the stream ends.
 *
 * Tool-call deltas arrive fragmented across chunks — the name usually lands
 * once and the JSON arguments dribble in a few characters at a time — so they
 * are accumulated by index and only parsed at the end, when the argument
 * string is finally complete and valid JSON.
 */
export async function streamChat(
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  handlers: StreamHandlers
): Promise<StreamResult> {
  const res = await postChat(
    {
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
      // Ask for usage on the final chunk so token accounting stays exact
      // instead of being estimated from character counts.
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    },
    "chat stream"
  );

  const reader = res.body?.getReader();
  if (!reader) throw new Error("DeepSeek returned no response stream.");

  const decoder = new TextDecoder();
  let buffer = "";
  let outputTokens = 0;
  const partial: Record<number, { name: string; args: string }> = {};
  // Raw tool-call markup never reaches the chat. See server/toolMarkup.ts.
  let sentText = false;
  let finishReason = "";
  const guard = new MarkupGuard((text) => { sentText = true; handlers.onText(text); });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited; keep the trailing fragment for the
    // next read rather than parsing a half-received frame.
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // ignore a malformed frame rather than killing the stream
      }

      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;

      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) guard.push(delta.content);

      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        partial[i] ||= { name: "", args: "" };
        if (tc.function?.name) partial[i].name = tc.function.name;
        if (tc.function?.arguments) partial[i].args += tc.function.arguments;
      }

      // Tool arguments stream in over several seconds and were accumulated in
      // total silence, so the product's core feature — generating code — showed
      // the user nothing at all until it finished. Report honest progress
      // instead: this is a real signal that work is happening, not faked text.
      if (delta.tool_calls?.length && handlers.onToolProgress) {
        const acc = partial[0];
        if (acc?.name) handlers.onToolProgress(acc.name, acc.args.length);
      }
    }
  }

  guard.flush();

  const first = partial[0];
  let toolCall: StreamResult["toolCall"];
  if (first?.name) {
    try {
      toolCall = { name: first.name, args: first.args ? JSON.parse(first.args) : {} };
    } catch (err) {
      // Truncated/invalid arguments: better to drop the call and let the text
      // response stand than to hand the UI a half-parsed project payload.
      console.error(`[DeepSeek] tool call ${first.name} had unparseable arguments:`, err);
    }
  }

  const textToolCall = guard.markup ? parseTextToolCall(guard.markup) : undefined;
  if (guard.markup) {
    console.warn(`[DeepSeek] withheld ${guard.markup.length} chars of tool-call markup from the chat` +
      (textToolCall ? ` (read back as ${textToolCall.name})` : ""));
  }

  const truncated = finishReason === "length";
  if (truncated) console.warn(`[DeepSeek] reply hit the ${maxOutputTokens}-token output limit`);

  return { toolCall, textToolCall, sentText, truncated, outputTokens };
}

/** Non-streaming completion, for the endpoints that just need one JSON blob back. */
export async function completeChat(
  messages: ChatMessage[],
  opts: { jsonMode?: boolean } = {}
): Promise<{ text: string; outputTokens: number }> {
  const res = await postChat(
    {
      model: DEEPSEEK_MODEL,
      messages,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    },
    "completion"
  );
  const data: any = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}
