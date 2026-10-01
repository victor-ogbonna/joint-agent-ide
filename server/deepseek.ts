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

// DEEPSEEK_BASE_URL points it elsewhere: a stand-in service in tests.
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
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
 * Which model answers, and how much it may write. Every plan runs on the
 * same DeepSeek model: PRO replies may run to 40,000 tokens, Free replies to
 * FREE_MAX_OUTPUT_TOKENS. What else separates the plans (the 5-hour
 * allowance, Plan Mode, auto-debug, compiles) is enforced elsewhere.
 */
export interface ModelProfile {
  id: "pro" | "free";
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

/** A Free reply's cap: room for a complete sketch with its wiring, not a whole game. */
export const FREE_MAX_OUTPUT_TOKENS = 5000;
export const FREE_MODEL: ModelProfile = { ...PRO_MODEL, id: "free", maxOutputTokens: FREE_MAX_OUTPUT_TOKENS };

/** The model for a request. */
export function modelFor(free: boolean): ModelProfile {
  return free ? FREE_MODEL : PRO_MODEL;
}

// Same shape of transient failure Gemini had, so the same narrow policy:
// only overload/rate-limit retries. A bad key or malformed request is not
// transient and should surface immediately rather than after ~6.5s.
const RETRY_DELAYS_MS = [700, 1800, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const FATAL = /^\S+ \d{3}:/;

/**
 * When the AI service is busy it holds a request open, sending keep-alive
 * lines instead of a reply, for up to half an hour. Waiting on that in
 * silence is what looked like the agent hanging. So a reply that hasn't
 * started after FIRST_REPLY_MS, or goes quiet for STREAM_IDLE_MS once it has,
 * is stopped with an AiTimeoutError the user can act on. The person is told
 * after WAITING_NOTICE_MS that the service is busy (StreamOptions.onWaiting).
 */
export const FIRST_REPLY_MS = 5 * 60_000;
export const STREAM_IDLE_MS = 2 * 60_000;
export const WAITING_NOTICE_MS = 20_000;
/** A reply that isn't streamed may take this long in all. */
export const COMPLETE_MAX_MS = 10 * 60_000;

export class AiTimeoutError extends Error {
  constructor(public kind: "busy" | "stalled") {
    super(kind === "busy"
      ? "The AI service is very busy right now and didn't start your reply in time."
      : "The AI service stopped sending your reply part-way.");
    this.name = "AiTimeoutError";
  }
}

/** A controller that also stops when `outer` does. */
function linkedController(outer?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}

async function postWithRetry(profile: ModelProfile, path: string, body: any, label: string, signal?: AbortSignal): Promise<Response> {
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
        signal,
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
      // Stopped on purpose (the person left, or the wait ran out): no retry.
      if (signal?.aborted) throw err;
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length) break;
    }
    const wait = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400);
    console.warn(`[${profile.label}] ${label} failed (attempt ${attempt + 1}) — retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw lastErr;
  }
  throw lastErr;
}

/** A model that refuses its configured output cap gets 8192, once, and keeps it. */
const SAFE_OUTPUT_TOKENS = 8192;
const refusedCap = new Set<string>();

async function postChat(profile: ModelProfile, body: any, label: string, signal?: AbortSignal): Promise<Response> {
  const cap = () => refusedCap.has(profile.id) ? Math.min(SAFE_OUTPUT_TOKENS, profile.maxOutputTokens) : profile.maxOutputTokens;
  try {
    return await postWithRetry(profile, "/chat/completions", { ...body, max_tokens: cap() }, label, signal);
  } catch (err: any) {
    const msg = err?.message || "";
    const tooLarge = / 400:/.test(msg) && /max_tokens|max_output|maxOutputTokens/i.test(msg);
    if (!tooLarge || refusedCap.has(profile.id) || profile.maxOutputTokens <= SAFE_OUTPUT_TOKENS) throw err;
    console.warn(`[${profile.label}] max_tokens ${profile.maxOutputTokens} refused; using ${SAFE_OUTPUT_TOKENS} from now on`);
    refusedCap.add(profile.id);
    return await postWithRetry(profile, "/chat/completions", { ...body, max_tokens: cap() }, label, signal);
  }
}

export interface StreamHandlers {
  onText: (delta: string) => void;
  /** Called while a tool call's arguments accumulate, so the UI can show progress. */
  onToolProgress?: (toolName: string, argsSoFar: number) => void;
}

export interface StreamOptions {
  /** Stops the reply (the person left or pressed Stop); it then throws an AbortError. */
  signal?: AbortSignal;
  /** Called once if the AI service hasn't started replying after WAITING_NOTICE_MS. */
  onWaiting?: () => void;
  /** The waits above, shorter in tests. */
  timing?: { firstReplyMs?: number; idleMs?: number; noticeMs?: number };
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
  options: StreamOptions = {},
): Promise<StreamResult> {
  // The watchdog (see FIRST_REPLY_MS): "data:" frames are the reply; the
  // service's keep-alive lines while it's busy are not.
  const controller = linkedController(options.signal);
  const firstReplyMs = options.timing?.firstReplyMs ?? FIRST_REPLY_MS;
  const idleMs = options.timing?.idleMs ?? STREAM_IDLE_MS;
  const noticeMs = options.timing?.noticeMs ?? WAITING_NOTICE_MS;
  const startedAt = Date.now();
  let lastData = 0;
  let noticed = false;
  let timedOut: AiTimeoutError | null = null;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (!lastData) {
      if (!noticed && now - startedAt >= noticeMs) {
        noticed = true;
        try { options.onWaiting?.(); } catch { /* a notice must not stop the reply */ }
      }
      if (now - startedAt >= firstReplyMs) timedOut = new AiTimeoutError("busy");
    } else if (now - lastData >= idleMs) {
      timedOut = new AiTimeoutError("stalled");
    }
    if (timedOut) {
      clearInterval(watchdog);
      controller.abort();
    }
  }, Math.min(1000, Math.max(20, Math.floor(Math.min(firstReplyMs, idleMs, noticeMs) / 4))));
  try {
    return await readChatStream(messages, tools, handlers, profile, controller.signal, () => { lastData = Date.now(); });
  } catch (err) {
    if (timedOut) {
      console.warn(`[${profile.label}] reply stopped: ${timedOut.kind === "busy" ? "the service didn't start it in time" : "the service went quiet part-way"}`);
      throw timedOut;
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

async function readChatStream(
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  handlers: StreamHandlers,
  profile: ModelProfile,
  signal: AbortSignal,
  onData: () => void,
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
    "chat stream",
    signal,
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
      onData();
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

/**
 * Non-streaming completion, for the endpoints that just need one JSON blob
 * back. Stopped by `signal`, or with an AiTimeoutError after COMPLETE_MAX_MS.
 */
export async function completeChat(
  messages: ChatMessage[],
  opts: { jsonMode?: boolean; signal?: AbortSignal; maxMs?: number } = {},
  profile: ModelProfile = PRO_MODEL,
): Promise<{ text: string; outputTokens: number }> {
  const controller = linkedController(opts.signal);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.maxMs ?? COMPLETE_MAX_MS);
  try {
    const res = await postChat(
      profile,
      {
        model: profile.model,
        messages,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      },
      "completion",
      controller.signal,
    );
    const data: any = await res.json();
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (timedOut) throw new AiTimeoutError("busy");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
