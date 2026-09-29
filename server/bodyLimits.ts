import express from "express";

/**
 * Request bodies are read before any route sees them, so their size is
 * limited here: 1 MB for everything, except the few routes that need more
 * (pictures in the chat, voice notes, feedback files, GitHub pushes, long
 * sketches). Those get their larger limit only when the request carries a
 * valid sign-in. Without one the body is never read, and the route itself
 * refuses the request as unsigned. Before, anyone could send 50 MB to any
 * route, signed in or not, and a handful at once filled the server's memory.
 */

export const DEFAULT_BODY_LIMIT = "1mb";

export const LARGE_BODY_LIMITS: Readonly<Record<string, string>> = {
  "/api/ai/chat": "50mb",
  "/api/github/commit": "50mb",
  "/api/ai/transcribe": "20mb",
  "/api/feedback": "5mb",
  "/api/compile": "5mb",
  "/api/ai/debug": "5mb",
};

export function readJsonBodies(signedIn: (req: express.Request) => Promise<boolean>): express.RequestHandler {
  // The raw bytes are kept for the Paystack webhook's signature check, which
  // only ever arrives on the default limit.
  const small = express.json({ limit: DEFAULT_BODY_LIMIT, verify: (req: any, _res, buf) => { req.rawBody = buf; } });
  const large = new Map(Object.entries(LARGE_BODY_LIMITS).map(([route, limit]) => [route, express.json({ limit })]));
  return async (req, res, next) => {
    const parser = req.method === "POST" ? large.get(req.path) : undefined;
    if (!parser) return small(req, res, next);
    if (!(await signedIn(req))) return next();
    parser(req, res, next);
  };
}
