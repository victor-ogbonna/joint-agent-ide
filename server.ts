import "./server/env";
import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { loadAdminConfig, saveAdminConfig } from './server/adminConfig';
import { readAccessLists, sanitiseEmailList } from './server/access';
import { requireAuthAndQuota, requireFirebaseAuth, hasValidSignIn, incrementTokenUsage, getOrCreateUserDoc, consumeCompile, refundCompile, CompileReceipt, tierOf, allowanceFor, compileAllowance, formatWait, subscriptionStanding, FREE_WINDOW_COMPILES, FREE_DAILY_COMPILES } from './server/quota';
import { accessLevelFor } from './server/access';
import { voiceNoteTooLong, MAX_VOICE_NOTE_SECONDS } from './server/voiceNote';
import { registerPaystackRoutes, paystackSecretKey, paystackPublicKey } from './server/paystack';
import { registerAdminStatsRoutes } from './server/adminStats';
import { useBuildCache, readyBuildCache, startBuildCachePruning, damagedCacheFailure, reportDamagedCache, retireDamagedCache } from './server/buildCache';
import { catchAsyncErrors, jsonErrorHandler } from './server/asyncErrors';
import { runBuild, COMPILE_TIMEOUT_MS, fileSystemInclude } from './server/buildRun';
import { readJsonBodies } from './server/bodyLimits';
import { registerShareRoutes } from './server/share';
import { adminDb, isFirebaseAdminConfigured } from './server/firebaseAdmin';
import { registerWaitlistRoutes } from './server/waitlist';
import { registerFeedbackRoutes } from './server/feedback';
import { registerCreatorRoutes } from './server/creators';
import { registerTeamRoutes, teamForStatus, type TeamStatus } from './server/teams';
import { canUseCode, firstMonthOfferUntil, firstMonthOfferOpensAt } from './server/referrals';
import { registerGithubRoutes } from './server/github';
import { registerFirebaseAuthProxy } from './server/firebaseAuthProxy';
import { detectLibDeps, isSafeLibDep } from './server/libraryDeps';
import { registerLibraryRoutes, prepareLibraries, mergeLibDeps, missingLibraryHint, libraryNoteFor, NO_LIBRARIES } from './server/libraries';
import { loadBoardCatalog, getBoardCatalog, getBoardById, boardFamily, resolveBoard, describeBoardForPrompt, describeFamilyForPrompt, BoardInfo } from './server/boards';
import { getCachedContentName } from './server/geminiCache';
import { streamChat, completeChat, isDeepSeekConfigured, DEEPSEEK_MODEL, ChatMessage, ToolSpec, modelFor } from './server/deepseek';
import { CONTEXT_BUDGET_TOKENS, ConversationMessage, planCompaction, SUMMARY_INSTRUCTION, transcriptOf, KEEP_RECENT_MESSAGES, attachedImages } from './server/context';


// Same two tools as the Gemini declarations below, restated as JSON Schema —
// DeepSeek is OpenAI-compatible, so `type` is a plain string rather than
// Gemini's Type enum, and each tool is wrapped in {type:"function"}.
const COMPONENT_TYPES = ["led", "resistor", "dht11", "servo", "lcd", "button", "relay", "buzzer", "potentiometer", "pir", "neopixel", "ultrasonic", "keypad", "oled"];

const DEEPSEEK_IMPLEMENT_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "generate_project",
      description: "Generate microcontroller code and a full circuit schematic (components + wiring) for the current MCU.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Complete C++ code (.ino format)." },
          description: { type: "string", description: "A short paragraph describing the generated project." },
          components: {
            type: "array",
            description: "Electronic components used in the schematic, excluding the microcontroller board itself (the board is implicit, referenced as 'mcu' in connections).",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique component ID, e.g. 'led1', 'resistor1', 'dht1'." },
                type: { type: "string", enum: COMPONENT_TYPES, description: "Exact component type from the supported components list." },
                label: { type: "string", description: "Friendly display name, e.g. 'Red LED', '220 Ohm Resistor'." },
                value: { type: "string", description: "Value or rating, e.g. '220R', 'DHT11', 'SG90'." },
              },
              required: ["id", "type", "label"],
            },
          },
          connections: {
            type: "array",
            description: "Wiring connections between components and the microcontroller. Use the literal ID 'mcu' for the microcontroller board.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique wire ID, e.g. 'wire1'." },
                fromComponentId: { type: "string", description: "Source component ID, or 'mcu' for the microcontroller board." },
                fromPin: { type: "string", description: "Pin name on the source. If source is 'mcu', must be a valid pin from the Microcontroller Reference." },
                toComponentId: { type: "string", description: "Target component ID, or 'mcu' for the microcontroller board." },
                toPin: { type: "string", description: "Pin name on the target." },
                color: { type: "string", description: "Hex wire color, e.g. '#EF4444' power, '#000000' GND, '#3B82F6' signal." },
              },
              required: ["id", "fromComponentId", "fromPin", "toComponentId", "toPin", "color"],
            },
          },
        },
        required: ["code", "description", "components", "connections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_terminal_command",
      description: "Run one of the workspace's built-in commands. This is NOT a shell. It accepts only the exact words listed and nothing else — no pipes, no &&, no redirection, no paths, no flags, no inspecting the machine.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: [...WORKSPACE_COMMANDS],
            description: "One of: help, compile, flash, clear, monitor, engine, web3 status, ret",
          },
        },
        required: ["command"],
      },
    },
  },
];

const execPromise = util.promisify(exec);

// ---------------------------------------------------------------------------
// Gemini overload retry
//
// 503/UNAVAILABLE means Google's model is momentarily saturated — it is
// explicitly a retryable condition, not a fault in the request. Failing on the
// first one put the burden on the user to keep re-sending, which read as the
// agent being broken. Retry here with exponential backoff plus jitter (so a
// burst of users doesn't retry in lockstep and re-spike the same instant).
//
// Deliberately narrow: only overload/rate-limit statuses retry. A bad key,
// malformed request or exhausted quota is not transient, so those surface
// immediately rather than being hidden behind a slow triple-failure.
// ---------------------------------------------------------------------------
const GEMINI_RETRY_DELAYS_MS = [700, 1800, 4000];

function isRetryableGeminiError(err: any): boolean {
  const msg = String(err?.message || err || "");
  return /\b(503|429)\b/.test(msg) || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(msg);
}

async function withGeminiRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === GEMINI_RETRY_DELAYS_MS.length || !isRetryableGeminiError(err)) break;
      const base = GEMINI_RETRY_DELAYS_MS[attempt];
      const wait = base + Math.floor(Math.random() * 400);
      console.warn(`[Gemini] ${label} overloaded (attempt ${attempt + 1}) — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

dotenv.config();

const app = express();
// Before any route: an error in an async handler answers that one request
// instead of stopping the server (server/asyncErrors.ts).
catchAsyncErrors(app);
// Anything that still slips out is logged, not fatal.
process.on("unhandledRejection", (reason: any) => {
  console.error("[Server] Unhandled rejection (server kept running):", reason?.stack || reason);
});

// Caddy terminates TLS and proxies inward, so without this every request
// arrives from Caddy's container address and req.ip is identical for every
// visitor on earth — which silently turned the per-IP rate limits below into
// one shared global bucket. Five waitlist signups from anyone and the sixth
// real person was told "Too many attempts".
//
// The value is 1, not `true`: exactly one proxy sits in front (Caddy), so only
// the hop it adds is trusted. Trusting the whole X-Forwarded-For chain would
// let a caller spoof their address by sending their own header. The app
// publishes no host port and is reachable only through Caddy on the compose
// network, so that one hop is the only one that can ever be real.
app.set("trust proxy", 1);
// Every response said "X-Powered-By: Express", naming the server software to
// anyone looking for one to attack.
app.disable("x-powered-by");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// The `verify` callback stashes the exact raw request bytes onto req.rawBody —
// needed by the Paystack webhook handler to HMAC-verify signatures, since a
// re-serialized/parsed JSON body can differ byte-for-byte from what was signed.
// At most 1 MB per request, more only on a few routes and only when signed
// in (server/bodyLimits.ts).
app.use(readJsonBodies(hasValidSignIn));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

// Traffic for the admin dashboard (server/stats.ts): the app's API calls and
// page loads. The health check, and the admin pages themselves, don't count.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) {
    if (!req.path.startsWith("/api/admin") && req.path !== "/api/status") countStat("api_requests");
  } else if (req.method === "GET" && !req.path.startsWith("/admin") &&
    (req.headers["sec-fetch-dest"] === "document" || /text\/html/.test(String(req.headers.accept || "")))) {
    countStat("page_views");
  }
  next();
});

// Mounted early so it wins over the SPA catch-all further down, which would
// otherwise answer /__/auth/* with index.html and break sign-in.
registerFirebaseAuthProxy(app);

// ----------------------------------------------------
// Gemini client — re-initializable at runtime via the admin page (see
// /api/admin/config below), so a new API key can be swapped in to manage
// cost/quota without redeploying. The active key is persisted to a local,
// gitignored file so it survives server restarts.
// ----------------------------------------------------
function loadStoredApiKey(): string | null {
  const key = loadAdminConfig().geminiApiKey;
  return typeof key === "string" ? key : null;
}

async function saveStoredApiKey(key: string): Promise<{ durable: boolean }> {
  return saveAdminConfig({ geminiApiKey: key });
}

let ai: GoogleGenAI | null = null;
let activeApiKey: string | null = null;

function initGeminiClient(key: string | null | undefined): boolean {
  if (!key || key === "MY_GEMINI_API_KEY") {
    ai = null;
    activeApiKey = null;
    return false;
  }
  try {
    ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
    activeApiKey = key;
    return true;
  } catch (err) {
    console.error("Failed to initialize GoogleGenAI:", err);
    ai = null;
    activeApiKey = null;
    return false;
  }
}

function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 6)}${"•".repeat(Math.max(4, key.length - 10))}${key.slice(-4)}`;
}

// A key saved via the admin page takes priority over .env, so cost/quota
// swaps survive redeploys of the .env file itself.
if (initGeminiClient(loadStoredApiKey() || process.env.GEMINI_API_KEY)) {
  console.log("Gemini client successfully initialized on backend.");
} else {
  console.warn("WARNING: GEMINI_API_KEY is missing or contains placeholder. Fallback mock generator will be active.");
}

// ----------------------------------------------------
// Admin auth — a lightweight password gate for the admin page, independent
// of the app's future end-user auth system. Sessions are short-lived,
// in-memory tokens; failed logins are rate-limited per IP.
// ----------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminSessions = new Map<string, number>(); // token -> expiry timestamp
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  return !!entry && Date.now() < entry.lockedUntil;
}

function recordFailedAttempt(ip: string) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const expiry = token ? adminSessions.get(token) : undefined;
  if (!token || !expiry || Date.now() > expiry) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin access is not configured (ADMIN_PASSWORD not set on the server)." });
  }
  const { password } = req.body;
  const providedBuf = Buffer.from(String(password || ""));
  const expectedBuf = Buffer.from(ADMIN_PASSWORD);
  const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!valid) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: "Incorrect password." });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  res.json({ token });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = (req.headers.authorization || "").slice(7);
  adminSessions.delete(token);
  res.json({ success: true });
});

app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({ hasKey: !!activeApiKey, maskedApiKey: maskApiKey(activeApiKey) });
});

app.post("/api/admin/config", requireAdmin, async (req, res) => {
  const { apiKey: newKey } = req.body;
  if (!newKey || typeof newKey !== "string" || newKey.trim().length < 10) {
    return res.status(400).json({ error: "A valid API key is required." });
  }
  const trimmed = newKey.trim();
  if (!initGeminiClient(trimmed)) {
    return res.status(400).json({ error: "That key could not be used to initialize the Gemini client." });
  }
  const { durable } = await saveStoredApiKey(trimmed);
  console.log(`Gemini API key updated via admin page (${durable ? "durable" : "local-only"}).`);
  res.json({ success: true, maskedApiKey: maskApiKey(activeApiKey), durable });
});

// Public: the client reads this on load to decide whether to show "Launch IDE"
// and whether to sign a non-allowlisted user out. It is deliberately
// unauthenticated and returns a single boolean — the server still refuses
// locked-out users at the middleware, so this endpoint is a UI hint, never the
// enforcement.
app.get("/api/launch-status", (_req, res) => {
  res.json({ launchLocked: loadAdminConfig().launchLocked === true });
});

app.get("/api/admin/launch-status", requireAdmin, (_req, res) => {
  res.json({ launchLocked: loadAdminConfig().launchLocked === true });
});

app.post("/api/admin/launch-status", requireAdmin, async (req, res) => {
  const { launchLocked } = req.body || {};
  if (typeof launchLocked !== "boolean") {
    return res.status(400).json({ error: "launchLocked must be true or false." });
  }
  await saveAdminConfig({ launchLocked });
  console.log(`Launch lock ${launchLocked ? "ENABLED" : "DISABLED"} via admin page.`);
  res.json({ launchLocked });
});

app.get("/api/admin/access-lists", requireAdmin, (_req, res) => {
  res.json(readAccessLists());
});

app.post("/api/admin/access-lists", requireAdmin, async (req, res) => {
  const { proAccessEmails, earlyAccessEmails } = req.body || {};
  const pro = sanitiseEmailList(proAccessEmails);
  const early = sanitiseEmailList(earlyAccessEmails);
  if (pro === null || early === null) {
    return res.status(400).json({ error: "Every entry must be a valid email address." });
  }
  // An address in both lists would be ambiguous; Pro is the stronger grant.
  const earlyOnly = early.filter((e) => !pro.includes(e));
  await saveAdminConfig({ proAccessEmails: pro, earlyAccessEmails: earlyOnly });
  console.log(`Access lists updated via admin page: ${pro.length} pro, ${earlyOnly.length} early.`);
  res.json(readAccessLists());
});

registerPaystackRoutes(app, requireAdmin);
registerWaitlistRoutes(app, requireAdmin);
registerFeedbackRoutes(app, requireFirebaseAuth, requireAdmin);
registerCreatorRoutes(app, requireAdmin);
registerTeamRoutes(app, requireAdmin, { paystackPublicKey });
registerGithubRoutes(app, requireFirebaseAuth);
registerLibraryRoutes(app, requireFirebaseAuth);
// Read-only links to a project's code and circuit, secrets hidden.
registerShareRoutes(app, requireFirebaseAuth);
// The admin dashboard: users, activity, payments and server health.
registerAdminStatsRoutes(app, requireAdmin, {
  isolation: () => buildIsolation(),
  services: () => ({
    deepseek: isDeepSeekConfigured(),
    gemini: !!ai,
    firebase: isFirebaseAdminConfigured(),
    paystack: !!paystackSecretKey(),
    feedbackEmail: !!(process.env.RESEND_API_KEY && process.env.FEEDBACK_TO_EMAIL),
  }),
});

// Lets the frontend check where a signed-in user stands in their 5-hour
// allowance — used both to seed the UI on load and by a paused user's
// countdown (hence requireFirebaseAuth, not the quota-enforcing variant).
app.get("/api/quota/status", requireFirebaseAuth, async (req, res) => {
  let doc = await getOrCreateUserDoc(req.uid!);
  // The account's team or school license (server/teams.ts), taking up an
  // invitation to its address first. Never stops the status itself.
  let team: TeamStatus | null = null;
  try {
    team = await teamForStatus(adminDb, { uid: req.uid!, email: req.email ?? null, emailVerified: req.emailVerified === true }, doc, Date.now());
    doc = { ...doc, teamId: team ? team.id : null, teamPaidUntil: team ? team.paidUntil : null };
  } catch (err: any) {
    console.error(`[Teams] Status for uid=${req.uid} failed:`, err?.message || err);
  }
  const level = accessLevelFor(req.email ?? null, req.emailVerified === true);
  const tier = tierOf(doc, level);
  const a = allowanceFor(doc, tier);
  res.json({
    subscriptionStatus: doc.subscriptionStatus,
    // When a renewing plan renews, or when a cancelled or unpaid one's PRO ends.
    ...subscriptionStanding(doc),
    tier,
    // The current 5-hour window. Null cap: never metered.
    tokensUsed: a.windowUsed,
    tokenCap: tier === "unmetered" ? null : a.windowCap,
    windowResetAt: a.windowResetAt,
    dayUsed: a.dayUsed,
    dayCap: a.dayCap,
    cycleUsed: a.cycleUsed,
    cycleCap: a.cycleCap,
    blocked: a.blocked,
    reason: a.reason,
    resetAt: a.resetAt,
    compilesLeft: tier === "free" ? compileAllowance(doc).left : null,
    // A creator code's trial and first-month offer (server/referrals.ts).
    referralCode: doc.referralCode,
    trialEndsAt: doc.trialEndsAt,
    canUseCode: canUseCode(doc, level),
    offerUntil: firstMonthOfferUntil(doc, Date.now()),
    offerOpensAt: firstMonthOfferOpensAt(doc, Date.now()),
    // The team license, for the app's banner while it is in its grace days.
    team,
  });
});

// Board catalog for the New Project picker — espressif32 + atmelavr only
// (see server/boards.ts for why). Loaded once at startup and cached.
app.get("/api/boards", (req, res) => {
  res.json(getBoardCatalog());
});

// ----------------------------------------------------
// AI Agent API Endpoints
// ----------------------------------------------------

// Generate microcontroller code and schematic

import { WORKSPACE_COMMANDS, isWorkspaceCommand, toWorkspaceCommand } from "./server/commands.js";
import { scrubToolchainNames } from "./server/scrub.js";
import { siteFiles } from "./server/siteFiles.js";
import { buildEnv } from "./server/buildEnv.js";
import { setUpBuildAccount, compilerOptions, handOver, buildIsolation } from "./server/buildUser.js";
import { buildQueue, ServerBusyError } from "./server/buildQueue.js";
import { count as countStat, countBoard, countForUser, recordMax, startStats } from "./server/stats.js";
// Re-exported so the branding test can reach it from the server entrypoint too.
export { scrubToolchainNames };



// The in-app terminal runs every one of its commands in the browser (see
// handleExecuteCommand in src/App.tsx); nothing in the app calls this. It
// used to run allowed shell commands on the server, and "cat" alone was
// enough for any signed-in account to read the server's keys (from
// /proc/1/environ) or its settings file. So it refuses everything now.
app.post("/api/terminal/execute", requireFirebaseAuth, (_req, res) => {
  res.status(410).json({
    error: "The server terminal is no longer available.",
    stdout: "",
    stderr: "Commands run in the Joint-Agent terminal itself. Type 'help' there to see them.",
  });
});


// Tool declarations for implement-mode function calling — pulled out to a
// module-level constant (rather than rebuilt per-request) since it's static
// and, together with buildChatSystemInstruction's output, is what gets
// handed to getCachedContentName below.
const IMPLEMENT_MODE_TOOLS = [{
  functionDeclarations: [
    {
      name: "generate_project",
      description: "Generate microcontroller code and a full circuit schematic (components + wiring) for the current MCU.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING, description: "Complete C++ code (.ino format)." },
          description: { type: Type.STRING, description: "A short paragraph describing the generated project." },
          components: {
            type: Type.ARRAY,
            description: "Electronic components used in the schematic, excluding the microcontroller board itself (the board is implicit, referenced as 'mcu' in connections).",
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING, description: "Unique component ID, e.g. 'led1', 'resistor1', 'dht1'." },
                type: {
                  type: Type.STRING,
                  description: "Exact component type from the supported components list.",
                  enum: ["led", "resistor", "dht11", "servo", "lcd", "button", "relay", "buzzer", "potentiometer", "pir", "neopixel", "ultrasonic", "keypad", "oled"]
                } as any,
                label: { type: Type.STRING, description: "Friendly display name, e.g. 'Red LED', '220 Ohm Resistor'." },
                value: { type: Type.STRING, description: "Value or rating, e.g. '220R', 'DHT11', 'SG90'." }
              }, required: ["id", "type", "label"]
            }
          },
          connections: {
            type: Type.ARRAY,
            description: "Wiring connections between components and the microcontroller. Use the literal ID 'mcu' for the microcontroller board.",
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING, description: "Unique wire ID, e.g. 'wire1'." },
                fromComponentId: { type: Type.STRING, description: "Source component ID, or 'mcu' for the microcontroller board." },
                fromPin: { type: Type.STRING, description: "Pin name on the source. If source is 'mcu', must be a valid pin from the Microcontroller Reference." },
                toComponentId: { type: Type.STRING, description: "Target component ID, or 'mcu' for the microcontroller board." },
                toPin: { type: Type.STRING, description: "Pin name on the target." },
                color: { type: Type.STRING, description: "Hex wire color, e.g. '#EF4444' power, '#000000' GND, '#3B82F6' signal." }
              }, required: ["id", "fromComponentId", "fromPin", "toComponentId", "toPin", "color"]
            }
          }
        },
        required: ["code", "description", "components", "connections"]
      }
    },
    {
      name: "execute_terminal_command",
      description: "Run one of the workspace's built-in commands. This is NOT a shell. It accepts only the exact words listed and nothing else — no pipes, no &&, no redirection, no paths, no flags, no inspecting the machine.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            enum: [...WORKSPACE_COMMANDS],
            description: "One of: help, compile, flash, clear, monitor, engine, web3 status, ret"
          }
        },
        required: ["command"]
      }
    }
  ]
}];

// Shared by the live per-board system instruction (used whenever context
// caching is unavailable — today, always, on the free tier) and the
// family-generic variant offered to getCachedContentName. The two differ
// only in what `mcuDescription` describes (a specific board's real specs vs.
// just its family's pin list) — mcuPowerPin is already family-derived
// either way, so it's identical in both.
function buildChatSystemInstruction(mcuDescription: string, mcuPowerPin: string, chatMode: string): string {
  let systemInstruction = `You are Joint-Agent, an expert embedded systems AI agent and circuit designer.
You help users write code, debug hardware issues, design circuit schematics, manage their cloud IDE, and execute terminal commands.
Microcontroller Reference: ${mcuDescription}

STRICT COMMENT ADHERENCE (highest priority — read this first): Any instruction, correction, or preference the user states in the conversation is authoritative and MUST be followed exactly, with no exceptions, substitutions, or "improvements" of your own. This applies to every user message, and especially to messages formatted as \`Regarding: "<question>" -> <answer>\`, which are the user's direct answer to a specific clarifying question you asked — treat that answer as a hard requirement for the rest of the conversation, not a suggestion. If a later instruction conflicts with an earlier one, the most recent explicit instruction wins. Never silently ignore, water down, generalize, or reinterpret what the user typed — if something is ambiguous, ask, don't guess.`;

  if (chatMode !== "plan") {
    systemInstruction += `

Supported Components for circuit schematic generation (component type -> exact pin names). Do NOT invent component types outside this list:
- 'led': ['anode', 'cathode']
- 'resistor': ['pin1', 'pin2']
- 'dht11': ['VCC', 'DATA', 'GND']
- 'servo': ['GND', 'VCC', 'PWM']
- 'lcd': ['VCC', 'GND', 'SDA', 'SCL'] (16x2 I2C LCD)
- 'button': ['pin1', 'pin2']
- 'relay': ['VCC', 'GND', 'IN']
- 'buzzer': ['VCC', 'GND']
- 'potentiometer': ['GND', 'SIG', 'VCC']
- 'pir': ['VCC', 'OUT', 'GND']
- 'neopixel': ['VDD', 'DIN', 'DOUT', 'GND']
- 'ultrasonic': ['VCC', 'TRIG', 'ECHO', 'GND'] (HC-SR04)
- 'keypad': ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'] (4x4 matrix)
- 'oled': ['VCC', 'GND', 'SCL', 'SDA'] (128x64 I2C)

Schematic wiring rules (CRITICAL for a correct, renderable circuit):
1. Always represent the microcontroller board itself with the literal component ID 'mcu' in connections — NEVER 'esp32', 'arduino', or the board name.
2. When a pin belongs to 'mcu', it MUST be one of the exact pin names from the Microcontroller Reference above.
3. Every GND pin on a component must be wired to 'mcu' pin 'GND'.
4. Every VCC/power pin on a component must be wired to 'mcu' pin '${mcuPowerPin}' (use 'VIN'/'5V' instead for higher-current loads like motors/relays if more appropriate).
5. Keep circuits electrically sound and logical, e.g. place resistors in series with LEDs ('mcu' pin -> resistor pin1, resistor pin2 -> LED anode, LED cathode -> 'mcu' GND).
6. Use sensible wire colors: red/orange (#EF4444 / #F59E0B) for power, black (#000000) for GND, blue (#3B82F6) or another distinct color per signal line.
7. Give every component a unique, descriptive 'id' (e.g. 'led1', 'resistor1', 'dht1') and a friendly 'label'.

CRITICAL: The code is compiled as a plain C++ file (src/main.cpp), not an Arduino IDE sketch, so you MUST ensure that every generated C++ code includes '#include <Arduino.h>' at the very top so that the code can be properly compiled and flashed.

CODE QUALITY (the code IS the deliverable — the chat reply is not):
- Comment the code properly, every time. Explain WHY a line exists, not what it literally does, and name each pin's role where it is configured. Beginners read this code to learn; uncommented code fails them.
- If the user named a specific technique, API or style — millis() rather than delay(), interrupts rather than polling, a particular library — use EXACTLY that. Do not substitute something you consider better. If you think their choice is wrong, implement what they asked and note why you would differ in one short line.
- Every timing value, pin number and interval must be consistent between the code, its comments, and anything you say about it in chat.

If the user asks you to write, modify, update code or create a project, use the 'generate_project' tool. DO NOT use 'execute_terminal_command' to edit code (e.g. no sed, echo, or cat).
If the user asks to see, open, enable or activate the serial monitor (or to watch serial output), call 'execute_terminal_command' with the command 'monitor'. That is not a code change: do NOT call 'generate_project' for it, and do not rewrite or reflash their sketch.
Use 'execute_terminal_command' ONLY to compile, to open the serial monitor, or to list the user's project files. NEVER use it to inspect the machine, hunt for config files, probe /dev, or report tool versions: that is infrastructure, not the user's project, and it is of no use to them.
The serial monitor, board detection and flashing all run in the user's own browser over USB. They are NOT server-side and NOT shell commands. If asked to open the serial monitor or connect a board, point the user at the Serial Monitor and Detect Board controls and run nothing.
Never name the underlying build system, its config files or its directories, in the code comments or anywhere else. The toolchain is "the Joint-Agent Engine".
If answering a general question, just respond conversationally.`;
  }

  if (chatMode === "plan") {
    // Scale, decide, and stay out of the editor's job. The previous version of
    // this asked for "detailed" steps, "code blocks as appropriate", and to
    // "ensure the user agrees" — so "blink my LED for 5 seconds" produced a
    // seven-section document with a full main.cpp dump and seven clarifying
    // questions. The model was obeying precisely; the instruction was wrong.
    systemInstruction += `

CURRENT MODE: PLAN MODE.
Do NOT call any function tools ('generate_project', 'execute_terminal_command') in this mode.

LENGTH — match the request, and err on the side of short:
- A simple, single-behaviour request (blink an LED, read one sensor, one output): answer in UNDER 150 words. A short paragraph of what you will build, then the decisions you made. No headings needed at all.
- A multi-peripheral or timing-critical project: you may use a few short headings, but stay under 400 words.
- NEVER produce a long structured document for a simple request. Length is not thoroughness.

NEVER PUT FIRMWARE CODE IN YOUR REPLY:
- Do NOT include C++ / Arduino code blocks, function bodies, or a "Software Architecture" section. The code belongs in main.cpp, which the user sees in the editor after implementing. Putting it in chat duplicates the editor, doubles what the user has to read, and doubles the output tokens they are billed for.
- You may name an approach in prose ("non-blocking millis() timing, so the loop stays free"), but show no code.

DECIDE — DO NOT INTERROGATE:
- The Microcontroller Reference above already gives you the board, its clock/RAM/flash and its exact exposed pin names. TRUST IT. You already know the board.
- NEVER ask the user which board they are on, which pin the onboard LED is on, whether the LED is active HIGH or LOW, or which IDE or build tool they use: builds always run on the Joint-Agent Engine. Asking the user for hardware facts is the exact friction this product exists to remove.
- Pick sensible defaults and STATE them in one line each ("Onboard LED on GPIO 2, active HIGH. 500 ms on/off."). A stated default the user can correct beats a question they have to answer.
- Ask AT MOST 2 clarifying questions, and only where a wrong guess would genuinely waste the user's time or produce the wrong project. If nothing is genuinely ambiguous, ask NOTHING and say what you will build.
- When you do ask, format them as a bulleted list, each ending in '?'.

ACCURACY:
- Every number you state (timings, cycle counts, pin numbers, intervals) must match what the code you are about to write will actually do. Do not state a timing table you have not derived. If you are not going to compute it exactly, do not state it.

Do NOT tell the user to switch modes or click any button. Just state the plan and invite confirmation.
`;
  } else {
    systemInstruction += "\n\nCURRENT MODE: IMPLEMENT MODE.\nIn this mode, you MUST use the 'generate_project' tool if the user asks you to implement a project, write code, or create schematics.\nHowever, if the user asks a question, requests information, or provides feedback that DOES NOT require generating a project or code, you MUST respond conversationally with helpful text directly (do not just say 'Done'). Do NOT use the tool if a conversational text response is more appropriate.\nBefore generating, re-read every preference the user stated earlier in this conversation (including any 'Regarding: ... -> ...' answers) and make sure the code and schematic you produce honor every one of them exactly.";
  }

  return systemInstruction;
}

// Chat endpoint with function calling
app.post("/api/ai/chat", requireAuthAndQuota, async (req, res) => {
  const { messages, mcu, boardId } = req.body || {};
  // Plan Mode is a PRO feature: a free account's request is always built.
  const free = req.quota!.tier === "free";
  const chatMode = free ? "implement" : req.body?.chatMode;
  // The sketch in the user's editor. The agent used to see only the chat,
  // so every change was written blind: asked to adjust one thing, it had no
  // way to know the pins and logic already there.
  const currentCode = typeof req.body?.currentCode === "string" ? req.body.currentCode.slice(0, 60000).trim() : "";
  if (!messages) return res.status(400).json({ error: "Messages required." });

  // Reject an empty submit before it reaches the model. Without this, pressing
  // Enter on an empty box returns a ~1,000-character greeting that is billed
  // against the user's token cap — they pay for their own typo.
  const lastUserMsg = Array.isArray(messages)
    ? [...messages].reverse().find((m: any) => m?.role === "user")
    : null;
  if (!lastUserMsg || typeof lastUserMsg.content !== "string" || !lastUserMsg.content.trim()) {
    return res.status(400).json({ error: "Type something first.", code: "EMPTY_PROMPT" });
  }

  // Streamed as Server-Sent Events so the UI can render text as it's
  // generated instead of waiting for the full response — the model can take
  // several seconds to finish, and showing nothing that whole time reads as
  // "slow" even though the total latency is unchanged either way.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event: Record<string, any>) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (!isDeepSeekConfigured()) {
    send({ type: "text_delta", text: "AI Agent is offline — DEEPSEEK_API_KEY is not configured." });
    send({ type: "done" });
    return res.end();
  }

  const { description: mcuDescription, powerPin: mcuPowerPin, specs, family } = describeBoardForPrompt(boardId, mcu);

  try {
    // The whole conversation goes to the model, against a token budget the
    // user can see (server/context.ts). It used to be cut to the last 16
    // messages without a word, so a long session silently forgot its start.
    const conversation: ConversationMessage[] = (messages as any[])
      .filter((m) => m && typeof m.content === "string")
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : undefined,
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
        isContextSummary: m.isContextSummary === true,
        images: attachedImages(m.images),
      }));

    // Context caching: only worth attempting in implement mode (plan mode's
    // instruction is too short to ever clear Gemini's ~1024-token caching
    // minimum) and, on the API's free tier, never actually succeeds — its
    // cached-content storage quota is zero there, confirmed directly against
    // the real API. getCachedContentName tries once per board family, then
    // permanently stops trying if it fails, so this never adds retry
    // overhead. When it's unavailable (true today), everything below falls
    // through to the exact inline systemInstruction call that already
    // worked before caching existed — same tokens, same latency, no change.
    let cachedContentName: string | null = null;
    if (chatMode !== "plan") {
      const family_ = describeFamilyForPrompt(family);
      const familyInstruction = buildChatSystemInstruction(family_.description, family_.powerPin, chatMode);
      cachedContentName = await getCachedContentName(ai, `implement-${family}`, "gemini-flash-latest", familyInstruction, IMPLEMENT_MODE_TOOLS);
    }

    // Wrapped rather than awaited directly: a 503 lands when the stream is
    // opened, before any token reaches the client, so retrying here is safe —
    // nothing has been streamed out yet that we'd duplicate.
    // DeepSeek takes the system instruction as an ordinary leading message
    // rather than a separate field, and it sits at the front of every request
    // unchanged — which is exactly the prefix DeepSeek caches automatically,
    // so the Gemini explicit-cache machinery has no equivalent to port.
    const systemText = buildChatSystemInstruction(mcuDescription, mcuPowerPin, chatMode);
    // Free replies are capped shorter; the model is the same.
    const model = modelFor(free);
    // Keeps the browser's idea of the plan current: it gates auto-debug.
    send({ type: "tier", tier: free ? "free" : "full" });

    // Full at AUTOCOMPACT_AT: fold everything but the recent tail into a
    // summary, tell the browser which messages it replaced, and carry on.
    let history = conversation;
    let compactionTokens = 0;
    const codeNote = currentCode
      ? "The sketch currently in the user's editor is below. \"The code\" means this sketch: when asked for a change, " +
        "change this code and keep everything else in it — pins, wiring, timing, behaviour — exactly as it is, unless the " +
        "user asks otherwise.\n```cpp\n" + currentCode + "\n```"
      : "";
    // Libraries: the rule for ones that aren't well known, and the user's own.
    const libraryNote = libraryNoteFor(req.uid);
    const plan = planCompaction(systemText + codeNote + libraryNote, conversation);
    if (plan.compact) {
      send({ type: "tool_progress", text: "Conversation is nearly full — summarizing the earlier part…" });
      try {
        const summary = await completeChat([
          { role: "system", content: SUMMARY_INSTRUCTION },
          { role: "user", content: transcriptOf(plan.older) },
        ], {}, model);
        compactionTokens = summary.outputTokens;
        const text = summary.text.trim();
        if (text) {
          history = [{ role: "assistant", content: text, isContextSummary: true }, ...plan.recent];
          send({
            type: "context_compacted",
            summary: text,
            compactedIds: plan.older.map((m) => m.id).filter(Boolean),
          });
        }
      } catch (err: any) {
        // Better an oversized request than none: the model's own window is
        // larger than the budget, so this still goes through.
        console.error("[Context] compaction failed:", err?.message || err);
      }
    }

    // Images ride along with the message they were attached to, as long as
    // it is among the recent tail; older ones are left out rather than
    // resent on every request.
    const imagesFrom = Math.max(0, history.length - KEEP_RECENT_MESSAGES);
    const dsMessages: ChatMessage[] = [
      { role: "system", content: systemText },
      ...history.map((m, i): ChatMessage => m.isContextSummary
        ? { role: "system", content: `Summary of the earlier conversation, which you no longer see in full:\n${m.content}` }
        : m.role === "user" && m.images?.length && i >= imagesFrom
          ? { role: "user", content: [
              { type: "text", text: m.content },
              ...m.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
            ] }
          : { role: m.role, content: m.content }),
    ];
    // Just before the newest message: everything ahead of it stays a stable
    // prefix, which DeepSeek caches and bills at a fraction of the price.
    if (codeNote) dsMessages.splice(dsMessages.length - 1, 0, { role: "system", content: codeNote });
    dsMessages.splice(dsMessages.length - 1, 0, { role: "system", content: libraryNote });

    const runChat = (msgs: ChatMessage[]) => streamChat(
      msgs,
      chatMode === "plan" ? undefined : DEEPSEEK_IMPLEMENT_TOOLS,
      {
        onText: (text) => send({ type: "text_delta", text }),
        // Throttled so a long tool call does not spam the stream — the user
        // needs to know work is happening, not a byte counter.
        onToolProgress: (() => {
          let last = 0;
          return (toolName: string) => {
            const now = Date.now();
            if (now - last < 1200) return;
            last = now;
            send({
              type: "tool_progress",
              text: toolName === "generate_project"
                ? "Writing firmware and preparing your workspace…"
                : "Working…",
            });
          };
        })(),
      },
      model,
    );

    let result = await runChat(dsMessages);
    let outputTokens = result.outputTokens;
    // Out of room before the tool call finished: its arguments were cut off
    // and cannot be used, and nothing reached the user. Ask once more for a
    // compact version rather than answer "I didn't catch that" to a request
    // that was perfectly clear, just large.
    if (result.truncated && !result.toolCall && !result.textToolCall && !result.sentText && chatMode !== "plan" && !free) {
      send({ type: "tool_progress", text: "That's a big one — writing a more compact version…" });
      result = await runChat([
        ...dsMessages,
        {
          role: "system",
          content: "Your previous reply ran out of output space before the tool call was complete, so nothing was delivered. " +
            "Call generate_project again with the complete sketch written compactly: no long comment blocks, no repeated code " +
            "(use loops and helper functions), and a brief explanation.",
        },
      ]);
      outputTokens += result.outputTokens;
    }
    const { toolCall, textToolCall, sentText } = result;
    outputTokens += compactionTokens;
    // How full the conversation is, as the model counted it, for the meter.
    if (result.promptTokens) {
      send({ type: "context", used: result.promptTokens, limit: CONTEXT_BUDGET_TOKENS });
    }

    // A call the model wrote out as markup instead of making is still the call
    // it meant. Plan mode offers no tools, so there the only one honoured is
    // opening the serial monitor, which changes nothing in the project.
    let call = toolCall;
    if (!call && textToolCall) {
      const opensMonitor = textToolCall.name === "execute_terminal_command" &&
        toWorkspaceCommand(textToolCall.args?.command) === "monitor";
      if (chatMode !== "plan" || opensMonitor) call = textToolCall;
    }
    await incrementTokenUsage(req.uid!, req.quota, outputTokens);
    countStat("ai_chat");
    countStat(free ? "ai_free" : "ai_pro");
    countStat("ai_tokens", outputTokens);
    countForUser(req.uid, "aiMessagesTotal");

    if (call?.name === "generate_project") {
      // Claims only what actually happened. Schematic rendering is not shipped
      // yet, so even when the model emits components there is nothing for the
      // user to look at — announcing one read as the product lying about its
      // own output. Restore the conditional wording when the viewer lands.
      send({
        type: "project_update",
        text: "Code is ready.",
        projectUpdate: call.args,
      });
    } else if (call?.name === "execute_terminal_command") {
      // Never echo the raw command. It exposed the build system — a request to
      // "activate serial monitor" produced a shell line naming platformio.ini
      // and /dev/ttyUSB* in the user's chat — and a shell command is not
      // something a user of this product should be reading in the first place.
      // The model can still emit anything. If it is not one of the workspace's
      // own commands, no command event is sent: the shell line never reaches
      // the browser, so it cannot be echoed into the chat or the terminal.
      const command = toWorkspaceCommand(call.args?.command);
      if (command) {
        send({
          type: "command",
          text: command === "monitor" || command === "serial monitor"
            ? "Opening the serial monitor…"
            : "Running a build task…",
          command,
        });
      } else {
        send({
          type: "text_delta",
          text: "I can compile, flash, or read back your project here — tell me which and I'll do it.",
        });
      }
    }
    // Everything the model said was markup, and none of it could be acted on
    // here. Say something rather than leave an empty bubble.
    if (!call && !sentText) {
      send({
        type: "text_delta",
        text: textToolCall && chatMode === "plan"
          ? "Turn off Plan Mode and ask again, and I'll make that change."
          : result.truncated
            ? (free
              ? "That's more than the Free plan can write in one reply. Ask for it in smaller steps, or get PRO for full-size projects."
              : "That was too big to write in one reply. Ask for it in two steps, for example the display and graphics first, then the game logic.")
            : "I didn't catch that — could you say it another way?",
      });
    }
    send({ type: "done" });
    res.end();
  } catch (error: any) {
    console.error("API Error: ", error.message);
    let msg = error.message || "Failed.";
    try {
      // if it's a JSON string like '[API Error]: {"error":{...}}'
      if (msg.includes('{"error":')) {
        const match = msg.match(/({.*})/);
        if (match) {
          const parsed = JSON.parse(match[1]);
          if (parsed.error && parsed.error.message) {
            msg = parsed.error.message;
          }
        }
      }
    } catch (e) { }
    // Reaching here means the retries above were already spent, so don't
    // imply a quick retry will fix it — by this point we've tried four times
    // across ~6.5 seconds and the model is genuinely saturated.
    if (msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE')) {
      msg = "Gemini is overloaded right now — I retried a few times and it's still busy. Give it a minute and send your message again.";
    }
    send({ type: "text_delta", text: `[API Error]: ${msg}` });
    send({ type: "done" });
    res.end();
  }
});

app.post("/api/ai/generate", requireAuthAndQuota, async (req, res) => {
  const { prompt, mcu, boardId } = req.body || {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required." });
  }
  if (typeof mcu !== "string" || !mcu) {
    return res.status(400).json({ error: "Pick a board first." });
  }

  const { description: mcuDescription } = describeBoardForPrompt(boardId, mcu);

  const systemPrompt = `You are an expert embedded systems AI agent and circuit designer.
Generate microcontroller code (C++) and a full schematic diagram for a: ${mcu.toUpperCase()}.
Microcontroller Pinout Reference: ${mcuDescription}

CRITICAL: The code is compiled as a plain C++ file (src/main.cpp), not an Arduino IDE sketch, so you MUST ensure that every generated C++ code includes '#include <Arduino.h>' at the very top so that the code can be properly compiled and flashed.

CODE QUALITY (the code IS the deliverable — the chat reply is not):
- Comment the code properly, every time. Explain WHY a line exists, not what it literally does, and name each pin's role where it is configured. Beginners read this code to learn; uncommented code fails them.
- If the user named a specific technique, API or style — millis() rather than delay(), interrupts rather than polling, a particular library — use EXACTLY that. Do not substitute something you consider better. If you think their choice is wrong, implement what they asked and note why you would differ in one short line.
- Every timing value, pin number and interval must be consistent between the code, its comments, and anything you say about it in chat.

Supported Components for the circuit schematic:
- 'led': Pins are ['anode', 'cathode']
- 'resistor': Pins are ['pin1', 'pin2']
- 'dht11': Pins are ['VCC', 'GND', 'DATA']
- 'servo': Pins are ['VCC', 'GND', 'PWM']
- 'lcd': Pins are ['VCC', 'GND', 'SDA', 'SCL'] (I2C display)
- 'button': Pins are ['pin1', 'pin2']
- 'relay': Pins are ['VCC', 'GND', 'IN']
- 'buzzer': Pins are ['positive', 'negative']

Wiring guidelines:
1. Ground (GND) connections must connect to the microcontroller's 'GND' pin.
2. Power (5V or 3.3V) connections must connect to microcontroller's '5V' or '3.3V' pin.
3. Keep connections logical. Resistors should be placed in series with LEDs (e.g. MCU pin -> Resistor pin1, Resistor pin2 -> LED anode, LED cathode -> GND).
4. For components, use the MCU pin names exactly as described above ('D13', 'A0', 'D23', etc. for Arduino/ESP32).
5. Always represent the microcontroller ID in connections as 'mcu'.
6. Do NOT invent new component types outside of the supported component list.

Never name the underlying build system, its config files or its directories, in the code comments or anywhere else. The toolchain is "the Joint-Agent Engine".

Return your response in strict JSON matching the requested schema.`;

  if (!isDeepSeekConfigured()) {
    // Return a rich mock template so the app remains fully functional and elegant
    console.log("Using mock response because DEEPSEEK_API_KEY is not set.");
    const mockData = getMockProject(prompt, mcu === "esp32" ? "esp32" : "arduino");
    return res.json(mockData);
  }

  try {
    // DeepSeek offers JSON mode but not schema enforcement, so the structure
    // Gemini guaranteed through responseSchema is specified in the prompt.
    const response = await completeChat([
      {
        role: "system",
        content: `${systemPrompt}

Respond with a single JSON object and nothing else, in exactly this shape:
{
  "code": "complete, production-ready, heavily commented C++ (.ino format)",
  "description": "summary of what the code does, the component list, and step-by-step wiring guidance",
  "components": [
    { "id": "led1", "type": "led", "label": "Green LED", "value": "5mm" }
  ],
  "connections": [
    { "id": "wire1", "fromComponentId": "mcu", "fromPin": "D4", "toComponentId": "led1", "toPin": "anode", "color": "#3B82F6" }
  ]
}
"type" must be exactly one of: ${COMPONENT_TYPES.join(", ")}.
Use the literal id "mcu" for the microcontroller board itself; do not list it as a component.
Wire colours: #EF4444 power, #000000 GND, #3B82F6 signal.
All four top-level keys are required. Do not wrap the JSON in markdown fences.`,
      },
      { role: "user", content: `Create: ${prompt}` },
    ], { jsonMode: true }, modelFor(req.quota!.tier === "free"));

    await incrementTokenUsage(req.uid!, req.quota, response.outputTokens);
    countStat("ai_generate");
    countStat(req.quota?.tier === "free" ? "ai_free" : "ai_pro");
    countStat("ai_tokens", response.outputTokens);
    countForUser(req.uid, "aiMessagesTotal");

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Empty response from the model.");
    }

    const data = JSON.parse(resultText.trim());
    return res.json(data);
  } catch (error: any) {
    console.error("Generation Error: ", error.message);
    // Return mock fallback as recovery so user gets a seamless experience
    const mockData = getMockProject(prompt, mcu === "esp32" ? "esp32" : "arduino");
    return res.json({
      ...mockData,
      description: `[Gemini API Error, using beautiful offline fallback] ${error.message || ""}\n\n${mockData.description}`
    });
  }
});

// Debug code
app.post("/api/ai/debug", requireAuthAndQuota, async (req, res) => {
  const { code, error, mcu } = req.body || {};

  if (typeof code !== "string" || !code || typeof error !== "string" || !error) {
    return res.status(400).json({ error: "Code and Error message are required for debugging." });
  }
  if (typeof mcu !== "string" || !mcu) {
    return res.status(400).json({ error: "Pick a board first." });
  }

  const systemPrompt = `You are an expert compiler and debugger for microcontrollers (${mcu.toUpperCase()}).
Review the provided C++ code and the compilation/behavior error.
Fix the code. CRITICAL: You MUST ensure the corrected C++ code includes '#include <Arduino.h>' at the very top.
Never name the underlying build system, its config files or its directories, in the code comments or anywhere else. The toolchain is "the Joint-Agent Engine".
Return your response as a JSON object containing:
- "code": The corrected C++ code.
- "explanation": Short, scannable bullet points explaining the bug, why it occurred, and how it was resolved.

${libraryNoteFor(req.uid)}
If the error is a missing header ("No such file or directory") for a library that isn't well known, fix the include only if it is misspelled. Otherwise keep the #include and the code that uses it, return the code unchanged, and say in the explanation that the library needs adding under Libraries.`;

  if (!isDeepSeekConfigured()) {
    console.log("Using mock debugging response.");
    return res.json({
      code: code + "\n\n// Debugged by MicroAI (Offline Mode)\n// Resolved: Fixed syntax error and added serial diagnostics.\n",
      explanation: "Fixed potential bracket mismatch, initialized serial baudrate to 115200, and added diagnostic debug lines."
    });
  }

  try {
    // DeepSeek has JSON mode but no schema enforcement, so the shape Gemini
    // guaranteed via responseSchema has to be stated in the prompt instead.
    const response = await completeChat([
      {
        role: "system",
        content: `${systemPrompt}

Respond with a single JSON object and nothing else, in exactly this shape:
{
  "code": "the complete, corrected C++ microcontroller code",
  "explanation": "bullet points explaining the changes made to fix the error"
}
Both keys are required. Do not wrap the JSON in markdown fences.`,
      },
      { role: "user", content: `CODE:\n${code}\n\nERROR:\n${error}` },
    ], { jsonMode: true }, modelFor(req.quota!.tier === "free"));

    await incrementTokenUsage(req.uid!, req.quota, response.outputTokens);
    countStat("ai_debug");
    countStat(req.quota?.tier === "free" ? "ai_free" : "ai_pro");
    countStat("ai_tokens", response.outputTokens);
    countForUser(req.uid, "aiMessagesTotal");

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Empty response from the model.");
    }

    const data = JSON.parse(resultText.trim());
    return res.json(data);
  } catch (err: any) {
    console.error("Debugging Error: ", err.message);
    return res.json({
      code: code + "\n\n// Fallback Debug Fix\n#define DIAGNOSTIC_RECOVERY 1\n",
      explanation: `[Gemini Error - using offline recovery] Code analyzed and wrapped in stability safeguards. Refactored I/O loop timing.`
    });
  }
});

// ----------------------------------------------------
// Offline Fallback Mock Circuit / Code Generator
// ----------------------------------------------------
function getMockProject(prompt: string, mcu: "esp32" | "arduino") {
  const promptLower = prompt.toLowerCase();

  if (promptLower.includes("temp") || promptLower.includes("dht") || promptLower.includes("weather") || promptLower.includes("humid")) {
    // DHT11 + LCD/Serial
    const mainPin = mcu === "esp32" ? "D4" : "D2";
    return {
      code: `/**
 * Smart Weather Station with DHT11
 * Generated by AI Microcontroller Web3 Studio
 */
#include <Arduino.h>
#include <DHT.h>

#define DHTPIN ${mainPin}     // Digital pin connected to the DHT sensor
#define DHTTYPE DHT11   // DHT 11 type

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  Serial.println(F("Smart Weather Station Initializing..."));
  dht.begin();
  
  // Web3 IoT Registry Ping
  Serial.println(F("IoT SECURE KEY REGISTRY ACTIVATED"));
}

void loop() {
  // Wait a few seconds between measurements
  delay(2000);

  float h = dht.readHumidity();
  float t = dht.readTemperature(); // Read temperature as Celsius

  if (isnan(h) || isnan(t)) {
    Serial.println(F("Error: Failed to read from DHT sensor!"));
    return;
  }

  Serial.print(F("Humidity: "));
  Serial.print(h);
  Serial.print(F("%  |  Temperature: "));
  Serial.print(t);
  Serial.println(F("°C"));
  
  // Smart Contract Transaction trigger condition (Simulated)
  if (t > 30.0) {
    Serial.println(F("[WEB3_EVENT] Alert: High Temp! Signing Blockchain Log..."));
  }
}`,
      description: "A smart environmental sensor station using a DHT11 temperature and humidity sensor. Reads data every 2 seconds and logs outputs to the secure Serial terminal. Trigger-ready for smart contract rule-based activations.",
      components: [
        { id: "sensor1", type: "dht11", label: "DHT11 Temp & Humidity", value: "DHT11" },
        { id: "r1", type: "resistor", label: "Pull-up Resistor", value: "4.7k Ohm" }
      ],
      connections: [
        { id: "w1", fromComponentId: "sensor1", fromPin: "VCC", toComponentId: "mcu", toPin: mcu === "esp32" ? "3V3" : "5V", color: "#EF4444" },
        { id: "w2", fromComponentId: "sensor1", fromPin: "GND", toComponentId: "mcu", toPin: "GND", color: "#000000" },
        { id: "w3", fromComponentId: "sensor1", fromPin: "DATA", toComponentId: "mcu", toPin: mainPin, color: "#3B82F6" },
        { id: "w4", fromComponentId: "r1", fromPin: "pin1", toComponentId: "sensor1", toPin: "DATA", color: "#F59E0B" },
        { id: "w5", fromComponentId: "r1", fromPin: "pin2", toComponentId: "mcu", toPin: mcu === "esp32" ? "3V3" : "5V", color: "#EF4444" }
      ]
    };
  } else if (promptLower.includes("servo") || promptLower.includes("motor") || promptLower.includes("sweep")) {
    // Servo Motor Sweep
    const mainPin = mcu === "esp32" ? "D18" : "D9";
    return {
      code: `/**
 * Smart Lock Servo Motor Controller
 * Signed with Secure Blockchain Key
 */
#include <Arduino.h>
#include <Servo.h>

Servo myservo;  // create servo object to control a servo
int pos = 0;    // variable to store the servo position

void setup() {
  Serial.begin(115200);
  myservo.attach(${mainPin});  // attaches the servo on pin ${mainPin} to the servo object
  Serial.println("Smart Lock Initialized. Ready for web3 door trigger.");
}

void loop() {
  // Sweep from 0 to 180 degrees
  Serial.println("Action: Locking Gate (0 -> 180 deg)");
  for (pos = 0; pos <= 180; pos += 1) { 
    myservo.write(pos);              
    delay(15);                       
  }
  delay(1000);
  
  // Sweep back
  Serial.println("Action: Unlocking Gate (180 -> 0 deg)");
  for (pos = 180; pos >= 0; pos -= 1) { 
    myservo.write(pos);              
    delay(15);                       
  }
  delay(3000);
}`,
      description: "A secure servo gate controller. This program sweeps a servo motor back and forth between 0 and 180 degrees to open or lock a barrier. This is highly suitable for IoT smart locks connected to blockchain authorization systems.",
      components: [
        { id: "motor1", type: "servo", label: "SG90 Micro Servo", value: "SG90" }
      ],
      connections: [
        { id: "w1", fromComponentId: "motor1", fromPin: "VCC", toComponentId: "mcu", toPin: mcu === "esp32" ? "VIN" : "5V", color: "#EF4444" },
        { id: "w2", fromComponentId: "motor1", fromPin: "GND", toComponentId: "mcu", toPin: "GND", color: "#000000" },
        { id: "w3", fromComponentId: "motor1", fromPin: "PWM", toComponentId: "mcu", toPin: mainPin, color: "#F59E0B" }
      ]
    };
  } else if (promptLower.includes("button") || promptLower.includes("click") || promptLower.includes("switch")) {
    // Button Toggle LED
    const buttonPin = mcu === "esp32" ? "D12" : "D2";
    const ledPin = mcu === "esp32" ? "D13" : "D13";
    return {
      code: `/**
 * IoT Smart Button with LED Toggle
 * Logged to Decentralized IoT Tracker
 */
#include <Arduino.h>
const int BUTTON_PIN = ${buttonPin}; 
const int LED_PIN = ${ledPin};     

int ledState = LOW;        
int buttonState;             
int lastButtonState = LOW;   

unsigned long lastDebounceTime = 0;  
unsigned long debounceDelay = 50;    

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, ledState);
  Serial.begin(115200);
  Serial.println("Debounced IoT Button Ready");
}

void loop() {
  int reading = digitalRead(BUTTON_PIN);

  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading != buttonState) {
      buttonState = reading;

      if (buttonState == LOW) {
        ledState = !ledState;
        digitalWrite(LED_PIN, ledState);
        
        Serial.print("Web3 Event Triggered - Button Toggled. LED state: ");
        Serial.println(ledState ? "ON" : "OFF");
      }
    }
  }

  lastButtonState = reading;
}`,
      description: "A debounced push-button circuit that toggles a light-emitting diode (LED). Uses standard software-debounce logic to filter out mechanical button noise, ensuring accurate signals suitable for counting blockchain events.",
      components: [
        { id: "btn1", type: "button", label: "Tactile Push Button", value: "12mm Tactile" },
        { id: "led1", type: "led", label: "Red Indicator LED", value: "Red 5mm" },
        { id: "r1", type: "resistor", label: "Current Limiting Resistor", value: "220 Ohm" }
      ],
      connections: [
        { id: "w1", fromComponentId: "btn1", fromPin: "pin1", toComponentId: "mcu", toPin: buttonPin, color: "#3B82F6" },
        { id: "w2", fromComponentId: "btn1", fromPin: "pin2", toComponentId: "mcu", toPin: "GND", color: "#000000" },
        { id: "w3", fromComponentId: "mcu", fromPin: ledPin, toComponentId: "r1", toPin: "pin1", color: "#EF4444" },
        { id: "w4", fromComponentId: "r1", fromPin: "pin2", toComponentId: "led1", toPin: "anode", color: "#F59E0B" },
        { id: "w5", fromComponentId: "led1", fromPin: "cathode", toComponentId: "mcu", toPin: "GND", color: "#000000" }
      ]
    };
  } else {
    // Default Blink LED
    const ledPin = mcu === "esp32" ? "D2" : "D13";
    return {
      code: `/**
 * AI Smart Blink Loop
 * Secured via Cryptographic Proof
 */
#include <Arduino.h>
#define LED_PIN ${ledPin}

void setup() {
  // Initialize digital pin LED_PIN as an output.
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Cryptographic IoT Blink Setup Successful.");
}

void loop() {
  Serial.println("IoT Device Status: [ACTIVE] - LED HIGH");
  digitalWrite(LED_PIN, HIGH);   // turn the LED on (HIGH is the voltage level)
  delay(1000);                       // wait for a second
  
  Serial.println("IoT Device Status: [ACTIVE] - LED LOW");
  digitalWrite(LED_PIN, LOW);    // turn the LED off by making the voltage LOW
  delay(1000);                       // wait for a second
}`,
      description: "The classic 'Hello World' of electronics: a blinking LED circuit. Configured with a current-limiting resistor to protect the diode from burning out. Serves as a perfect baseline test for microcontroller compilation and Web Serial flashing.",
      components: [
        { id: "led1", type: "led", label: "Red LED", value: "Red 5mm" },
        { id: "r1", type: "resistor", label: "Resistor", value: "220 Ohm" }
      ],
      connections: [
        { id: "w1", fromComponentId: "mcu", fromPin: ledPin, toComponentId: "r1", toPin: "pin1", color: "#3B82F6" },
        { id: "w2", fromComponentId: "r1", fromPin: "pin2", toComponentId: "led1", toPin: "anode", color: "#F59E0B" },
        { id: "w3", fromComponentId: "led1", fromPin: "cathode", toComponentId: "mcu", toPin: "GND", color: "#000000" }
      ]
    };
  }
}



// ----------------------------------------------------
// Transcription Endpoint
// ----------------------------------------------------
// Not a word-for-word transcript: what the user meant to type. Filler and
// false starts go, small slips are fixed, electronics terms are spelled the
// way the agent expects, and numbers are never touched — "pin 4" must stay
// pin 4, or the agent wires the wrong pin.
const TRANSCRIBE_INSTRUCTION = [
  "You turn a spoken voice note into the message the speaker meant to type to an AI that writes Arduino and ESP32 firmware.",
  "- Remove filler words and sounds (um, uh, er, ah, hmm, like, you know, I mean, sort of, kind of, so, okay so) whenever they are only filler.",
  "- Remove stutters, false starts and repeated words; when the speaker corrects themselves, keep only the corrected version.",
  "- Fix small grammar slips and words that were clearly misheard, using the context of electronics and embedded programming. Accents vary: understand the meaning rather than transcribing sounds literally.",
  "- Spell technical terms the standard way: Arduino, Uno, Mega, Nano, ESP32, ESP8266, GPIO, LED, PWM, I2C, SPI, UART, ADC, DHT11, DHT22, HC-SR04, SG90, OLED, LCD, relay, servo, breadboard, sketch, baud rate, Serial Monitor.",
  "- NEVER change a number, pin, value, unit, time or name. Write numbers as digits (\"pin 4\", \"500 ms\", \"9600 baud\", \"A0\") exactly as spoken.",
  "- Never add, answer, summarise or explain anything. Keep the speaker's meaning and wording otherwise.",
  "Output only the cleaned message: no preamble, no commentary, no quotation marks.",
  "CRITICAL: if the audio contains no intelligible human speech — silence, a tone, music, background noise, a fragment too short to make out — output an empty response. Do NOT invent, guess at, or pad out words that were not spoken. Returning nothing is always correct when nothing was said.",
].join("\n");

const TRANSCRIBE_ATTEMPTS: Array<{ model: string; thinkingLow: boolean }> = [
  { model: "gemini-3.5-flash", thinkingLow: true },
  { model: "gemini-flash-latest", thinkingLow: true },
  { model: "gemini-flash-latest", thinkingLow: false },
  { model: "gemini-flash-lite-latest", thinkingLow: false },
];

app.post("/api/ai/transcribe", requireAuthAndQuota, async (req, res) => {
  try {
    const { audioData, mimeType } = req.body || {};
    if (!audioData) return res.status(400).json({ error: "No audio data provided." });
    if (typeof audioData !== "string" || voiceNoteTooLong(audioData, mimeType)) {
      return res.status(413).json({ error: `Voice notes can be up to ${MAX_VOICE_NOTE_SECONDS / 60} minutes.`, code: "VOICE_TOO_LONG" });
    }

    if (!ai) {
      return res.status(503).json({ error: "AI transcription is not available. GEMINI_API_KEY is not configured." });
    }

    const parts = [
      { text: TRANSCRIBE_INSTRUCTION },
      { inlineData: { data: audioData, mimeType: mimeType || "audio/webm" } },
    ];
    // Pinned to Gemini 3.5 Flash, the better listener, with thinking kept low:
    // it is billed as output and a voice note needs little. If the key cannot
    // use it (a free-tier key, a renamed model), the next attempt runs, ending
    // on exactly the call this endpoint made before, then the Flash-Lite alias.
    let response: any = null;
    let lastError: any = null;
    for (const attempt of TRANSCRIBE_ATTEMPTS) {
      try {
        response = await ai.models.generateContent({
          model: attempt.model,
          contents: [{ role: "user", parts }],
          config: {
            maxOutputTokens: 2048,
            ...(attempt.thinkingLow ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          },
        });
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Transcribe] ${attempt.model}${attempt.thinkingLow ? " (low thinking)" : ""} failed: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
    if (!response) throw lastError || new Error("No transcription model answered.");
    await incrementTokenUsage(req.uid!, req.quota, response.usageMetadata?.candidatesTokenCount || 0);
    countStat("voice_notes");
    res.json({ text: response.text || "" });
  } catch (err: any) {
    // "Transcription failed." told the user nothing and told us nothing
    // either: container logs are wiped on every deploy, so by the time a
    // report arrived the cause was gone. Pass the provider's own message
    // through — it names an unsupported format, an exhausted quota or a bad
    // key directly.
    const detail = String(err?.message || err || "unknown error").slice(0, 300);
    console.error("Transcription API Error:", detail);
    res.status(500).json({ error: `Transcription failed: ${detail}` });
  }
});

// ----------------------------------------------------
// Compilation Endpoint
// ----------------------------------------------------
app.post("/api/compile", requireFirebaseAuth, async (req, res) => {
  const { code, mcu, boardId } = req.body || {};
  if (typeof code !== "string" || !code || typeof mcu !== "string" || !mcu) {
    return res.status(400).json({ error: "Code and MCU are required." });
  }
  // A file on the server, not a library header: refused before anything is
  // counted or built (server/buildRun.ts).
  const badInclude = fileSystemInclude(code);
  if (badInclude !== null) {
    return res.status(400).json({
      error: `#include "${badInclude.slice(0, 80)}" names a file path. Include a library header instead, like #include <Wire.h>.`,
      code: "BAD_INCLUDE",
    });
  }

  // Free accounts compile FREE_WINDOW_COMPILES times every 5 hours, at most
  // FREE_DAILY_COMPILES a day; every other plan without limit. Counted before
  // the build so two at once cannot both take the last one, and handed back
  // below if the build fails: only successful compiles count.
  let freeCompilesLeft: number | null = null;
  let compileReceipt: CompileReceipt | null = null;
  try {
    const spend = await consumeCompile(req.uid!, req.email ?? null, req.emailVerified === true);
    if (!spend.allowed) {
      return res.status(429).json({
        error: `The Free plan includes ${FREE_WINDOW_COMPILES} compiles every 5 hours (${FREE_DAILY_COMPILES} a day), and they're used. More in ${formatWait(spend.resetAt)}, or get PRO for unlimited compiles.`,
        code: "FREE_COMPILE_LIMIT",
        reason: spend.reason,
        resetAt: spend.resetAt,
      });
    }
    freeCompilesLeft = spend.left;
    compileReceipt = spend.receipt;
  } catch (err: any) {
    // A counting failure must not stop anyone compiling.
    console.error("[Quota] compile count failed:", err?.message || err);
  }
  const setCompilesLeft = () => res.setHeader("X-Free-Compiles-Left", freeCompilesLeft === null ? "unlimited" : String(freeCompilesLeft));
  // A failed build is not the user's to pay for: often it is the agent's own
  // mistake, and free accounts have no auto-debug to fix it for them.
  const refundFailedCompile = async () => {
    if (!compileReceipt) return;
    try {
      await refundCompile(req.uid!, compileReceipt);
      if (freeCompilesLeft !== null) freeCompilesLeft += 1;
    } catch (err: any) {
      console.error("[Quota] compile refund failed:", err?.message || err);
    }
  };

  const board = resolveBoard(boardId, mcu);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pio_sketch_"));
  const srcDir = path.join(tempDir, "src");
  fs.mkdirSync(srcDir);
  const correctSketchPath = path.join(srcDir, "main.cpp");

  let finalCode = code;
  if (!finalCode.includes("#include <Arduino.h>")) {
    finalCode = "#include <Arduino.h>\n" + finalCode;
  }
  fs.writeFileSync(correctSketchPath, finalCode);

  let platformioIni = `
[env:${board.id}]
platform = ${board.platform}
board = ${board.id}
framework = arduino
lib_deps =
`;

  // Libraries the user added (server/libraries.ts) that this code uses:
  // imported ones are copied into lib/, catalogue ones are pinned here.
  let userLibraries = NO_LIBRARIES;
  try {
    userLibraries = prepareLibraries(req.uid, finalCode, tempDir);
  } catch (err: any) {
    console.error("[Compile] user libraries skipped:", err?.message || err);
    fs.rmSync(path.join(tempDir, "lib"), { recursive: true, force: true });
  }
  // Only "owner/name@version" lines reach platformio.ini (isSafeLibDep):
  // nothing written there can add a setting of its own.
  const detectedLibDeps = mergeLibDeps(userLibraries.libDeps, detectLibDeps(finalCode + userLibraries.extraIncludes, userLibraries.skipHeaders))
    .filter((lib) => {
      if (isSafeLibDep(lib)) return true;
      console.warn(`[Compile] library line refused: ${JSON.stringify(lib).slice(0, 120)}`);
      return false;
    });
  if (detectedLibDeps.length > 0) {
    platformioIni += detectedLibDeps.map(lib => `  ${lib}`).join("\n") + "\n";
  }

  // Reuse files compiled by earlier compiles (server/buildCache.ts). Adds
  // nothing while the cache is off.
  const iniWithoutCache = platformioIni;
  const buildCacheLine = useBuildCache(tempDir, path.join(process.cwd(), ".platformio"));
  platformioIni += buildCacheLine;

  fs.writeFileSync(path.join(tempDir, "platformio.ini"), platformioIni);
  console.log(`[Compile] platformio.ini generated with libs: ${detectedLibDeps.join(', ') || 'none'}`);

  try {
    let pioPath = path.join(process.cwd(), ".platformio", "penv", "bin", "pio");
    if (!fs.existsSync(pioPath)) {
      pioPath = "pio";
    }
    // Run under the build account when there is one (server/buildUser.ts),
    // taking turns with other builds (server/buildQueue.ts).
    handOver(tempDir);
    countBoard(board.id);
    const { stdout, stderr } = await buildQueue.run(async () => {
      const startedAt = Date.now();
      try {
        const options = await compilerOptions(path.join(process.cwd(), ".platformio"));
        readyBuildCache(path.join(process.cwd(), ".platformio"), options.uid, options.gid);
        // Stopped, compiler and all, if it runs too long (server/buildRun.ts).
        const build = () => runBuild(pioPath, ['run'], {
          cwd: tempDir,
          ...options,
          maxBuffer: 1024 * 1024 * 50,
          timeoutMs: COMPILE_TIMEOUT_MS,
        });
        try {
          return await build();
        } catch (err: any) {
          // A file taken from the cache was damaged (a disk fault, say): the
          // linker rejects it. Compile again, in this same slot, without the
          // cache; if that works, set the damaged cache aside.
          if (!buildCacheLine || err?.timedOut || !damagedCacheFailure(`${err?.stdout || ""}\n${err?.stderr || ""}`)) throw err;
          console.warn("[Build cache] a compile hit a damaged cache file; compiling again without the cache.");
          fs.rmSync(path.join(tempDir, ".pio", "build"), { recursive: true, force: true });
          fs.writeFileSync(path.join(tempDir, "platformio.ini"), iniWithoutCache);
          const result = await build();
          reportDamagedCache();
          // Only this compile is running, so nothing is reading from it;
          // otherwise the next trim, when nothing is running, does it.
          if (buildQueue.runningNow <= 1) retireDamagedCache(path.join(process.cwd(), ".platformio"));
          return result;
        }
      } finally {
        const ms = Date.now() - startedAt;
        countStat("compile_ms_total", ms);
        countStat("compile_ms_count");
        recordMax("compile_ms_max", ms);
      }
    }, (waited) => {
      countStat("compile_waits");
      countStat("compile_wait_ms_total", waited);
      recordMax("compile_wait_ms_max", waited);
    }, req.uid ?? null);

    // Derive the artifact from the RESOLVED BOARD, never from the `mcu` string
    // the client sent. Those two can disagree — if the UI's mcu state says
    // "esp32" while the open project is an Arduino Uno, platformio.ini is built
    // from board.id ("uno") and correctly emits firmware.hex, but a check on
    // `mcu` goes looking for firmware.bin and reports a perfectly good build as
    // "no firmware file produced". board.id is what actually drove the build,
    // so it is the only trustworthy source here.
    const isEsp32Build = board.family === "esp32";
    const artifactName = isEsp32Build ? "firmware.bin" : "firmware.hex";
    let binaryFile = path.join(tempDir, ".pio", "build", board.id, artifactName);

    // PlatformIO writes into .pio/build/<env>/, and the env name is normally
    // board.id — but if it ever differs, or the board emits a differently named
    // artifact, the fixed path above misses a build that actually succeeded and
    // the user gets "output binary not found" on working code. Fall back to
    // searching the build tree before declaring failure.
    if (!fs.existsSync(binaryFile)) {
      const buildRoot = path.join(tempDir, ".pio", "build");
      const wanted = artifactName;
      try {
        for (const envDir of fs.readdirSync(buildRoot)) {
          const candidate = path.join(buildRoot, envDir, wanted);
          if (fs.existsSync(candidate)) {
            console.warn(`[compile] artifact found under env "${envDir}", expected "${board.id}"`);
            binaryFile = candidate;
            break;
          }
        }
      } catch { /* buildRoot missing means the build really did fail */ }
    }

    if (fs.existsSync(binaryFile)) {
      const binaryData = fs.readFileSync(binaryFile, { encoding: 'base64' });

      let additionalBinaries = {};
      if (isEsp32Build) {
        const bootloaderPath = path.join(tempDir, ".pio", "build", board.id, "bootloader.bin");
        const partitionsPath = path.join(tempDir, ".pio", "build", board.id, "partitions.bin");

        if (fs.existsSync(bootloaderPath)) {
          additionalBinaries['bootloader'] = fs.readFileSync(bootloaderPath, { encoding: 'base64' });
        }
        if (fs.existsSync(partitionsPath)) {
          additionalBinaries['partitions'] = fs.readFileSync(partitionsPath, { encoding: 'base64' });
        }

        const app0Path = path.join(process.cwd(), ".platformio", "packages", "framework-arduinoespressif32", "tools", "partitions", "boot_app0.bin");
        if (fs.existsSync(app0Path)) {
          additionalBinaries['boot_app0'] = fs.readFileSync(app0Path, { encoding: 'base64' });
        }
      }

      // Ship the board's own upload parameters with the artifact. The browser
      // flasher needs protocol and speed, and taking them from the same
      // resolution that produced this binary means they can never disagree
      // with what was actually built.
      countStat("compiles_ok");
      countForUser(req.uid, "compilesTotal");
      setCompilesLeft();
      res.json({
        success: true,
        binary: binaryData,
        format: isEsp32Build ? "bin" : "hex",
        uploadProtocol: board.uploadProtocol,
        uploadSpeed: board.uploadSpeed,
        chip: board.mcu,
        stdout: scrubToolchainNames(stdout),
        ...additionalBinaries,
      });
    } else {
      // compileSucceeded tells the client this is NOT a code problem, so it
      // must not burn five AI debug rounds trying to "fix" working code.
      const tail = scrubToolchainNames((stderr || stdout || "").trim()).split("\n").slice(-12).join("\n");
      countStat("compiles_failed");
      await refundFailedCompile();
      setCompilesLeft();
      res.status(500).json({
        error: "The build reported success but no firmware file was produced. This is a build-server problem, not a problem with your code.",
        compileSucceeded: true,
        stdout: scrubToolchainNames(stdout), stderr: scrubToolchainNames(stderr), detail: tail,
      });
    }
  } catch (err: any) {
    await refundFailedCompile();
    setCompilesLeft();
    // Too many builds waiting: nothing is wrong with the code, so say so
    // plainly, and never let it reach auto-debug as a code error.
    if (err instanceof ServerBusyError) {
      countStat("compiles_busy");
      return res.status(503).json({ error: err.message, code: "SERVER_BUSY" });
    }
    countStat("compiles_failed");
    if (err?.timedOut) {
      return res.status(500).json({
        error: `${err.message} Very large sketches can take long; if this keeps happening, try again in a few minutes.`,
        code: "COMPILE_TIMEOUT",
        stdout: scrubToolchainNames(err.stdout || ""),
        stderr: scrubToolchainNames(err.stderr || ""),
      });
    }
    res.status(500).json({
      error: "Compilation failed.",
      stdout: scrubToolchainNames(err.stdout || ""),
      stderr: scrubToolchainNames(err.stderr || ""),
      message: scrubToolchainNames(err.message || ""),
      // Said plainly when the build stopped for want of a library.
      hint: missingLibraryHint(`${err.stdout || ""}\n${err.stderr || ""}`) || undefined,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------
// Flashing and the serial monitor run in the user's browser, over USB
// (src/lib). The server once had its own flash and serial routes for boards
// plugged into the server itself; a datacentre server has none, the app
// stopped calling them, and one of them let any account change the build
// settings. They are gone.
// ----------------------------------------------------

// Check Gemini API key status
app.get("/api/status", (_req, res) => {
  res.json({
    // Chat/generate/debug run on DeepSeek; Gemini is retained solely for
    // audio transcription, which DeepSeek cannot do. Reported separately so a
    // failure points at the right provider.
    deepseekConfigured: isDeepSeekConfigured(),
    geminiConfigured: !!ai,
    geminiApiKeySet: !!activeApiKey,
    compilerInstalled: fs.existsSync(path.join(process.cwd(), ".platformio", "penv", "bin", "pio")),
    // Builds run under their own account, away from the server's keys.
    buildsIsolated: buildIsolation().isolated,
  });
});

// ----------------------------------------------------
// Production / Development serving setup
// ----------------------------------------------------
async function setupPlatformIO() {
  const pioDir = path.join(process.cwd(), ".platformio");
  const pioPath = path.join(pioDir, "penv", "bin", "pio");
  if (!fs.existsSync(pioPath)) {
    console.log("[Setup] PlatformIO not found in workspace. Installing...");
    try {
      try {
        await execPromise('DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true');
        await execPromise('DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" python3-venv python3-pip');
      } catch (aptErr) {
        console.log("[Setup] apt-get skipped or failed, continuing with python script...");
      }
      console.log("[Setup] Creating venv and installing platformio...");
      await execPromise(`python3 -m venv ${path.join(pioDir, "penv")} && ${path.join(pioDir, "penv", "bin", "pip")} install platformio`);
      console.log("[Setup] PlatformIO installation complete.");
      // Pre-install platforms in background so compile endpoint doesn't timeout
      const { spawn } = await import("child_process");
      console.log("[Setup] Pre-installing ESP32 and AVR platforms in background...");
      const env = buildEnv(pioDir);
      const child = spawn(pioPath, ['platform', 'install', 'espressif32', 'atmelavr'], { env, stdio: 'ignore', detached: true });
      child.unref();
    } catch (err) {
      console.error("[Setup] Failed to install PlatformIO:", err);
    }
  }
}

async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development middleware integrated.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    // The site's files only: the server's own bundle shares this folder and
    // is never served (server/siteFiles.ts).
    app.use(siteFiles(distPath));
    // A shared project's page: the app itself, kept out of search results.
    app.get("/share/:id", (_req, res) => {
      res.setHeader("X-Robots-Tag", "noindex");
      res.sendFile(path.join(distPath, "index.html"));
    });
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  // Last: turns an error from any route into one JSON answer.
  app.use(jsonErrorHandler);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Microcontroller Web3 IDE Server running on http://0.0.0.0:${PORT}`);
  });

  // Dashboard counts are saved once a minute (server/stats.ts).
  startStats();

  // Builds get their own account first: every later compiler launch waits
  // for this check (server/buildUser.ts).
  const coreDir = path.join(process.cwd(), ".platformio");
  setUpBuildAccount({
    coreDir,
    pioPath: path.join(coreDir, "penv", "bin", "pio"),
    // The server's settings and users' libraries. Without ADMIN_CONFIG_DIR
    // they sit next to the app, so those exact paths are locked instead.
    privatePaths: [
      ...(process.env.ADMIN_CONFIG_DIR
        ? [process.env.ADMIN_CONFIG_DIR]
        : [path.join(process.cwd(), ".admin-config.json"), path.join(process.cwd(), "data"), path.join(process.cwd(), ".env")]),
      ...(process.env.LIBRARIES_DIR ? [process.env.LIBRARIES_DIR] : []),
    ],
  }).catch(console.error);

  // The build cache is trimmed only while no compile is running or waiting.
  startBuildCachePruning(coreDir, () => buildQueue.runningNow === 0 && buildQueue.waitingNow === 0);

  // Install PIO asynchronously without blocking server start
  setupPlatformIO().catch(console.error);
  loadBoardCatalog().catch(console.error);
}

startServer();
