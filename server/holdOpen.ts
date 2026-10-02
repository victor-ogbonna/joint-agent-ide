import type express from "express";

/**
 * Keeps a slow JSON answer's connection alive.
 *
 * A compile can wait its turn and then build for minutes, and the AI can take
 * as long to write a fix, with nothing travelling back the whole time. A
 * connection silent for minutes gets dropped on the way by phone networks,
 * routers or antivirus software, and the browser then reports "Failed to
 * fetch" though the internet is fine.
 *
 * So once HOLD_AFTER_MS pass without an answer, the response starts anyway:
 * status 200, the header X-Held-Open: 1, and a space every HOLD_EVERY_MS
 * (JSON allows leading spaces). The route's real answer then follows as one
 * object, {"heldStatus": ..., "heldHeaders": {...}, "body": ...}, which the
 * browser turns back into the response the route meant to send
 * (src/lib/heldOpen.ts). A quick answer is sent exactly as before.
 *
 * Covers what these routes use: res.status(), res.setHeader() (and res.set,
 * which calls it) and res.json(). jsonErrorHandler (server/asyncErrors.ts)
 * answers through res.json too once a response is held.
 */
export const HOLD_AFTER_MS = 10_000;
export const HOLD_EVERY_MS = 15_000;
export const HELD_HEADER = "X-Held-Open";

export function holdOpen(res: express.Response, opts: { after?: number; every?: number } = {}): void {
  const after = opts.after ?? HOLD_AFTER_MS;
  const every = opts.every ?? HOLD_EVERY_MS;
  let held = false;
  let status = 200;
  const headers: Record<string, string> = {};
  let beat: ReturnType<typeof setInterval> | null = null;

  const originalStatus = res.status.bind(res);
  const originalSetHeader = res.setHeader.bind(res);
  const originalJson = res.json.bind(res);

  const stop = () => {
    clearTimeout(timer);
    if (beat) clearInterval(beat);
    beat = null;
  };

  const start = () => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    held = true;
    res.locals.heldOpen = true;
    originalStatus(200);
    originalSetHeader("Content-Type", "application/json; charset=utf-8");
    originalSetHeader("Cache-Control", "no-store");
    originalSetHeader(HELD_HEADER, "1");
    res.flushHeaders();
    res.write(" ");
    beat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return stop();
      res.write(" ");
    }, every);
  };

  const timer = setTimeout(start, after);
  res.on("close", stop);

  res.status = ((code: number) => {
    if (!held) return originalStatus(code);
    status = code;
    return res;
  }) as typeof res.status;

  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (!held) return originalSetHeader(name, value);
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return res;
  }) as typeof res.setHeader;

  res.json = ((body: unknown) => {
    stop();
    if (!held) return originalJson(body);
    if (!res.writableEnded && !res.destroyed) {
      res.end(JSON.stringify({ heldStatus: status, heldHeaders: headers, body: body === undefined ? null : body }));
    }
    return res;
  }) as typeof res.json;
}
