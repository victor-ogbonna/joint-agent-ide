import type express from "express";

/**
 * Express 4 doesn't catch errors thrown inside async route handlers, and
 * Node stops the whole process when a rejected promise goes unhandled. So a
 * single request with a missing field, or a Firestore call that failed for a
 * moment, took the server down for everyone.
 *
 * catchAsyncErrors makes every handler registered on the app hand its error
 * to Express instead, which answers that one request with a 500 (see
 * jsonErrorHandler) and carries on. Call it before registering any route.
 */

type Handler = (...args: any[]) => any;

function wrap(fn: unknown): unknown {
  if (Array.isArray(fn)) return fn.map(wrap);
  // Error handlers (four arguments) are left alone: Express tells them apart
  // by their arity, and they are where errors end up anyway.
  if (typeof fn !== "function" || fn.length === 4) return fn;
  const handler = fn as Handler;
  return function wrapped(this: unknown, req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
      const result = handler.call(this, req, res, next);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(undefined, next);
      }
      return result;
    } catch (err) {
      next(err);
    }
  };
}

export function catchAsyncErrors(app: express.Express): void {
  for (const method of ["get", "post", "put", "patch", "delete", "all", "use"] as const) {
    const original = (app as any)[method].bind(app) as Handler;
    // app.get("setting") with a single argument reads a setting; nothing to wrap.
    (app as any)[method] = (...args: unknown[]) => original(...args.map(wrap));
  }
}

/** The last stop for an error: log it, and answer the one request that hit it. */
export function jsonErrorHandler(err: any, req: express.Request, res: express.Response, _next: express.NextFunction): void {
  const status = Number(err?.status || err?.statusCode);
  // A body the parser refused (too large, not JSON) is the caller's mistake.
  if (status >= 400 && status < 500) {
    if (!res.headersSent) {
      const [error, code] = status === 413 ? ["That request is too large.", "TOO_LARGE"]
        : status === 404 ? ["Not found.", "NOT_FOUND"]
        : ["That request couldn't be read.", "BAD_REQUEST"];
      res.status(status).json({ error, code });
    }
    return;
  }
  console.error(`[Server] ${req.method} ${req.path} failed:`, err?.stack || err?.message || err);
  if (res.headersSent) {
    // A stream (such as the agent's reply) was already under way: end it.
    try { res.end(); } catch { /* already closed */ }
    return;
  }
  res.status(500).json({ error: "Something went wrong on the server. Please try again.", code: "SERVER_ERROR" });
}
