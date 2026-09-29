/**
 * An error inside an async route answers that one request with a 500 and
 * leaves the server running. Before, the same request stopped the process.
 */
import express from "express";
import { catchAsyncErrors, jsonErrorHandler } from "../server/asyncErrors.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const app = express();
catchAsyncErrors(app);
app.set("trust proxy", 1);
app.use(express.json({ limit: "1kb" }));
// The exact shape that used to crash: reading a field that isn't there.
app.post("/generate", async (req, res) => { const { mcu } = req.body; res.json({ board: mcu.toUpperCase() }); });
app.get("/firestore-down", async () => { await Promise.resolve(); throw new Error("Firestore unavailable"); });
app.get("/sync-throw", () => { throw new Error("sync"); });
const middleware = async (_req, _res, next) => { await Promise.resolve(); next(); };
app.get("/fine", middleware, async (_req, res) => { res.json({ ok: true }); });
app.get("/after-send", async (_req, res) => { res.json({ sent: true }); throw new Error("late"); });
app.use(jsonErrorHandler);

const quiet = console.error;
console.error = () => {};
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body });

try {
  let r = await post("/generate", "{}");
  let j = await r.json();
  check(r.status === 500 && j.code === "SERVER_ERROR", "a request missing a field gets a 500, not a crash", `${r.status} ${JSON.stringify(j)}`);
  r = await post("/generate", JSON.stringify({ mcu: "esp32" }));
  j = await r.json();
  check(r.status === 200 && j.board === "ESP32", "and the next request is answered normally");
  r = await fetch(base + "/firestore-down");
  check(r.status === 500, "a database error mid-request answers that request only");
  r = await fetch(base + "/sync-throw");
  check(r.status === 500, "a plain throw still answers 500");
  r = await fetch(base + "/fine");
  j = await r.json();
  check(r.status === 200 && j.ok, "async middleware still passes requests on");
  r = await fetch(base + "/after-send");
  j = await r.json();
  check(r.status === 200 && j.sent, "an error after the answer was sent doesn't change the answer");
  r = await post("/generate", JSON.stringify({ mcu: "x".repeat(5000) }));
  j = await r.json();
  check(r.status === 413 && j.code === "TOO_LARGE", "a body over the limit gets a clear 413", `${r.status}`);
  r = await post("/generate", "{not json");
  j = await r.json();
  check(r.status === 400 && j.code === "BAD_REQUEST", "a body that isn't JSON gets a 400", `${r.status}`);
  check(app.get("trust proxy") === 1, "reading a setting with app.get still works");
  check(true, "the process is still running after all of that");
} finally {
  console.error = quiet;
  server.close();
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
