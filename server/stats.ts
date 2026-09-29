import { FieldValue } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";

/**
 * What the admin dashboard counts: compiles, AI messages, voice notes,
 * library adds, visits, requests and active users, per UTC day.
 *
 * Counts are gathered in memory and written once a minute, as increments,
 * to adminStats/<YYYY-MM-DD> in Firestore, so a busy minute costs one write,
 * not one per event, and history survives restarts and redeploys. Per-user
 * totals (compiles, AI messages) are batched the same way into the user's
 * own document. The last hour, minute by minute, is kept in memory only, for
 * the Server tab.
 */

export const STATS_COLLECTION = "adminStats";
const FLUSH_MS = 60 * 1000;

export type StatName =
  | "compiles_ok" | "compiles_failed" | "compiles_busy"
  | "compile_ms_total" | "compile_ms_count"
  | "compile_waits" | "compile_wait_ms_total"
  | "ai_chat" | "ai_generate" | "ai_debug" | "ai_free" | "ai_pro" | "ai_tokens"
  | "voice_notes" | "library_imports" | "library_adds"
  | "page_views" | "api_requests" | "active_users"
  | "payments_failed" | "cancellations";

export type MaxName = "compile_ms_max" | "compile_wait_ms_max";
export type UserStat = "compilesTotal" | "aiMessagesTotal";

interface DayBucket {
  add: Partial<Record<StatName, number>>;
  boards: Record<string, number>;
  max: Partial<Record<MaxName, number>>;
}

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

let pendingDays = new Map<string, DayBucket>();
let pendingUsers = new Map<string, Partial<Record<UserStat, number>>>();

/** Everything counted today since this process started, flushed or not: the live figures. */
let liveDay = utcDay();
let live: DayBucket = { add: {}, boards: {}, max: {} };

function bucket(day: string): DayBucket {
  let b = pendingDays.get(day);
  if (!b) { b = { add: {}, boards: {}, max: {} }; pendingDays.set(day, b); }
  return b;
}

function liveBucket(): DayBucket {
  const day = utcDay();
  if (day !== liveDay) { liveDay = day; live = { add: {}, boards: {}, max: {} }; }
  return live;
}

export function count(name: StatName, by = 1): void {
  if (!Number.isFinite(by) || by <= 0) return;
  const b = bucket(utcDay());
  b.add[name] = (b.add[name] ?? 0) + by;
  const l = liveBucket();
  l.add[name] = (l.add[name] ?? 0) + by;
  if (name === "api_requests" || name === "page_views" || name === "compiles_ok" || name === "compiles_failed") noteMinute(name);
}

export function recordMax(name: MaxName, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const b = bucket(utcDay());
  b.max[name] = Math.max(b.max[name] ?? 0, value);
  const l = liveBucket();
  l.max[name] = Math.max(l.max[name] ?? 0, value);
}

/** A build for a board ("uno", "esp32dev"…), succeeded or not. */
export function countBoard(boardId: string): void {
  const id = String(boardId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "unknown";
  const b = bucket(utcDay());
  b.boards[id] = (b.boards[id] ?? 0) + 1;
  const l = liveBucket();
  l.boards[id] = (l.boards[id] ?? 0) + 1;
}

export function countForUser(uid: string | undefined, name: UserStat, by = 1): void {
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;
  const u = pendingUsers.get(uid) ?? {};
  u[name] = (u[name] ?? 0) + by;
  pendingUsers.set(uid, u);
}

/** Today's counts as they stand, flushed or not. */
export function liveToday(): { day: string; add: Record<string, number>; boards: Record<string, number>; max: Record<string, number> } {
  const l = liveBucket();
  return { day: liveDay, add: { ...l.add }, boards: { ...l.boards }, max: { ...l.max } };
}

/** Counts not yet written to Firestore, per day. */
export function unflushed(day: string): DayBucket | null {
  return pendingDays.get(day) ?? null;
}

// ---------------------------------------------------------------------------
// The last hour, minute by minute (memory only)
// ---------------------------------------------------------------------------

interface MinuteRow { minute: number; api_requests: number; page_views: number; compiles: number }
const minutes: MinuteRow[] = [];

function noteMinute(name: StatName): void {
  const minute = Math.floor(Date.now() / 60000);
  let row = minutes[minutes.length - 1];
  if (!row || row.minute !== minute) {
    row = { minute, api_requests: 0, page_views: 0, compiles: 0 };
    minutes.push(row);
    while (minutes.length && minutes[0].minute <= minute - 60) minutes.shift();
  }
  if (name === "api_requests") row.api_requests++;
  else if (name === "page_views") row.page_views++;
  else row.compiles++;
}

/** The last 60 minutes, oldest first, gaps filled with zeros. */
export function lastHour(now = Date.now()): MinuteRow[] {
  const current = Math.floor(now / 60000);
  const byMinute = new Map(minutes.map((m) => [m.minute, m]));
  const out: MinuteRow[] = [];
  for (let m = current - 59; m <= current; m++) out.push(byMinute.get(m) ?? { minute: m, api_requests: 0, page_views: 0, compiles: 0 });
  return out;
}

// ---------------------------------------------------------------------------
// Active users: counted once per user per day, even across restarts
// ---------------------------------------------------------------------------

let seenDay = utcDay();
const seen = new Set<string>();

export function noteActive(uid: string | undefined): void {
  if (!uid) return;
  const day = utcDay();
  if (day !== seenDay) { seenDay = day; seen.clear(); }
  if (seen.has(uid)) return;
  seen.add(uid);
  if (!isFirebaseAdminConfigured()) { count("active_users"); return; }
  const ref = adminDb.collection("users").doc(uid);
  adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const first = snap.data()?.lastActiveDay !== day;
    tx.set(ref, { lastActiveDay: day, lastActiveAt: Date.now() }, { merge: true });
    return first;
  }).then((first) => {
    if (first) count("active_users");
  }).catch(() => {
    // Try again on their next request.
    seen.delete(uid);
  });
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

function mergeBack(days: Map<string, DayBucket>, users: Map<string, Partial<Record<UserStat, number>>>) {
  for (const [day, b] of days) {
    const into = bucket(day);
    for (const [k, v] of Object.entries(b.add)) into.add[k as StatName] = (into.add[k as StatName] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(b.boards)) into.boards[k] = (into.boards[k] ?? 0) + v;
    for (const [k, v] of Object.entries(b.max)) into.max[k as MaxName] = Math.max(into.max[k as MaxName] ?? 0, v ?? 0);
  }
  for (const [uid, u] of users) {
    const into = pendingUsers.get(uid) ?? {};
    for (const [k, v] of Object.entries(u)) into[k as UserStat] = (into[k as UserStat] ?? 0) + (v ?? 0);
    pendingUsers.set(uid, into);
  }
}

let flushing: Promise<void> | null = null;

export function flushStats(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const days = pendingDays;
    const users = pendingUsers;
    pendingDays = new Map();
    pendingUsers = new Map();
    if (!isFirebaseAdminConfigured() || (!days.size && !users.size)) return;
    try {
      for (const [day, b] of days) {
        const ref = adminDb.collection(STATS_COLLECTION).doc(day);
        const data: Record<string, unknown> = { day, updatedAt: FieldValue.serverTimestamp() };
        for (const [k, v] of Object.entries(b.add)) data[k] = FieldValue.increment(v ?? 0);
        if (Object.keys(b.boards).length) {
          data.boards = Object.fromEntries(Object.entries(b.boards).map(([k, v]) => [k, FieldValue.increment(v)]));
        }
        const maxes = Object.entries(b.max);
        if (!maxes.length) {
          await ref.set(data, { merge: true });
        } else {
          await adminDb.runTransaction(async (tx) => {
            const current = (await tx.get(ref)).data() || {};
            for (const [k, v] of maxes) if ((v ?? 0) > (Number(current[k]) || 0)) data[k] = v;
            tx.set(ref, data, { merge: true });
          });
        }
        days.delete(day);
      }
      const entries = [...users];
      for (let i = 0; i < entries.length; i += 400) {
        const batch = adminDb.batch();
        for (const [uid, u] of entries.slice(i, i + 400)) {
          const data: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(u)) data[k] = FieldValue.increment(v ?? 0);
          batch.set(adminDb.collection("users").doc(uid), data, { merge: true });
        }
        await batch.commit();
        for (const [uid] of entries.slice(i, i + 400)) users.delete(uid);
      }
    } catch (err: any) {
      console.error("[Stats] could not save; will retry:", err?.message || err);
      mergeBack(days, users);
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute writes, and a last one when the server is stopped. */
export function startStats(): void {
  if (timer) return;
  timer = setInterval(() => { void flushStats(); }, FLUSH_MS);
  timer.unref?.();
  process.once("SIGTERM", () => {
    const exit = () => process.exit(0);
    setTimeout(exit, 3000).unref?.();
    flushStats().finally(exit);
  });
}
