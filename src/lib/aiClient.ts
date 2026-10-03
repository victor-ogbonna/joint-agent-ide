import { auth } from "./firebase";
import { fetchWithRetry, isNetworkError, beforeRetry, NETWORK_ERROR_MESSAGE, RETRY_DELAYS_MS } from "./resilientFetch";

export interface QuotaBlockedInfo {
  tier: "free" | "paid";
  tokensUsed: number;
  tokenCap: number;
  /** Why the account is paused: its 5-hour window, a free day, or a PRO billing cycle. */
  reason?: "window" | "day" | "cycle" | null;
  /** When the pause lifts (ms since epoch); null when only the billing date will lift it. */
  resetAt?: number | null;
}

// Flat shape (not a discriminated union) — this project's tsconfig doesn't
// enable strictNullChecks, and TS can't narrow a two-level discriminated
// union (ok, then blocked) without it. Optional fields sidestep that: check
// `ok`/`blocked` and read whichever of data/info/error applies.
export interface AiCallResult<T> {
  ok: boolean;
  blocked: boolean;
  data?: T;
  info?: QuotaBlockedInfo;
  error?: string;
}

// Last-known block status, so a call site can skip a pointless network round
// trip (and the model call it would otherwise trigger server-side) when the
// user is already known to be paused. A pause ends by itself: once its refill
// time has passed it is forgotten and the next call goes through.
let lastKnownBlocked: QuotaBlockedInfo | null = null;

function currentBlock(): QuotaBlockedInfo | null {
  if (lastKnownBlocked?.resetAt && Date.now() >= lastKnownBlocked.resetAt) lastKnownBlocked = null;
  return lastKnownBlocked;
}

export function getLastKnownBlock(): QuotaBlockedInfo | null {
  return currentBlock();
}

export function primeLastKnownBlock(info: QuotaBlockedInfo | null): void {
  lastKnownBlocked = info;
}

export function clearLastKnownBlock(): void {
  lastKnownBlocked = null;
}

async function authedFetch(path: string, body: any, signal?: AbortSignal, forceRefresh = false): Promise<Response> {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in.");
  const idToken = await user.getIdToken(forceRefresh);
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
    signal,
  });
}

// For routes that need auth but not the AI-quota semantics above — compile,
// flash, serial. Plain authenticated fetch (GET or POST) with a single
// retry on a stale/expired token, no 402-blocked handling since these
// routes don't touch the Gemini token cap at all. A dropped connection is
// retried, and a slow answer the server kept alive is unwrapped
// (src/lib/resilientFetch.ts).
export async function authedApiRequest(path: string, opts?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: any; signal?: AbortSignal }): Promise<Response> {
  const method = opts?.method || (opts?.body !== undefined ? "POST" : "GET");
  const doFetch = async (forceRefresh = false) => {
    const user = auth.currentUser;
    if (!user) throw new Error("You must be signed in.");
    const idToken = await user.getIdToken(forceRefresh);
    return fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(opts?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts?.signal,
    });
  };
  let response = await fetchWithRetry(() => doFetch(), opts?.signal);
  if (response.status === 401) response = await fetchWithRetry(() => doFetch(true), opts?.signal);
  return response;
}

type AuthedRequestResult = { response: Response } | { blocked: QuotaBlockedInfo } | { error: string };

// Shared by callAiEndpoint and streamChatEndpoint: attaches the Firebase ID
// token, retries once on a stale/expired token, and normalizes the 402
// "token cap reached" response so callers don't each re-implement this.
async function authedRequest(path: string, body: any, signal?: AbortSignal): Promise<AuthedRequestResult> {
  const known = currentBlock();
  if (known) return { blocked: known };

  try {
    let response = await fetchWithRetry(() => authedFetch(path, body, signal), signal);

    if (response.status === 401) {
      response = await fetchWithRetry(() => authedFetch(path, body, signal, true), signal);
    }

    if (response.status === 402) {
      const payload = await response.json().catch(() => ({}));
      const info: QuotaBlockedInfo = {
        tier: payload.tier === "paid" ? "paid" : "free",
        tokensUsed: payload.tokensUsed ?? 0,
        tokenCap: payload.tokenCap ?? 0,
        reason: payload.reason ?? null,
        resetAt: typeof payload.resetAt === "number" ? payload.resetAt : null,
      };
      lastKnownBlocked = info;
      return { blocked: info };
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return { error: payload.error || `Request failed (${response.status}).` };
    }

    return { response };
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return { error: isNetworkError(err) ? NETWORK_ERROR_MESSAGE : err.message || NETWORK_ERROR_MESSAGE };
  }
}

// For the 3 non-streaming Gemini endpoints (generate/debug/transcribe).
export async function callAiEndpoint<T = any>(path: string, body: any, opts?: { signal?: AbortSignal }): Promise<AiCallResult<T>> {
  const result = await authedRequest(path, body, opts?.signal);
  if ("blocked" in result) return { ok: false, blocked: true, info: result.blocked };
  if ("error" in result) return { ok: false, blocked: false, error: result.error };
  try {
    const data = await result.response.json();
    return { ok: true, blocked: false, data };
  } catch (err: any) {
    return { ok: false, blocked: false, error: isNetworkError(err) ? NETWORK_ERROR_MESSAGE : err.message || "Malformed response." };
  }
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "project_update"; text: string; projectUpdate: any }
  | { type: "command"; text: string; command: string }
  | { type: "tool_progress"; text: string }
  | { type: "context"; used: number; limit: number }
  | { type: "tier"; tier: string }
  | { type: "context_compacted"; summary: string; compactedIds: string[] }
  /** The reply couldn't be written; the text before it says why (Try again). */
  | { type: "failed" }
  | { type: "done" };

// For /api/ai/chat specifically — reads the server-sent-events stream and
// invokes onEvent as each chunk arrives, so the UI can render text as it's
// generated instead of waiting for the full response.
//
// A reply always ends with a "done" event. If the connection drops first (a
// phone network or router cutting it, a laptop sleeping, the server
// restarting for an update), the request is sent again, after onRetry lets
// the caller clear what it showed of the cut-off reply. canRetry says when
// that's still safe; by default, only while nothing but progress has
// arrived. The server stops a reply whose browser has gone, so nothing is
// written twice.
export async function streamChatEndpoint(
  path: string,
  body: any,
  onEvent: (event: ChatStreamEvent) => void,
  opts?: { signal?: AbortSignal; canRetry?: () => boolean; onRetry?: () => void }
): Promise<{ blocked: boolean; info?: QuotaBlockedInfo; error?: string }> {
  for (let attempt = 0; ; attempt++) {
    const result = await authedRequest(path, body, opts?.signal);
    if ("blocked" in result) return { blocked: true, info: result.blocked };
    if ("error" in result) return { blocked: false, error: result.error };

    const reader = result.response.body?.getReader();
    if (!reader) return { blocked: false, error: "No response stream." };

    // Only progress so far: the reply can start again without anything on
    // screen being lost.
    let onlyProgress = true;
    let finished = false;
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const raw of events) {
          // Lines that aren't data (": keep-alive" every few seconds) only
          // keep the connection open.
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue; // ignore a malformed chunk rather than aborting the whole stream
          }
          if (event.type === "done") finished = true;
          else if (event.type !== "tier" && event.type !== "context" && event.type !== "tool_progress") onlyProgress = false;
          try {
            onEvent(event);
          } catch {
            // the page's own handling of one event must not end the stream
          }
        }
      }
      // Ended without its "done": the connection was cut short.
      if (!finished) throw new TypeError("network error");
      return { blocked: false };
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      if (!isNetworkError(err)) return { blocked: false, error: err.message || "Stream interrupted." };
      const mayRetry = attempt < RETRY_DELAYS_MS.length && (opts?.canRetry ? opts.canRetry() : onlyProgress);
      if (!mayRetry) return { blocked: false, error: NETWORK_ERROR_MESSAGE };
      try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
      opts?.onRetry?.();
      await beforeRetry(attempt, opts?.signal);
    }
  }
}
