/**
 * The site is served from dist/, which also holds the server's own bundle and
 * its source map. Those two must never be downloadable, however the address
 * is spelled, while every file of the site still is.
 */
import express from "express";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { siteFiles } from "../server/siteFiles.js";

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "sitefiles-"));
fs.mkdirSync(path.join(dist, "assets"));
fs.writeFileSync(path.join(dist, "index.html"), "APP PAGE");
fs.writeFileSync(path.join(dist, "server.cjs"), "SERVER CODE");
fs.writeFileSync(path.join(dist, "server.cjs.map"), "SERVER SOURCE MAP");
fs.writeFileSync(path.join(dist, "assets", "index-abc.js"), "SITE SCRIPT");
fs.writeFileSync(path.join(dist, "assets", "index-abc.css"), "SITE STYLE");
fs.writeFileSync(path.join(dist, "logo.png"), "PNG");
fs.writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
fs.writeFileSync(path.join(dist, "sw.js"), "SERVICE WORKER");

// The same arrangement as server.ts in production.
const app = express();
app.use(siteFiles(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const { port } = server.address();

// Raw paths, exactly as written: fetch() would tidy "..", "./" and "//" away
// before sending, and an attacker's client need not.
const get = (rawPath) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

let bad = 0;
const check = (ok, label, extra = "") => { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : "  " + extra}`); };

for (const p of [
  "/server.cjs", "/server.cjs.map", "/server%2Ecjs", "/server%2ecjs%2emap", "/%73erver.cjs.map",
  "/assets/../server.cjs.map", "/./server.cjs", "//server.cjs.map", "/assets/%2E%2E/server.cjs",
  "/SERVER.CJS.MAP", "/server.cjs.map?x=1", "/server.cjs/", "/server.cjs%00",
]) {
  const r = await get(p);
  check(!r.body.includes("SERVER"), `${p} gives nothing of the server`, `${r.status} ${r.body}`);
}

for (const [p, want] of [
  ["/", "APP PAGE"], ["/index.html", "APP PAGE"], ["/assets/index-abc.js", "SITE SCRIPT"],
  ["/assets/index-abc.css", "SITE STYLE"], ["/logo.png", "PNG"], ["/manifest.webmanifest", "{}"],
  ["/sw.js", "SERVICE WORKER"], ["/waitlist", "APP PAGE"], ["/share/abc123", "APP PAGE"],
]) {
  const r = await get(p);
  check(r.status === 200 && r.body === want, `${p} still serves the site`, `${r.status} ${r.body}`);
}

server.close();
fs.rmSync(dist, { recursive: true, force: true });
console.log(bad ? `\n${bad} failing case(s)` : "\nThe server's own files are never served; the site's all are.");
process.exit(bad ? 1 : 0);
