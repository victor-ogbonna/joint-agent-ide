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

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
