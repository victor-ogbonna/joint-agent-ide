/**
 * The admin settings (launch lock, access grants, Paystack keys) are saved
 * whole and swapped in, so a save that fails partway leaves the old ones.
 */
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-config-test-"));
process.env.ADMIN_CONFIG_DIR = dir;
const { saveAdminConfig, loadAdminConfig } = await import("../server/adminConfig.ts");
const file = path.join(dir, ".admin-config.json");

let bad = 0;
const check = (cond, label, extra = "") => { if (!cond) bad++; console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };

await saveAdminConfig({ launchLocked: true, proAccessEmails: ["a@b.c"] });
await saveAdminConfig({ paystackPlanCode: "PLN_x" });
const cfg = loadAdminConfig();
check(cfg.launchLocked === true && cfg.proAccessEmails?.[0] === "a@b.c" && cfg.paystackPlanCode === "PLN_x", "each save keeps what the others saved");
check(fs.readdirSync(dir).join() === ".admin-config.json", "no temporary file is left behind", fs.readdirSync(dir).join());
check((fs.statSync(file).mode & 0o777) === 0o600, "only the server's own account can read it");

const before = fs.readFileSync(file, "utf8");
let threw = false;
try { await saveAdminConfig({ launchLocked: 1n }); } catch { threw = true; }   // can't be written as JSON
check(threw && fs.readFileSync(file, "utf8") === before, "a save that fails partway leaves the old settings exactly as they were");
check(fs.readdirSync(dir).join() === ".admin-config.json", "and leaves no temporary file");

// On the server ADMIN_CONFIG_DIR is the mounted ./data folder (docker-compose.yml): kept across restarts and deploys.
check((await saveAdminConfig({ paystackYearlyPlanCode: "PLN_year" })).durable === true, "with ADMIN_CONFIG_DIR set, a save is kept (durable)");
await saveAdminConfig({ paystackYearlyPlanCode: undefined });
const afterRemove = loadAdminConfig();
check(!("paystackYearlyPlanCode" in afterRemove) && afterRemove.paystackPlanCode === "PLN_x", "the yearly plan can be removed, the monthly one stays");

// Checking a plan with Paystack (server/paystack.ts), with Paystack stood in for.
const { checkPlan } = await import("../server/paystack.ts");
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const yearly = await checkPlan("sk_live_x", "PLN_year", reply(200, { status: true, data: { name: "PRO yearly", amount: 8928000, currency: "NGN", interval: "annually" } }));
check(yearly.ok && yearly.amount === 8928000 && yearly.currency === "NGN" && yearly.interval === "annually" && yearly.name === "PRO yearly", "a plan Paystack knows: its name, price and interval");
check((await checkPlan("sk_live_x", "PLN_nope", reply(404, { status: false, message: "Plan not found" }))).error?.includes("doesn't know this plan"), "one it doesn't: says so");
check((await checkPlan("sk_live_bad", "PLN_year", reply(401, { status: false }))).error?.includes("refused the secret key"), "a wrong secret key: says so");
check((await checkPlan("sk_live_x", "PLN_year", async () => { throw new Error("offline"); })).error?.includes("Couldn't reach Paystack"), "Paystack unreachable: says so");

// The admin page's routes for it, through a real server (the admin password check stood in for).
const express = (await import("express")).default;
const { registerPaystackRoutes } = await import("../server/paystack.ts");
const app = express();
app.use(express.json());
registerPaystackRoutes(app, (_req, _res, next) => next());
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let r = await call("POST", "/api/admin/paystack-config", { secretKey: "sk_live_abc123secret", publicKey: "pk_test_abc" });
check(r.status === 400 && /test key but the secret key is a live key/.test(r.body.error), "a test public key with a live secret key is refused");
r = await call("POST", "/api/admin/paystack-config", { secretKey: "sk_live_abc123secret", publicKey: "pk_live_abc", yearlyPlanCode: "PLN_yr" });
check(r.status === 200 && r.body.durable === true && r.body.publicKey === "pk_live_abc" && r.body.yearlyPlanCode === "PLN_yr" && !JSON.stringify(r.body).includes("abc123secret"),
  "saved; the reply never carries the secret key in full");
r = await call("GET", "/api/admin/paystack-config");
check(r.body.maskedSecretKey?.startsWith("sk_liv") && r.body.maskedSecretKey.endsWith("cret") && r.body.sources.secretKey === "admin" && r.body.sources.planCode === "admin",
  "the page shows the secret masked, and where each setting comes from");
r = await call("GET", "/api/admin/paystack-secret");
check(r.body.secretKey === "sk_live_abc123secret", "Show: the secret key in full, only when asked");
r = await call("POST", "/api/admin/paystack-config", { clearYearlyPlanCode: true });
check(r.status === 200 && r.body.yearlyPlanCode === null && r.body.planCode === "PLN_x", "Remove: the yearly plan goes, the monthly stays");
r = await call("POST", "/api/admin/paystack-config", { planCode: "nope" });
check(r.status === 400 && /PLN_/.test(r.body.error), "a plan code that isn't one is refused");
await new Promise((resolve) => server.close(resolve));

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
