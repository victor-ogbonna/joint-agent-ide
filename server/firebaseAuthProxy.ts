import type express from "express";

// ---------------------------------------------------------------------------
// Firebase serves its sign-in machinery from `<authDomain>/__/auth/*`. Leaving
// authDomain as the default means Google's consent screen reads "Sign in to
// <project>.firebaseapp.com" — pointing it at our own domain is what makes it
// read as our own brand instead.
//
// Firebase Hosting normally serves those paths for you; on Render nothing does,
// so sign-in would break the moment authDomain changed. This proxies them
// straight through to Firebase, so the browser (and Google) only ever see our
// domain while Firebase still does the actual work.
// ---------------------------------------------------------------------------

// Headers that describe a single network hop and must not be forwarded, plus
// content-encoding/length — fetch has already decoded the body by the time we
// see it, so passing the original values through would describe it wrongly.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "content-encoding", "content-length",
]);

export function registerFirebaseAuthProxy(app: express.Express): void {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.warn("Firebase auth proxy not mounted: FIREBASE_PROJECT_ID is unset.");
    return;
  }
  const upstreamOrigin = `https://${projectId}.firebaseapp.com`;

  const proxy: express.RequestHandler = async (req, res) => {
    // originalUrl (not req.url) — app.use strips the mount path, and Firebase
    // needs the full /__/auth/... path plus its query string intact.
    const target = new URL(req.originalUrl, upstreamOrigin);

    const headers: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(req.headers)) {
      const key = rawKey.toLowerCase();
      // Host must become firebaseapp.com or Firebase Hosting won't route it.
      if (key === "host" || HOP_BY_HOP.has(key)) continue;
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.rawBody,
        // Pass redirects back to the browser rather than following them here:
        // the OAuth flow depends on the browser actually visiting each step.
        redirect: "manual",
      });

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (HOP_BY_HOP.has(k) || k === "set-cookie") return;
        res.setHeader(key, value);
      });

      // Cookies come back scoped to firebaseapp.com; strip that Domain so the
      // browser scopes them to whatever host actually served the response.
      const cookies = upstream.headers.getSetCookie?.() ?? [];
      if (cookies.length) {
        res.setHeader("set-cookie", cookies.map((c) => c.replace(/;\s*domain=[^;]*/gi, "")));
      }

      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error("Firebase auth proxy failed:", err);
      res.status(502).json({ error: "Sign-in handler is temporarily unavailable." });
    }
  };

  app.use("/__/auth", proxy);
  app.use("/__/firebase", proxy);
  console.log(`Firebase auth proxy mounted -> ${upstreamOrigin}`);
}
