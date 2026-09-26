import { auth } from "./firebase";

export interface QuotaBlockedInfo {
  tier: "free" | "paid";
  tokensUsed: number;
  tokenCap: number;
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
// trip (and the Gemini call it would otherwise trigger server-side) when the
// user is already known to be capped out.
let lastKnownBlocked: QuotaBlockedInfo | null = null;

export function getLastKnownBlock(): QuotaBlockedInfo | null {
  return lastKnownBlocked;
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
// routes don't touch the Gemini token cap at all.
export async function authedApiRequest(path: string, opts?: { method?: "GET" | "POST"; body?: any; signal?: AbortSignal }): Promise<Response> {
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
  let response = await doFetch();
  if (response.status === 401) response = await doFetch(true);
  return response;
}

type AuthedRequestResult = { response: Response } | { blocked: QuotaBlockedInfo } | { error: string };

// Shared by callAiEndpoint and streamChatEndpoint: attaches the Firebase ID
// token, retries once on a stale/expired token, and normalizes the 402
// "token cap reached" response so callers don't each re-implement this.
async function authedRequest(path: string, body: any, signal?: AbortSignal): Promise<AuthedRequestResult> {
  if (lastKnownBlocked) return { blocked: lastKnownBlocked };

  try {
    let response = await authedFetch(path, body, signal);

    if (response.status === 401) {
      response = await authedFetch(path, body, signal, true);
    }

    if (response.status === 402) {
      const payload = await response.json().catch(() => ({}));
      const info: QuotaBlockedInfo = {
        tier: payload.tier === "paid" ? "paid" : "free",
        tokensUsed: payload.tokensUsed ?? 0,
        tokenCap: payload.tokenCap ?? 0,
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
    return { error: err.message || "Network error." };
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
    return { ok: false, blocked: false, error: err.message || "Malformed response." };
  }
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "project_update"; text: string; projectUpdate: any }
  | { type: "command"; text: string; command: string }
  | { type: "tool_progress"; text: string }
  | { type: "context"; used: number; limit: number }
  | { type: "context_compacted"; summary: string; compactedIds: string[] }
  | { type: "done" };

// For /api/ai/chat specifically — reads the server-sent-events stream and
// invokes onEvent as each chunk arrives, so the UI can render text as it's
// generated instead of waiting for the full response.
export async function streamChatEndpoint(
  path: string,
  body: any,
  onEvent: (event: ChatStreamEvent) => void,
  opts?: { signal?: AbortSignal }
): Promise<{ blocked: boolean; info?: QuotaBlockedInfo; error?: string }> {
  const result = await authedRequest(path, body, opts?.signal);
  if ("blocked" in result) return { blocked: true, info: result.blocked };
  if ("error" in result) return { blocked: false, error: result.error };

  const reader = result.response.body?.getReader();
  if (!reader) return { blocked: false, error: "No response stream." };

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
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          // ignore a malformed chunk rather than aborting the whole stream
        }
      }
    }
    return { blocked: false };
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return { blocked: false, error: err.message || "Stream interrupted." };
  }
}
