import fs from "fs";
import os from "os";
import path from "path";
import type express from "express";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { readAccessLists } from "./access";
import { buildQueue } from "./buildQueue";
import { buildCacheStatus } from "./buildCache";
import { STATS_COLLECTION, liveToday, unflushed, lastHour, utcDay as todayUtc } from "./stats";
import { librariesDirectory } from "./libraries";
import { paystackSecretKey } from "./paystack";
import { getBoardById } from "./boards";
import {
  buildUserRows, summarizeUsers, dayRange, buildSeries, totals, boardTotals, addStats, paymentRows, summarizePayments,
  serverVerdict, type AuthUser, type UserDocSummary, type DailyStats, type PaystackTx,
} from "./adminMetrics";

/**
 * The admin dashboard's data. Every route here is behind the admin password.
 * Users and sign-ups come from Firebase Authentication, plans and per-user
 * totals from each user's Firestore document, projects from the projects
 * collections, daily activity from adminStats (server/stats.ts), payments
 * from Paystack, and server health from the machine itself. Firebase and
 * Paystack are read at most once a minute (projects every five): a
 * dashboard left open doesn't run up reads.
 */

const FREE_PROJECT_LIMIT = 5;

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const ms = (v: unknown): number | null => {
  if (v && typeof (v as any).toMillis === "function") return (v as Timestamp).toMillis();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};

async function authUsers(fresh: boolean): Promise<AuthUser[]> {
  return cached("authUsers", 60_000, fresh, async () => {
    const out: AuthUser[] = [];
    let pageToken: string | undefined;
    do {
      const page = await adminAuth.listUsers(1000, pageToken);
      for (const u of page.users) {
        out.push({
          uid: u.uid,
          email: u.email ?? null,
          name: u.displayName ?? null,
          providers: u.providerData.map((p) => p.providerId),
          verified: !!u.emailVerified,
          disabled: !!u.disabled,
          createdAt: ms(u.metadata.creationTime),
          lastSignInAt: ms(u.metadata.lastSignInTime),
          lastRefreshAt: ms((u.metadata as any).lastRefreshTime),
        });
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return out;
  });
}

async function userDocs(fresh: boolean): Promise<Map<string, UserDocSummary>> {
  return cached("userDocs", 60_000, fresh, async () => {
    const snap = await adminDb.collection("users")
      .select("subscriptionStatus", "currentPeriodEnd", "lastPaymentAt", "pastDueAt", "lastActiveAt", "compilesTotal", "aiMessagesTotal")
      .get();
    const map = new Map<string, UserDocSummary>();
    for (const d of snap.docs) {
      const x = d.data();
      map.set(d.id, {
        subscriptionStatus: typeof x.subscriptionStatus === "string" ? x.subscriptionStatus : "none",
        currentPeriodEnd: ms(x.currentPeriodEnd),
        lastPaymentAt: ms(x.lastPaymentAt),
        pastDueAt: ms(x.pastDueAt),
        lastActiveAt: ms(x.lastActiveAt),
        compilesTotal: typeof x.compilesTotal === "number" ? x.compilesTotal : 0,
        aiMessagesTotal: typeof x.aiMessagesTotal === "number" ? x.aiMessagesTotal : 0,
      });
    }
    return map;
  });
}

/** Every saved project's owner and creation date: one read per project, so cached for five minutes. */
async function projectIndex(fresh: boolean): Promise<{ counts: Map<string, number>; created: number[]; total: number }> {
  return cached("projects", 5 * 60_000, fresh, async () => {
    const snap = await adminDb.collectionGroup("projects").select("createdAt").get();
    const counts = new Map<string, number>();
    const created: number[] = [];
    for (const d of snap.docs) {
      const owner = d.ref.parent.parent?.id;
      if (!owner) continue;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      const t = ms(d.get("createdAt"));
      if (t !== null) created.push(t);
    }
    return { counts, created, total: snap.size };
  });
}

/** Daily counts from `fromDay` on, with today's not-yet-saved counts added in. */
async function dailyStats(fromDay: string, fresh: boolean): Promise<Map<string, DailyStats>> {
  const saved = await cached(`daily:${fromDay}`, 60_000, fresh, async () => {
    const snap = await adminDb.collection(STATS_COLLECTION).where(FieldPath.documentId(), ">=", fromDay).get();
    return new Map(snap.docs.map((d) => [d.id, d.data() as DailyStats]));
  });
  const out = new Map(saved);
  const today = todayUtc();
  out.set(today, addStats(out.get(today), unflushed(today)));
  return out;
}

async function trackingSince(): Promise<string | null> {
  return cached("since", 10 * 60_000, false, async () => {
    const snap = await adminDb.collection(STATS_COLLECTION).orderBy(FieldPath.documentId()).limit(1).get();
    return snap.empty ? null : snap.docs[0].id;
  });
}

function boardName(id: string): string {
  return getBoardById(id)?.name || id;
}

function statfs(p: string): { total: number; free: number } | null {
  try {
    const s = fs.statfsSync(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function memAvailable(): number {
  try {
    const m = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return os.freemem();
}

/** A folder's size, stopping at 100,000 files. */
function folderSize(dir: string): number {
  let total = 0;
  let files = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files > 100_000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return total;
}

async function paystackTransactions(fresh: boolean): Promise<{ txs: PaystackTx[]; truncated: boolean }> {
  const key = paystackSecretKey();
  if (!key) return { txs: [], truncated: false };
  return cached("paystack", 5 * 60_000, fresh, async () => {
    const txs: PaystackTx[] = [];
    let page = 1;
    let pageCount = 1;
    do {
      const res = await fetch(`https://api.paystack.co/transaction?perPage=100&page=${page}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body?.data)) throw new Error(body?.message || `Paystack answered ${res.status}`);
      txs.push(...body.data);
      pageCount = Number(body?.meta?.pageCount) || 1;
      page++;
    } while (page <= pageCount && page <= 10);
    return { txs, truncated: pageCount > 10 };
  });
}

export interface AdminDeps {
  isolation: () => { isolated: boolean; reason: string };
  services: () => Record<string, boolean>;
}

export function registerAdminStatsRoutes(app: express.Express, requireAdmin: express.RequestHandler, deps: AdminDeps) {
  const needFirebase = (res: express.Response) => {
    if (isFirebaseAdminConfigured()) return false;
    res.status(503).json({ error: "Firebase isn't set up on the server, so there's no user data to show." });
    return true;
  };

  app.get("/api/admin/overview", requireAdmin, async (req, res) => {
    if (needFirebase(res)) return;
    const fresh = req.query.fresh === "1";
    const days = Math.max(7, Math.min(365, Math.floor(Number(req.query.days) || 30)));
    const now = Date.now();
    try {
      const range = dayRange(days, now);
      const [users, docs, projects, stats, since] = await Promise.all([
        authUsers(fresh), userDocs(fresh), projectIndex(fresh), dailyStats(range[0], fresh), trackingSince(),
      ]);
      const rows = buildUserRows(users, docs, projects.counts, readAccessLists(), now, FREE_PROJECT_LIMIT);
      const series = buildSeries(range, stats, users.map((u) => u.createdAt).filter((t): t is number => t !== null), projects.created);
      const today = series[series.length - 1];
      res.json({
        generatedAt: now,
        days,
        trackingSince: since,
        users: summarizeUsers(rows, now),
        projects: { total: projects.total, freeLimit: FREE_PROJECT_LIMIT },
        today,
        totals: totals(series),
        series,
        boards: boardTotals(range, stats).map((b) => ({ ...b, name: boardName(b.id) })),
        proPrice: 7,
      });
    } catch (err: any) {
      console.error("[Admin] overview:", err?.message || err);
      res.status(500).json({ error: `Couldn't load the figures: ${err?.message || "unknown error"}` });
    }
  });

  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    if (needFirebase(res)) return;
    const fresh = req.query.fresh === "1";
    try {
      const [users, docs, projects] = await Promise.all([authUsers(fresh), userDocs(fresh), projectIndex(fresh)]);
      const rows = buildUserRows(users, docs, projects.counts, readAccessLists(), Date.now(), FREE_PROJECT_LIMIT);
      res.json({ generatedAt: Date.now(), freeLimit: FREE_PROJECT_LIMIT, users: rows });
    } catch (err: any) {
      console.error("[Admin] users:", err?.message || err);
      res.status(500).json({ error: `Couldn't load users: ${err?.message || "unknown error"}` });
    }
  });

  app.get("/api/admin/payments", requireAdmin, async (req, res) => {
    const fresh = req.query.fresh === "1";
    if (!paystackSecretKey()) return res.json({ configured: false });
    try {
      const { txs, truncated } = await paystackTransactions(fresh);
      const rows = paymentRows(txs);
      res.json({
        configured: true,
        generatedAt: Date.now(),
        truncated,
        summary: summarizePayments(rows, Date.now()),
        recent: rows.slice(0, 100),
      });
    } catch (err: any) {
      console.error("[Admin] payments:", err?.message || err);
      res.status(502).json({ error: `Couldn't reach Paystack: ${err?.message || "unknown error"}` });
    }
  });

  app.get("/api/admin/server", requireAdmin, (_req, res) => {
    const cores = os.cpus().length || 1;
    const [load1, load5, load15] = os.loadavg();
    const memTotal = os.totalmem();
    const memFree = memAvailable();
    const root = statfs("/") ?? statfs(process.cwd());
    const dataDir = process.env.ADMIN_CONFIG_DIR || path.join(process.cwd(), "data");
    const today = liveToday();
    const add = today.add;
    const libraries = cachedSync("librariesSize", 5 * 60_000, () => folderSize(librariesDirectory()));
    const data = cachedSync("dataSize", 5 * 60_000, () => folderSize(dataDir));
    const snapshot = {
      cores,
      load1,
      memTotal,
      memAvailable: memFree,
      diskTotal: root?.total ?? 0,
      diskFree: root?.free ?? 0,
      slots: buildQueue.slots,
      running: buildQueue.runningNow,
      waiting: buildQueue.waitingNow,
      longestWaitMs: today.max.compile_wait_ms_max ?? 0,
      busyToday: add.compiles_busy ?? 0,
    };
    const hour = lastHour();
    res.json({
      generatedAt: Date.now(),
      verdict: serverVerdict(snapshot),
      cpu: { cores, model: os.cpus()[0]?.model ?? null, load1, load5, load15 },
      memory: { total: memTotal, available: memFree, processRss: process.memoryUsage().rss },
      disk: { total: snapshot.diskTotal, free: snapshot.diskFree, dataBytes: data, librariesBytes: libraries },
      builds: {
        slots: buildQueue.slots,
        running: buildQueue.runningNow,
        waiting: buildQueue.waitingNow,
        today: {
          ok: add.compiles_ok ?? 0,
          failed: add.compiles_failed ?? 0,
          busy: add.compiles_busy ?? 0,
          avgMs: add.compile_ms_count ? Math.round((add.compile_ms_total ?? 0) / add.compile_ms_count) : null,
          maxMs: today.max.compile_ms_max ?? null,
          waits: add.compile_waits ?? 0,
          avgWaitMs: add.compile_waits ? Math.round((add.compile_wait_ms_total ?? 0) / add.compile_waits) : null,
          longestWaitMs: today.max.compile_wait_ms_max ?? null,
        },
      },
      traffic: {
        lastHour: hour.map((m) => ({ at: m.minute * 60000, requests: m.api_requests, pageViews: m.page_views, compiles: m.compiles })),
        requestsLastMinute: hour[hour.length - 2]?.api_requests ?? 0,
      },
      uptime: { processSeconds: Math.round(process.uptime()), systemSeconds: Math.round(os.uptime()) },
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      isolation: deps.isolation(),
      services: deps.services(),
      buildCache: buildCacheStatus(path.join(process.cwd(), ".platformio")),
    });
  });
}

const syncCache = new Map<string, { at: number; value: number }>();
function cachedSync(key: string, ttlMs: number, load: () => number): number {
  const hit = syncCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  syncCache.set(key, { at: Date.now(), value });
  return value;
}
