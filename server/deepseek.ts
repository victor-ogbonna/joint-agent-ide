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

/** Text, or text and images in the OpenAI-compatible parts format. */
export type MessageContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
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

/**
 * Which model answers, and how much it may write. Both are OpenAI-compatible
 * chat endpoints, so one client serves them.
 *
 * PRO_MODEL is DeepSeek V4.1 Flash: subscribers, and free users while their
 * free tokens last. LITE_MODEL answers free users once those tokens are gone:
 * a deliberately less capable and cheaper model, with a much smaller output
 * budget, reached through Gemini's OpenAI-compatible endpoint. LITE_MODEL
 * (env) changes which one without a code change.
 */
export interface ModelProfile {
  id: "pro" | "lite";
  label: string;
  baseUrl: string;
  apiKey: () => string | undefined;
  model: string;
  /** Output cap for one reply. */
  maxOutputTokens: number;
  /** Whether the endpoint accepts stream_options.include_usage. */
  streamUsage: boolean;
}

export const PRO_MODEL: ModelProfile = {
  id: "pro",
  label: "DeepSeek",
  baseUrl: BASE_URL,
  apiKey: () => process.env.DEEPSEEK_API_KEY,
  model: DEEPSEEK_MODEL,
  // 8192 was too small: a whole game for a 20x4 LCD, plus the wiring and
  // explanation the same tool call carries, ran out of room mid-call, the
  // half-written arguments could not be parsed, and the user was told "I
  // didn't catch that" while "display hello world" worked fine.
  maxOutputTokens: 40000,
  streamUsage: true,
};

export const LITE_MAX_OUTPUT_TOKENS = 5000;
export const LITE_MODEL: ModelProfile = {
  id: "lite",
  label: "Gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: () => process.env.GEMINI_API_KEY,
  model: process.env.LITE_MODEL || "gemini-2.5-flash-lite",
  maxOutputTokens: LITE_MAX_OUTPUT_TOKENS,
  // Not relied on: an unsupported option must not break every lite request.
  streamUsage: false,
};

export function isModelConfigured(profile: ModelProfile): boolean {
  return !!profile.apiKey();
}

/**
 * The model for a request. A lite account gets LITE_MODEL; if that model has
 * no key configured, it gets the pro model under the lite output cap rather
 * than an error, so the tier's limits still hold.
 */
export function modelFor(lite: boolean): ModelProfile {
  if (!lite) return PRO_MODEL;
  if (isModelConfigured(LITE_MODEL)) return LITE_MODEL;
  return { ...PRO_MODEL, id: "lite", maxOutputTokens: LITE_MAX_OUTPUT_TOKENS };
}

// Same shape of transient failure Gemini had, so the same narrow policy:
// only overload/rate-limit retries. A bad key or malformed request is not
// transient and should surface immediately rather than after ~6.5s.
const RETRY_DELAYS_MS = [700, 1800, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const FATAL = /^\S+ \d{3}:/;

async function postWithRetry(profile: ModelProfile, path: string, body: any, label: string): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${profile.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${profile.apiKey()}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;

      const detail = await res.text();
      if (!isRetryable(res.status) || attempt === RETRY_DELAYS_MS.length) {
        throw new Error(`${profile.label} ${res.status}: ${detail.slice(0, 400)}`);
      }
      lastErr = new Error(`${profile.label} ${res.status}`);
    } catch (err: any) {
      // A thrown non-retryable error above must not be swallowed into a retry.
      if (FATAL.test(err?.message || "")) throw err;
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length) break;
    }
    const wait = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400);
    console.warn(`[${profile.label}] ${label} failed (attempt ${attempt + 1}) — retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr;
}

/** A model that refuses its configured output cap gets 8192, once, and keeps it. */
const SAFE_OUTPUT_TOKENS = 8192;
const refusedCap = new Set<string>();

async function postChat(profile: ModelProfile, body: any, label: string): Promise<Response> {
  const cap = () => refusedCap.has(profile.id) ? Math.min(SAFE_OUTPUT_TOKENS, profile.maxOutputTokens) : profile.maxOutputTokens;
  try {
    return await postWithRetry(profile, "/chat/completions", { ...body, max_tokens: cap() }, label);
  } catch (err: any) {
    const msg = err?.message || "";
    const tooLarge = / 400:/.test(msg) && /max_tokens|max_output|maxOutputTokens/i.test(msg);
    if (!tooLarge || refusedCap.has(profile.id) || profile.maxOutputTokens <= SAFE_OUTPUT_TOKENS) throw err;
    console.warn(`[${profile.label}] max_tokens ${profile.maxOutputTokens} refused; using ${SAFE_OUTPUT_TOKENS} from now on`);
    refusedCap.add(profile.id);
    return await postWithRetry(profile, "/chat/completions", { ...body, max_tokens: cap() }, label);
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
  /** Tokens the request itself used, as the model counted them. */
  promptTokens: number;
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
  handlers: StreamHandlers,
  profile: ModelProfile = PRO_MODEL,
): Promise<StreamResult> {
  const res = await postChat(
    profile,
    {
      model: profile.model,
      messages,
      stream: true,
      // Ask for usage on the final chunk so token accounting stays exact
      // instead of being estimated from character counts.
      ...(profile.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    },
    "chat stream"
  );

  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${profile.label} returned no response stream.`);

  const decoder = new TextDecoder();
  let buffer = "";
  let outputTokens = 0;
  let promptTokens = 0;
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
      if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;

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
      console.error(`[${profile.label}] tool call ${first.name} had unparseable arguments:`, err);
    }
  }

  const textToolCall = guard.markup ? parseTextToolCall(guard.markup) : undefined;
  if (guard.markup) {
    console.warn(`[${profile.label}] withheld ${guard.markup.length} chars of tool-call markup from the chat` +
      (textToolCall ? ` (read back as ${textToolCall.name})` : ""));
  }

  const truncated = finishReason === "length";
  if (truncated) console.warn(`[${profile.label}] reply hit the output limit`);

  return { toolCall, textToolCall, sentText, truncated, promptTokens, outputTokens };
}

/** Non-streaming completion, for the endpoints that just need one JSON blob back. */
export async function completeChat(
  messages: ChatMessage[],
  opts: { jsonMode?: boolean } = {},
  profile: ModelProfile = PRO_MODEL,
): Promise<{ text: string; outputTokens: number }> {
  const res = await postChat(
    profile,
    {
      model: profile.model,
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
