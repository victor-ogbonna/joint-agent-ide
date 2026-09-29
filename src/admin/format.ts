/** Numbers and times as the admin dashboard shows them. */

/** 1,284 · 12.9K · 4.2M */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** 1,284 in full, for tables and tooltips. */
export function full(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** "850 ms", "18 s", "1 min 5 s" */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** "3 days 4 h" of uptime. */
export function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} day${d === 1 ? "" : "s"} ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

/** "29 Sep" from "2026-09-29". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Mon 29 Sep" */
export function longDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Sep 2026" from "2026-09". */
export function monthLabel(month: string): string {
  const d = new Date(`${month}-15T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** A date on the admin's own calendar: "29 Sep 2026". */
export function date(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return date(ms);
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amount >= 1000 ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${full(amount)}`;
  }
}

/** "NGN 3.7M", "$259" — short enough for a tile or an axis. */
export function moneyShort(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(amount);
  } catch {
    return `${currency} ${compact(amount)}`;
  }
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
