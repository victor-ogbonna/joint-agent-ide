/**
 * At most 1 MB per request; a few routes take more, and only when the
 * request is signed in. An unsigned large body is never read.
 */
import express from "express";
import { readJsonBodies, LARGE_BODY_LIMITS } from "../server/bodyLimits.ts";
import { catchAsyncErrors, jsonErrorHandler } from "../server/asyncErrors.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const MB = 1024 * 1024;

const app = express();
catchAsyncErrors(app);
// Stands in for a real sign-in check.
app.use(readJsonBodies(async (req) => req.headers.authorization === "Bearer good"));
const requireSignIn = (req, res, next) => req.headers.authorization === "Bearer good" ? next() : res.status(401).json({ code: "AUTH_REQUIRED" });
const echo = (req, res) => res.json({ read: req.body !== undefined, size: JSON.stringify(req.body ?? null).length, raw: !!req.rawBody });
app.post("/api/waitlist/join", echo);
app.post("/api/paystack/webhook", echo);
app.post("/api/ai/chat", requireSignIn, echo);
app.post("/api/feedback", requireSignIn, echo);
app.use(jsonErrorHandler);

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const body = (bytes) => JSON.stringify({ data: "x".repeat(bytes) });
const post = (path, bytes, token) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body(bytes),
});

try {
  let r = await post("/api/waitlist/join", 2 * MB);
  check(r.status === 413, "2 MB to an ordinary route: refused", `${r.status}`);
  r = await post("/api/waitlist/join", 200 * 1024);
  let j = await r.json();
  check(r.status === 200 && j.read, "a normal-sized request still works");
  r = await post("/api/paystack/webhook", 1000);
  j = await r.json();
  check(j.raw, "the raw bytes are kept for the payment webhook's signature check");
  r = await post("/api/ai/chat", 2 * MB);
  j = await r.json();
  check(r.status === 401 && j.code === "AUTH_REQUIRED", "2 MB to the chat without signing in: refused as unsigned, body never read", `${r.status}`);
  r = await post("/api/ai/chat", 2 * MB, "forged");
  check(r.status === 401, "a made-up sign-in doesn't get the large limit either");
  r = await post("/api/ai/chat", 8 * MB, "good");
  j = await r.json();
  check(r.status === 200 && j.read && j.size > 8 * MB, "signed in, the chat still takes pictures (8 MB here)", `${r.status}`);
  r = await post("/api/feedback", 6 * MB, "good");
  check(r.status === 413, "each large route keeps its own limit (feedback: 5 MB)", `${r.status}`);
  check(LARGE_BODY_LIMITS["/api/ai/chat"] === "50mb" && LARGE_BODY_LIMITS["/api/ai/transcribe"] === "20mb", "the chat keeps today's 50 MB; voice notes (up to 16 MB) get 20 MB");
} finally {
  server.close();
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
