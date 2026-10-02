/**
 * Requests that ride out a dropped connection.
 *
 * "Failed to fetch" (or "network error" part-way through a reply) means the
 * connection failed, not that the server said no: a phone network or router
 * dropped it, the laptop slept, or the server was restarting for an update.
 * Asking again a moment later almost always works, so these requests do that
 * by themselves, waiting for the device to come back online first, before
 * telling anyone something went wrong.
 *
 * Slow answers (a compile, an AI fix) are kept alive by the server
 * (server/holdOpen.ts); unwrapHeldOpen turns them back into the response the
 * route meant to send.
 */

/** Shown when the connection still fails after every retry. */
export const NETWORK_ERROR_MESSAGE = "Couldn't reach Joint-Agent. Check your internet connection, then try again.";

/**
 * Waits before each retry: five more tries over about 30 seconds, long
 * enough to ride out the server restarting for an update.
 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Whether an error is the browser reporting a failed connection: fetch() and
 * reading a response body reject with a TypeError for that, whatever the
 * browser's wording ("Failed to fetch", "network error", "Load failed",
 * "NetworkError when attempting to fetch resource"). Only for errors from
 * fetch() or a body read; never an abort.
 */
export function isNetworkError(err: unknown): boolean {
  if (!err || (err as any).name === "AbortError") return false;
  if (err instanceof TypeError) return true;
  // Also Firebase's own wording when refreshing the sign-in token fails.
  return /failed to fetch|network ?error|load failed|network connection was lost|network-request-failed/i.test(String((err as any).message || ""));
}

function abortError(): Error {
  const err = new Error("The request was stopped.");
  err.name = "AbortError";
  return err;
}

/** Resolves after `ms`, or rejects at once if the request is stopped. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", stopped, { once: true });
  });
}

/** While the device says it's offline, waits (up to `maxMs`) for it to come back. */
export function waitForOnline(signal?: AbortSignal, maxMs = 60_000): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false || typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, maxMs);
    function done() {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      signal?.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped() {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      reject(abortError());
    }
    window.addEventListener("online", done);
    signal?.addEventListener("abort", stopped, { once: true });
  });
}

/** Before retry number `attempt` (0 for the first): back online, then a short wait. */
export async function beforeRetry(attempt: number, signal?: AbortSignal, delays: number[] = RETRY_DELAYS_MS): Promise<void> {
  await waitForOnline(signal);
  await pause(delays[Math.min(attempt, delays.length - 1)], signal);
}

export const HELD_HEADER = "X-Held-Open";

/**
 * The response a slow route meant to send. One kept alive by the server
 * arrives as status 200 with spaces ahead of {"heldStatus", "heldHeaders",
 * "body"}; anything else is returned as it is. A held answer cut off on the
 * way is a dropped connection (a TypeError, like fetch's own).
 */
export async function unwrapHeldOpen(response: Response): Promise<Response> {
  if (response.headers.get(HELD_HEADER) !== "1") return response;
  const text = await response.text();
  let held: any;
  try {
    held = JSON.parse(text);
  } catch {
    throw new TypeError("network error");
  }
  if (!held || typeof held !== "object" || !("heldStatus" in held)) throw new TypeError("network error");
  const status = Number.isInteger(held.heldStatus) && held.heldStatus >= 200 && held.heldStatus <= 599 ? held.heldStatus : 500;
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!/^(content-length|content-encoding|transfer-encoding|x-held-open)$/i.test(key)) headers.set(key, value);
  });
  for (const [key, value] of Object.entries(held.heldHeaders || {})) {
    if (typeof value === "string") headers.set(key, value);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : JSON.stringify(held.body ?? null), { status, headers });
}

/**
 * One request, asked again after a dropped connection (and after a 502/504,
 * which only the proxy in front of the server sends, while the server
 * restarts). Returns the response the route meant to send; throws
 * NETWORK_ERROR_MESSAGE once every retry has failed, and an AbortError when
 * stopped.
 */
export async function fetchWithRetry(send: () => Promise<Response>, signal?: AbortSignal, delays: number[] = RETRY_DELAYS_MS): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await unwrapHeldOpen(await send());
      if ((response.status === 502 || response.status === 504) && attempt < delays.length) {
        await beforeRetry(attempt, signal, delays);
        continue;
      }
      return response;
    } catch (err: any) {
      if (err?.name === "AbortError" || signal?.aborted) throw err?.name === "AbortError" ? err : abortError();
      if (!isNetworkError(err)) throw err;
      if (attempt >= delays.length) throw new Error(NETWORK_ERROR_MESSAGE);
      await beforeRetry(attempt, signal, delays);
    }
  }
}
