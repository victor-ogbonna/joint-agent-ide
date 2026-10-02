/**
 * Connections that stay up, and requests that ride out the ones that don't:
 *   - slow JSON answers kept alive by the server and unwrapped by the app
 *     (server/holdOpen.ts, src/lib/resilientFetch.ts);
 *   - a dropped connection retried after a wait, a real error never;
 *   - the AI service's busy or stalled replies stopped in good time, and a
 *     reply stopped when the person leaves (server/deepseek.ts).
 * Everything runs against real local HTTP servers.
 */
import http from "http";
import express from "express";
import { holdOpen, HELD_HEADER } from "../server/holdOpen.ts";
import { jsonErrorHandler } from "../server/asyncErrors.ts";
import {
  unwrapHeldOpen, fetchWithRetry, isNetworkError, NETWORK_ERROR_MESSAGE, pause,
} from "../src/lib/resilientFetch.ts";
import { streamChat, completeChat, AiTimeoutError, PRO_MODEL } from "../server/deepseek.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Slow answers kept alive");
const app = express();
let goneClosed = false;
app.get("/fast", (_req, res) => {
  holdOpen(res, { after: 300, every: 50 });
  res.setHeader("X-Thing", "a");
  res.status(201).json({ ok: 1 });
});
app.get("/slow", (_req, res) => {
  holdOpen(res, { after: 100, every: 50 });
  setTimeout(() => {
    res.setHeader("X-Free-Compiles-Left", "3");
    res.set("X-Other", "b");
    res.status(503).json({ error: "busy", code: "SERVER_BUSY" });
  }, 450);
});
app.get("/slowthrow", (_req, res, next) => {
  holdOpen(res, { after: 100, every: 50 });
  setTimeout(() => next(new Error("boom")), 300);
});
app.get("/gone", (_req, res) => {
  holdOpen(res, { after: 50, every: 30 });
  res.on("close", () => { goneClosed = true; });
  setTimeout(() => res.json({ late: true }), 600);
});
app.use(jsonErrorHandler);
const { server: appServer, url: appUrl } = await listen(app);

const fast = await fetch(`${appUrl}/fast`);
check(fast.status === 201 && fast.headers.get(HELD_HEADER) === null && fast.headers.get("X-Thing") === "a" && (await fast.json()).ok === 1,
  "a quick answer is sent exactly as before");

const raw = await fetch(`${appUrl}/slow`);
const rawText = await raw.text();
check(raw.status === 200 && raw.headers.get(HELD_HEADER) === "1", "a slow one starts after a moment, kept alive");
check(/^ {3,}\{/.test(rawText), "with a space every few moments before the answer", JSON.stringify(rawText.slice(0, 12)));
const slow = await unwrapHeldOpen(await fetch(`${appUrl}/slow`));
const slowBody = await slow.json();
check(slow.status === 503 && slowBody.code === "SERVER_BUSY" && slow.headers.get("X-Free-Compiles-Left") === "3" && slow.headers.get("X-Other") === "b",
  "the app gets back the status, headers and body the route meant");
const thrown = await unwrapHeldOpen(await fetch(`${appUrl}/slowthrow`));
check(thrown.status === 500 && (await thrown.json()).code === "SERVER_ERROR", "a route that fails part-way still answers in JSON");
const plain = new Response("{\"a\":1}", { status: 404 });
check((await unwrapHeldOpen(plain)) === plain, "any other response is left as it is");
let cutOff = null;
try {
  await unwrapHeldOpen(new Response("   ", { status: 200, headers: { [HELD_HEADER]: "1" } }));
} catch (err) { cutOff = err; }
check(cutOff instanceof TypeError && isNetworkError(cutOff), "a kept-alive answer cut off on the way reads as a dropped connection");
const ac = new AbortController();
const goneRes = await fetch(`${appUrl}/gone`, { signal: ac.signal });
check(goneRes.headers.get(HELD_HEADER) === "1", "(the next one is kept alive too)");
ac.abort();
await wait(800);
check(goneClosed, "when the browser leaves, the keep-alive stops with the connection");
appServer.close();

console.log("Dropped connections retried, real errors not");
check(isNetworkError(new TypeError("Failed to fetch")) && isNetworkError(new TypeError("network error")) && isNetworkError(new TypeError("Load failed"))
  && isNetworkError(new Error("Firebase: Error (auth/network-request-failed).")), "every browser's wording for a failed connection");
const aborted = new Error("x"); aborted.name = "AbortError";
check(!isNetworkError(aborted) && !isNetworkError(new Error("You must be signed in.")) && !isNetworkError(null), "a Stop or a real error is not one");
let tries = 0;
const ok = await fetchWithRetry(async () => { tries++; if (tries < 3) throw new TypeError("Failed to fetch"); return new Response("{}", { status: 200 }); }, undefined, [10, 10, 10]);
check(ok.status === 200 && tries === 3, "failed twice, then answered: the answer comes back");
tries = 0;
const after502 = await fetchWithRetry(async () => { tries++; return new Response("", { status: tries === 1 ? 502 : 200 }); }, undefined, [10, 10]);
check(after502.status === 200 && tries === 2, "a 502 while the server restarts is tried again");
tries = 0;
const real = await fetchWithRetry(async () => { tries++; return new Response("{}", { status: 503 }); }, undefined, [10, 10]);
check(real.status === 503 && tries === 1, "an answer from the server (even an error) is never retried");
let signedOut = null;
try { await fetchWithRetry(async () => { throw new Error("You must be signed in."); }, undefined, [10]); } catch (err) { signedOut = err; }
check(signedOut?.message === "You must be signed in.", "nor is an error of the app's own");
let gaveUp = null;
tries = 0;
try { await fetchWithRetry(async () => { tries++; throw new TypeError("Failed to fetch"); }, undefined, [5, 5, 5]); } catch (err) { gaveUp = err; }
check(gaveUp?.message === NETWORK_ERROR_MESSAGE && tries === 4, "after every retry: a plain message, not \"Failed to fetch\"", gaveUp?.message);
const stop = new AbortController();
setTimeout(() => stop.abort(), 30);
let stopped = null;
try { await fetchWithRetry(async () => { throw new TypeError("Failed to fetch"); }, stop.signal, [5000]); } catch (err) { stopped = err; }
check(stopped?.name === "AbortError", "Stop during the wait stops at once");
let pauseStopped = null;
const p2 = new AbortController(); p2.abort();
try { await pause(10, p2.signal); } catch (err) { pauseStopped = err; }
check(pauseStopped?.name === "AbortError", "(a wait that's already stopped)");

console.log("The AI service: busy, stalled, or left");
process.env.DEEPSEEK_API_KEY = "test-key";
let upstreamClosed = 0;
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const { server: fake, url: fakeUrl } = await listen((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const mode = JSON.parse(body).messages?.[0]?.content;
    res.on("close", () => { if (!res.writableEnded) upstreamClosed++; });
    if (mode === "complete-busy") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const t = setInterval(() => res.write("\n"), 30);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (mode === "complete-ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("\n\n");
      setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: "{\"code\":\"x\"}" } }], usage: { completion_tokens: 7 } })), 50);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 30);
    res.on("close", () => clearInterval(keepAlive));
    if (mode === "ok") {
      clearInterval(keepAlive);
      sse(res, { choices: [{ delta: { content: "Hello" } }] });
      sse(res, { choices: [{ delta: { content: " there" }, finish_reason: "stop" }], usage: { completion_tokens: 2, prompt_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    } else if (mode === "stall") {
      sse(res, { choices: [{ delta: { content: "Half" } }] });
    }
    // "busy": keep-alive lines only, forever.
  });
});
const profile = { ...PRO_MODEL, baseUrl: fakeUrl };
const msg = (content) => [{ role: "user", content }];
const timing = { firstReplyMs: 400, idleMs: 300, noticeMs: 100 };

let text = "";
const good = await streamChat(msg("ok"), undefined, { onText: (t) => { text += t; } }, profile, { timing });
check(good.sentText && text === "Hello there" && good.outputTokens === 2, "a normal reply streams through");

let noticed = 0;
let busyErr = null;
const t0 = Date.now();
try { await streamChat(msg("busy"), undefined, { onText: () => {} }, profile, { timing, onWaiting: () => noticed++ }); } catch (err) { busyErr = err; }
const took = Date.now() - t0;
check(noticed === 1, "busy: the person is told it's queued, once");
check(busyErr instanceof AiTimeoutError && busyErr.kind === "busy" && took >= 380 && took < 2000, "and the reply is stopped once the wait is too long, not left hanging", `${took} ms`);

let half = "";
let stallErr = null;
try { await streamChat(msg("stall"), undefined, { onText: (t) => { half += t; } }, profile, { timing }); } catch (err) { stallErr = err; }
check(half === "Half" && stallErr instanceof AiTimeoutError && stallErr.kind === "stalled", "a reply that goes quiet part-way is stopped too");

const leave = new AbortController();
setTimeout(() => leave.abort(), 120);
let leftErr = null;
const closedBefore = upstreamClosed;
try { await streamChat(msg("busy"), undefined, { onText: () => {} }, profile, { timing: { firstReplyMs: 5000, idleMs: 5000, noticeMs: 5000 }, signal: leave.signal }); } catch (err) { leftErr = err; }
await wait(100);
check(leftErr?.name === "AbortError" && !(leftErr instanceof AiTimeoutError), "the person leaving stops the reply");
check(upstreamClosed > closedBefore, "and the AI service's connection is closed with it");

const done = await completeChat(msg("complete-ok"), { jsonMode: true, maxMs: 2000 }, profile);
check(done.text === "{\"code\":\"x\"}" && done.outputTokens === 7, "a one-piece answer after the busy service's blank lines");
let completeErr = null;
try { await completeChat(msg("complete-busy"), { maxMs: 300 }, profile); } catch (err) { completeErr = err; }
check(completeErr instanceof AiTimeoutError, "and one that never comes is stopped in time");
fake.close();

console.log(bad ? `\n${bad} check(s) failed.` : "\nAll connection checks passed.");
process.exit(bad ? 1 : 0);
