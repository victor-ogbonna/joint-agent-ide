import type express from "express";
import crypto from "node:crypto";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";

/**
 * GitHub integration: connect an account, pick or create a repo, and push the
 * project as one real commit (code, schematic, README, plus any photos of the
 * physical build).
 *
 * The OAuth client secret never leaves the server, and the access token is
 * encrypted at rest — a Firestore leak should not hand over anyone's repos.
 */

const GITHUB_API = "https://api.github.com";
const SCOPES = "repo";          // private repos too; public_repo would be read-thin
const STATE_TTL_MS = 10 * 60 * 1000;

export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function redirectUri(): string {
  const base = (process.env.APP_URL || "").replace(/\/+$/, "");
  return `${base}/api/github/callback`;
}

/** Key for both state signing and token encryption. */
function secretKey(): Buffer {
  const raw = process.env.GITHUB_TOKEN_SECRET || process.env.GITHUB_CLIENT_SECRET || "";
  return crypto.createHash("sha256").update(raw).digest();
}

// --- state: proves the callback belongs to the user who started the flow ----
function signState(uid: string): string {
  const payload = `${uid}.${Date.now()}`;
  const mac = crypto.createHmac("sha256", secretKey()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

function verifyState(state: string): string | null {
  const [body, mac] = String(state || "").split(".");
  if (!body || !mac) return null;
  const payload = Buffer.from(body, "base64url").toString();
  const expected = crypto.createHmac("sha256", secretKey()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [uid, ts] = payload.split(".");
  if (!uid || !ts || Date.now() - Number(ts) > STATE_TTL_MS) return null;
  return uid;
}

// --- token at rest ---------------------------------------------------------
function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const out = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), out.toString("base64")].join(".");
}

function decryptToken(packed: string): string | null {
  try {
    const [iv, tag, data] = String(packed).split(".");
    if (!iv || !tag || !data) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    // Wrong key (the secret was rotated) or tampered data. Treat as disconnected.
    return null;
  }
}

async function storedToken(uid: string): Promise<string | null> {
  const snap = await adminDb.collection("users").doc(uid).get();
  const v = snap.data() as any;
  if (!v?.github?.token) return null;
  return decryptToken(v.github.token);
}

async function gh(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(path.startsWith("http") ? path : `${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Joint-Agent-IDE",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body?.message || `GitHub returned ${res.status}.`;
    const err: any = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

interface CommitFile { path: string; content: string; encoding?: "utf-8" | "base64"; }

export function registerGithubRoutes(
  app: express.Express,
  requireFirebaseAuth: express.RequestHandler
) {
  app.get("/api/github/status", requireFirebaseAuth, async (req: any, res) => {
    if (!isGithubConfigured()) {
      return res.json({ configured: false, connected: false });
    }
    try {
      const token = await storedToken(req.uid);
      if (!token) return res.json({ configured: true, connected: false });
      const me = await gh(token, "/user");
      res.json({ configured: true, connected: true, login: me.login, avatarUrl: me.avatar_url });
    } catch {
      // A revoked or expired token looks exactly like "not connected" to the UI.
      res.json({ configured: true, connected: false });
    }
  });

  app.get("/api/github/authorize", requireFirebaseAuth, (req: any, res) => {
    if (!isGithubConfigured()) {
      return res.status(503).json({ error: "GitHub is not configured on the server yet." });
    }
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", String(process.env.GITHUB_CLIENT_ID));
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", signState(req.uid));
    res.json({ url: url.toString() });
  });

  // GitHub redirects the BROWSER here, so there is no bearer token on this
  // request — the signed state is what ties the callback back to a user.
  app.get("/api/github/callback", async (req, res) => {
    const done = (ok: boolean, message: string) =>
      res.set("Content-Type", "text/html").send(
        `<!doctype html><meta charset="utf-8"><title>GitHub</title>
         <body style="font:15px system-ui;padding:40px;text-align:center;background:#15161a;color:#eee">
         <p>${ok ? "GitHub connected." : message.replace(/</g, "&lt;")}</p>
         <p style="color:#888;font-size:13px">You can close this window.</p>
         <script>try{window.opener&&window.opener.postMessage({source:"joint-agent-github",ok:${ok}},"*")}catch(e){}
         setTimeout(function(){window.close()},${ok ? 900 : 4000});</script></body>`
      );

    if (!isGithubConfigured() || !isFirebaseAdminConfigured()) return done(false, "GitHub is not configured.");
    const uid = verifyState(String(req.query.state || ""));
    if (!uid) return done(false, "That sign-in link expired. Try connecting again.");
    const code = String(req.query.code || "");
    if (!code) return done(false, "GitHub did not return an authorization code.");

    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri(),
        }),
      });
      const data = await tokenRes.json();
      if (!data.access_token) return done(false, data.error_description || "GitHub refused the token exchange.");

      const me = await gh(data.access_token, "/user");
      await adminDb.collection("users").doc(uid).set(
        { github: { token: encryptToken(data.access_token), login: me.login, connectedAt: new Date().toISOString() } },
        { merge: true }
      );
      done(true, "");
    } catch (err: any) {
      console.error("GitHub callback failed:", err);
      done(false, "Could not complete the GitHub connection.");
    }
  });

  app.post("/api/github/disconnect", requireFirebaseAuth, async (req: any, res) => {
    await adminDb.collection("users").doc(req.uid).set({ github: null }, { merge: true });
    res.json({ ok: true });
  });

  app.get("/api/github/repos", requireFirebaseAuth, async (req: any, res) => {
    try {
      const token = await storedToken(req.uid);
      if (!token) return res.status(401).json({ error: "Connect GitHub first.", code: "GITHUB_NOT_CONNECTED" });
      const list = await gh(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator");
      res.json({
        repos: list.map((r: any) => ({
          fullName: r.full_name, private: r.private,
          defaultBranch: r.default_branch, updatedAt: r.updated_at,
        })),
      });
    } catch (err: any) {
      res.status(err.status === 401 ? 401 : 500).json({ error: err.message || "Could not list repositories." });
    }
  });

  app.post("/api/github/repos", requireFirebaseAuth, async (req: any, res) => {
    try {
      const token = await storedToken(req.uid);
      if (!token) return res.status(401).json({ error: "Connect GitHub first.", code: "GITHUB_NOT_CONNECTED" });
      const name = String(req.body?.name || "").trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        return res.status(400).json({ error: "Use letters, numbers, dots, hyphens or underscores for the repository name." });
      }
      const created = await gh(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name,
          private: req.body?.private !== false,
          description: String(req.body?.description || "").slice(0, 300) || undefined,
          auto_init: true,          // gives it a first commit, so there is a branch to push onto
        }),
      });
      res.json({ fullName: created.full_name, defaultBranch: created.default_branch, private: created.private });
    } catch (err: any) {
      res.status(err.status === 422 ? 409 : 500).json({ error: err.message || "Could not create the repository." });
    }
  });

  /**
   * One commit containing every file, via the Git Data API. The contents API
   * would be simpler but makes a separate commit per file, so a project with
   * three photos would land as four commits.
   */
  app.post("/api/github/commit", requireFirebaseAuth, async (req: any, res) => {
    try {
      const token = await storedToken(req.uid);
      if (!token) return res.status(401).json({ error: "Connect GitHub first.", code: "GITHUB_NOT_CONNECTED" });

      const fullName = String(req.body?.repo || "");
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) {
        return res.status(400).json({ error: "Pick a repository first." });
      }
      const message = String(req.body?.message || "").trim().slice(0, 500) || "Update from Joint-Agent IDE";
      const files: CommitFile[] = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!files.length) return res.status(400).json({ error: "Nothing to commit." });
      if (files.length > 20) return res.status(400).json({ error: "At most 20 files per commit." });

      for (const f of files) {
        if (typeof f?.path !== "string" || !f.path || f.path.includes("..") || f.path.startsWith("/")) {
          return res.status(400).json({ error: `Invalid file path: ${String(f?.path).slice(0, 60)}` });
        }
        if (typeof f?.content !== "string") {
          return res.status(400).json({ error: `File ${f.path} had no content.` });
        }
      }

      const repo = await gh(token, `/repos/${fullName}`);
      const branch = String(req.body?.branch || repo.default_branch || "main");

      // An auto_init'd repo has a ref; a truly empty one does not.
      let baseCommitSha: string | null = null;
      let baseTreeSha: string | undefined;
      try {
        const ref = await gh(token, `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
        baseCommitSha = ref.object.sha;
        const baseCommit = await gh(token, `/repos/${fullName}/git/commits/${baseCommitSha}`);
        baseTreeSha = baseCommit.tree.sha;
      } catch (e: any) {
        if (e.status !== 404 && e.status !== 409) throw e;   // 409 = empty repository
      }

      const blobs = [];
      for (const f of files) {
        const blob = await gh(token, `/repos/${fullName}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: f.content, encoding: f.encoding === "base64" ? "base64" : "utf-8" }),
        });
        blobs.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }

      const tree = await gh(token, `/repos/${fullName}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: blobs }),
      });

      const commit = await gh(token, `/repos/${fullName}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: baseCommitSha ? [baseCommitSha] : [] }),
      });

      if (baseCommitSha) {
        await gh(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: "PATCH", body: JSON.stringify({ sha: commit.sha }),
        });
      } else {
        await gh(token, `/repos/${fullName}/git/refs`, {
          method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
        });
      }

      res.json({
        ok: true, sha: commit.sha, branch,
        url: `https://github.com/${fullName}/commit/${commit.sha}`,
      });
    } catch (err: any) {
      console.error("GitHub commit failed:", err);
      res.status(err.status === 403 ? 403 : 500).json({ error: err.message || "Could not push the commit." });
    }
  });
}
