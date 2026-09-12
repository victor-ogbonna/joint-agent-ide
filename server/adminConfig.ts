import fs from "fs";
import path from "path";

// ----------------------------------------------------
// Shared, gitignored runtime-config file. Multiple features (Gemini key,
// Paystack keys) persist fields into this same JSON file so any of them can
// be changed at runtime via the admin page with no redeploy. Reads/writes
// always go through load/save here so a save from one feature can never
// clobber a field owned by another.
//
// On its own this file only survives on disk until the container restarts
// (Render's filesystem is ephemeral) — RENDER_API_KEY / RENDER_SERVICE_ID
// below make a save durable by also pushing it to Render's own environment
// variables, so it's still there after the next redeploy or free-tier sleep.
// ----------------------------------------------------
const ADMIN_CONFIG_PATH = path.join(process.cwd(), ".admin-config.json");

export interface AdminConfig {
  geminiApiKey?: string;
  /** While true, only granted accounts may use the product (see server/access.ts). */
  launchLocked?: boolean;
  /** Granted Pro without paying, and allowed in while locked. */
  proAccessEmails?: string[];
  /** Normal free allowance, but allowed in while locked. */
  earlyAccessEmails?: string[];
  paystackSecretKey?: string;
  paystackPublicKey?: string;
  paystackPlanCode?: string;
}

// Which real Render environment variable each admin-config field should be
// mirrored to, so a save durably updates the same variable `--set-secrets`
// (or the Render dashboard) originally set.
const RENDER_ENV_VAR_NAMES: Record<keyof AdminConfig, string> = {
  geminiApiKey: "GEMINI_API_KEY",
  launchLocked: "LAUNCH_LOCKED",
  proAccessEmails: "PRO_ACCESS_EMAILS",
  earlyAccessEmails: "EARLY_ACCESS_EMAILS",
  paystackSecretKey: "PAYSTACK_SECRET_KEY",
  paystackPublicKey: "PAYSTACK_PUBLIC_KEY",
  paystackPlanCode: "PAYSTACK_PLAN_CODE",
};

export function loadAdminConfig(): AdminConfig {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeLocalAdminConfig(patch: Partial<AdminConfig>): void {
  const next = { ...loadAdminConfig(), ...patch };
  fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
}

interface RenderEnvVar {
  key: string;
  value: string;
}

// Render's PUT /env-vars replaces the *entire* list — any variable left out
// of the request body gets deleted from the service — so a durable update
// always fetches every existing variable first and merges the patch in,
// never sends a partial list.
async function fetchAllRenderEnvVars(base: string, headers: Record<string, string>): Promise<RenderEnvVar[]> {
  const all: RenderEnvVar[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${base}/env-vars`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Render env-vars fetch failed: ${res.status} ${await res.text()}`);
    const page: { envVar: RenderEnvVar; cursor: string }[] = await res.json();
    for (const item of page) all.push(item.envVar);
    cursor = page.length === 100 ? page[page.length - 1].cursor : undefined;
  } while (cursor);
  return all;
}

async function pushToRenderEnv(patch: Partial<AdminConfig>): Promise<void> {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return; // not configured for durable saves — local file is all we have

  const base = `https://api.render.com/v1/services/${serviceId}`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const current = await fetchAllRenderEnvVars(base, headers);
  const merged = new Map(current.map((v) => [v.key, v.value]));
  for (const [field, value] of Object.entries(patch)) {
    const envName = RENDER_ENV_VAR_NAMES[field as keyof AdminConfig];
    if (envName && typeof value === "string") merged.set(envName, value);
  }

  const putRes = await fetch(`${base}/env-vars`, {
    method: "PUT",
    headers,
    body: JSON.stringify([...merged].map(([key, value]) => ({ key, value }))),
  });
  if (!putRes.ok) throw new Error(`Render env-vars update failed: ${putRes.status} ${await putRes.text()}`);

  // Env var changes alone are not applied automatically — restart the
  // running instance so the new value actually takes effect. deploy_only
  // reuses the already-built image instead of rebuilding, so this is fast
  // (seconds), not another multi-minute PlatformIO build.
  const deployRes = await fetch(`${base}/deploys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deployMode: "deploy_only" }),
  });
  if (!deployRes.ok) throw new Error(`Render deploy trigger failed: ${deployRes.status} ${await deployRes.text()}`);
}

// Saves an admin-page change two ways: immediately to the local file (so
// it's readable this instant, and so local dev without Render still works
// unchanged), and — when RENDER_API_KEY/RENDER_SERVICE_ID are set — durably
// to Render's own environment, so it survives the next restart instead of
// silently reverting. The Render push is best-effort: if it fails, the
// local save still succeeded, and the caller is told the change isn't
// durable rather than being told a comforting lie about it.
export async function saveAdminConfig(patch: Partial<AdminConfig>): Promise<{ durable: boolean }> {
  writeLocalAdminConfig(patch);
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
    return { durable: false };
  }
  try {
    await pushToRenderEnv(patch);
    return { durable: true };
  } catch (err) {
    console.error("Failed to persist admin change to Render (saved locally only):", err);
    return { durable: false };
  }
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 6)}${"•".repeat(Math.max(4, value.length - 10))}${value.slice(-4)}`;
}
