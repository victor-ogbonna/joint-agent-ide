/**
 * The AI service failing (server/deepseek.ts): ridden out with retries when
 * it's down, overloaded or unreachable, told apart from a refusal or a bad
 * request (which aren't retried), and stopped at once when the person leaves.
 * Against a real local HTTP server standing in for the AI service.
 */
import http from "http";
import { streamChat, completeChat, AiServiceError, PRO_MODEL, PATIENT_RETRY_DELAYS_MS } from "../server/deepseek.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

process.env.DEEPSEEK_API_KEY = "test-key";
const seen = new Map();
const { server, url } = await listen((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    const mode = j.messages?.[0]?.content || "ok";
    const n = (seen.get(mode) || 0) + 1;
    seen.set(mode, n);
    const flaky = /^flaky(\d)/.exec(mode);
    if (mode.startsWith("down") || (flaky && n <= Number(flaky[1]))) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end('{"error":{"message":"Server overloaded"}}');
    }
    if (mode === "refused") {
      res.writeHead(402, { "Content-Type": "application/json" });
      return res.end('{"error":{"message":"Insufficient Balance"}}');
    }
    if (mode === "bad") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end('{"error":{"message":"Invalid request"}}');
    }
    if (!j.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "fixed" } }], usage: { completion_tokens: 4 } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }], usage: { completion_tokens: 2, prompt_tokens: 5 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
const profile = { ...PRO_MODEL, baseUrl: url };
const msg = (content) => [{ role: "user", content }];
const quick = (retryDelaysMs) => ({ timing: { retryDelaysMs } });

console.log("How long it keeps trying");
const total = PATIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
check(total >= 100_000 && total <= 140_000 && PATIENT_RETRY_DELAYS_MS.length >= 10, "a waiting chat rides out about two minutes of trouble", `${PATIENT_RETRY_DELAYS_MS.length + 1} tries over ${total / 1000} s`);

console.log("Down, then back");
let retries = 0;
let text = "";
const back = await streamChat(msg("flaky2"), undefined, { onText: (t) => { text += t; } }, profile, { ...quick([20, 20, 20]), onRetry: () => retries++ });
check(back.sentText && text === "Hello." && seen.get("flaky2") === 3 && retries === 2, "two failures, then the reply, with the person told each time it tries again", `${seen.get("flaky2")} requests, ${retries} notices`);
const oneShot = await completeChat(msg("flaky1-complete"), { retryDelaysMs: [20] }, profile);
check(oneShot.text === "fixed" && seen.get("flaky1-complete") === 2, "a one-piece answer rides it out too");

console.log("Down the whole time");
retries = 0;
let down = null;
try { await streamChat(msg("down"), undefined, { onText: () => {} }, profile, { ...quick([10, 10, 10]), onRetry: () => retries++ }); } catch (err) { down = err; }
check(down instanceof AiServiceError && down.kind === "unavailable" && down.status === 503 && seen.get("down") === 4 && retries === 3,
  "every try, then one plain kind of failure: unavailable", `${down?.kind} ${down?.status}, ${seen.get("down")} requests`);

console.log("Not worth retrying");
let refused = null;
try { await streamChat(msg("refused"), undefined, { onText: () => {} }, profile, quick([10, 10])); } catch (err) { refused = err; }
check(refused instanceof AiServiceError && refused.kind === "refused" && refused.status === 402 && seen.get("refused") === 1, "a refusal (key, balance) at once, not retried", `${refused?.kind} ${refused?.status}`);
let rejected = null;
try { await completeChat(msg("bad"), { retryDelaysMs: [10, 10] }, profile); } catch (err) { rejected = err; }
check(rejected instanceof AiServiceError && rejected.kind === "rejected" && rejected.status === 400 && seen.get("bad") === 1, "a request it won't take, at once", `${rejected?.kind} ${rejected?.status}`);

console.log("Unreachable");
const gone = await listen(() => {});
const goneUrl = gone.url;
await new Promise((r) => gone.server.close(r));
let unreachable = null;
retries = 0;
try { await streamChat(msg("ok"), undefined, { onText: () => {} }, { ...profile, baseUrl: goneUrl }, { ...quick([10, 10]), onRetry: () => retries++ }); } catch (err) { unreachable = err; }
check(unreachable instanceof AiServiceError && unreachable.kind === "unavailable" && unreachable.status === null && retries === 2,
  "no connection at all: retried, then unavailable", `${unreachable?.kind}, ${retries} notices`);

console.log("Leaving during a wait");
const leave = new AbortController();
setTimeout(() => leave.abort(), 100);
const t0 = Date.now();
let left = null;
try { await streamChat(msg("down-leave"), undefined, { onText: () => {} }, profile, { ...quick([5000]), signal: leave.signal }); } catch (err) { left = err; }
const took = Date.now() - t0;
check(left && took < 1500, "the wait between tries ends at once", `${took} ms`);

server.close();
console.log(bad ? `\n${bad} check(s) failed.` : "\nAll AI failure checks passed.");
process.exit(bad ? 1 : 0);
