import { useCallback, useEffect, useRef, useState } from "react";

/** Fetches an admin route; null once the session has expired (the page has gone back to sign-in). */
export type AdminGet = (path: string) => Promise<Response | null>;

/**
 * Loads one admin route and keeps the last good answer on screen while it
 * reloads, so a refresh never blanks the page. `every` refreshes on a timer
 * while the tab is open.
 */
export function useAdminData<T>(get: AdminGet, path: string, every?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const res = await get(fresh ? `${path}${path.includes("?") ? "&" : "?"}fresh=1` : path);
      if (!res || !alive.current) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || "Couldn't load this."); return; }
      setData(body as T);
      setError(null);
    } catch {
      if (alive.current) setError("Couldn't reach the server.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [get, path]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => { void load(); }, every);
    return () => clearInterval(t);
  }, [every, load]);

  return { data, error, loading, reload: load };
}

export interface SeriesRow {
  day: string;
  signups: number;
  projectsCreated: number;
  activeUsers: number;
  compilesOk: number;
  compilesFailed: number;
  compilesBusy: number;
  aiMessages: number;
  aiFree: number;
  aiPro: number;
  voiceNotes: number;
  libraryAdds: number;
  pageViews: number;
  apiRequests: number;
  paymentsFailed: number;
  cancellations: number;
  avgCompileMs: number | null;
  maxCompileMs: number | null;
  compileWaits: number;
  avgWaitMs: number | null;
}

export interface Overview {
  generatedAt: number;
  days: number;
  trackingSince: string | null;
  users: {
    total: number;
    verified: number;
    disabled: number;
    providers: Record<string, number>;
    signups: { today: number; d7: number; d30: number };
    active: { d1: number; d7: number; d30: number };
    plans: { owner: number; granted: number; pro: number; proRenewing: number; proEnding: number; team?: number; trial?: number; free: number; early: number };
    pastDue: number;
    freeOverLimit: number;
    withProjects: number;
  };
  projects: { total: number; freeLimit: number };
  today: SeriesRow;
  totals: {
    signups: number; projectsCreated: number; compilesOk: number; compilesFailed: number; compilesBusy: number;
    compileSuccessRate: number | null; aiMessages: number; aiFree: number; aiPro: number; voiceNotes: number;
    libraryAdds: number; pageViews: number; apiRequests: number; paymentsFailed: number; cancellations: number;
    avgCompileMs: number | null; maxCompileMs: number | null; compileWaits: number; peakActiveUsers: number;
  };
  series: SeriesRow[];
  boards: { id: string; name: string; count: number }[];
  proPrice: number;
}

export interface AdminUser {
  uid: string;
  name: string | null;
  email: string | null;
  providers: string[];
  verified: boolean;
  disabled: boolean;
  createdAt: number | null;
  lastSignInAt: number | null;
  lastActiveAt: number | null;
  plan: "owner" | "granted" | "pro" | "team" | "trial" | "free";
  early: boolean;
  subscriptionStatus: string;
  renewsAt: number | null;
  proUntil: number | null;
  projects: number;
  compilesTotal: number;
  aiMessagesTotal: number;
  overLimit: boolean;
  /** The creator code the account came by. */
  referralCode?: string | null;
  trialEndsAt?: number | null;
  /** The team or school license the account is on. */
  teamId?: string | null;
}

export interface UsersResponse {
  generatedAt: number;
  freeLimit: number;
  users: AdminUser[];
}

export interface ServerHealth {
  generatedAt: number;
  verdict: { level: "ok" | "busy" | "overloaded"; reasons: string[]; advice: string | null };
  cpu: { cores: number; model: string | null; load1: number; load5: number; load15: number };
  memory: { total: number; available: number; processRss: number };
  disk: { total: number; free: number; dataBytes: number; librariesBytes: number };
  builds: {
    slots: number;
    running: number;
    waiting: number;
    today: { ok: number; failed: number; busy: number; avgMs: number | null; maxMs: number | null; waits: number; avgWaitMs: number | null; longestWaitMs: number | null };
  };
  traffic: { lastHour: { at: number; requests: number; pageViews: number; compiles: number }[]; requestsLastMinute: number };
  uptime: { processSeconds: number; systemSeconds: number };
  runtime: { node: string; platform: string; arch: string };
  isolation: { isolated: boolean; reason: string };
  services: Record<string, boolean>;
  buildCache: { enabled: boolean; bytes: number; maxBytes: number };
}

export interface Payments {
  configured: boolean;
  generatedAt?: number;
  truncated?: boolean;
  summary?: {
    byCurrency: Record<string, { allTime: number; thisMonth: number; lastMonth: number; payments: number; failed?: number }>;
    byMonth: { month: string; amounts: Record<string, number> }[];
    failed: number;
    successful: number;
  };
  recent?: { id: string; at: number | null; email: string | null; amount: number; currency: string; status: string; channel: string | null }[];
}
