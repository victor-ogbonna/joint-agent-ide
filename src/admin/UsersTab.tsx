import React, { useMemo, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import { Toolbar, ErrorNote, Loading } from "./Toolbar";
import { useAdminData, type AdminGet, type AdminUser, type UsersResponse } from "./data";
import { full, date, ago } from "./format";
import { providerName } from "./OverviewTab";

type Filter = "all" | "free" | "pro" | "trial" | "granted" | "owner" | "overLimit" | "pastDue" | "early" | "creator";
type Sort = "newest" | "active" | "compiles" | "projects";

const FILTERS: { id: Filter; label: string; test: (u: AdminUser) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "free", label: "Free", test: (u) => u.plan === "free" },
  { id: "pro", label: "PRO", test: (u) => u.plan === "pro" },
  { id: "trial", label: "PRO trial", test: (u) => u.plan === "trial" },
  { id: "granted", label: "Granted PRO", test: (u) => u.plan === "granted" },
  { id: "owner", label: "Owner", test: (u) => u.plan === "owner" },
  { id: "overLimit", label: "Over 5 projects", test: (u) => u.overLimit },
  { id: "pastDue", label: "Payment failed", test: (u) => u.subscriptionStatus === "past_due" },
  { id: "early", label: "Early access", test: (u) => u.early },
  { id: "creator", label: "Came by a creator code", test: (u) => !!u.referralCode },
];

const SORTS: { id: Sort; label: string; by: (a: AdminUser, b: AdminUser) => number }[] = [
  { id: "newest", label: "Newest", by: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) },
  { id: "active", label: "Last active", by: (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) },
  { id: "compiles", label: "Most compiles", by: (a, b) => b.compilesTotal - a.compilesTotal },
  { id: "projects", label: "Most projects", by: (a, b) => b.projects - a.projects },
];

const PAGE = 50;

export function PlanBadge({ user }: { user: AdminUser }) {
  const base = "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold";
  if (user.plan === "owner") return <span className={`${base} bg-[var(--bg-hover)] text-[var(--text-main)]`}>Owner</span>;
  if (user.plan === "granted") return <span className={`${base} bg-orange-500/15 text-orange-400`}>Granted PRO</span>;
  if (user.plan === "pro") return <span className={`${base} bg-orange-500/15 text-orange-400`}>PRO</span>;
  if (user.plan === "trial") return <span className={`${base} bg-orange-500/15 text-orange-400`}>PRO trial</span>;
  return <span className={`${base} bg-[var(--bg-hover)] text-[var(--text-muted)]`}>Free</span>;
}

function planNote(u: AdminUser): string | null {
  const via = u.referralCode ? ` · via ${u.referralCode}` : "";
  const note = basePlanNote(u);
  return note ? `${note}${via}` : u.referralCode ? `via ${u.referralCode}` : null;
}

function basePlanNote(u: AdminUser): string | null {
  if (u.plan === "trial" && u.trialEndsAt) return `trial ends ${date(u.trialEndsAt)}`;
  if (u.plan === "pro" && u.renewsAt) return `renews ${date(u.renewsAt)}`;
  if (u.plan === "pro" && u.proUntil) return `ends ${date(u.proUntil)}`;
  if (u.subscriptionStatus === "past_due") return "last payment failed";
  if (u.subscriptionStatus === "canceled") return "cancelled";
  return null;
}

function Projects({ u, limit }: { u: AdminUser; limit: number }) {
  if (!u.overLimit) return <>{full(u.projects)}</>;
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-[var(--viz-alert-text)]" title={`Over the Free plan's ${limit}-project limit`}>
      <AlertTriangle size={12} aria-hidden="true" />
      {full(u.projects)}
      <span className="sr-only">(over the Free limit)</span>
    </span>
  );
}

export default function UsersTab({ get }: { get: AdminGet }) {
  const { data, error, loading, reload } = useAdminData<UsersResponse>(get, "/api/admin/users");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of FILTERS) out[f.id] = data ? data.users.filter(f.test).length : 0;
    return out;
  }, [data]);

  const list = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const f = FILTERS.find((x) => x.id === filter)!;
    const s = SORTS.find((x) => x.id === sort)!;
    return data.users
      .filter(f.test)
      .filter((u) => !q || (u.email || "").toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q))
      .sort(s.by);
  }, [data, query, filter, sort]);

  if (!data) return (
    <>
      <Toolbar onRefresh={() => void reload(true)} loading={loading} />
      {error ? <ErrorNote text={error} /> : <Loading />}
    </>
  );

  const visible = list.slice(0, shown);
  const now = Date.now();

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <Toolbar onRefresh={() => void reload(true)} loading={loading} updatedAt={data.generatedAt}>
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
            type="search"
            placeholder="Search name or email"
            aria-label="Search users"
            className="w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] py-1.5 pl-8 pr-2.5 text-[16px] sm:text-[12px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort users"
          className="rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] px-2 py-1.5 text-[12px] text-[var(--text-main)]"
        >
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Toolbar>
      {error && <ErrorNote text={error} />}

      <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filter users">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => { setFilter(f.id); setShown(PAGE); }}
            aria-pressed={filter === f.id}
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${filter === f.id ? "border-[var(--accent-primary)] text-[var(--text-main)]" : "border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
          >
            {f.label} <span className="tabular-nums text-[var(--text-subtle)]">{full(counts[f.id])}</span>
          </button>
        ))}
      </div>

      <p className="mb-2 text-[11px] text-[var(--text-muted)]">Showing {full(visible.length)} of {full(list.length)}</p>

      {/* Phones: one card per user. */}
      <ul className="space-y-2 md:hidden">
        {visible.map((u) => (
          <li key={u.uid} className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-[var(--text-main)]">{u.name || u.email || "No name"}</p>
                {u.name && <p className="truncate text-[11px] text-[var(--text-muted)]">{u.email}</p>}
              </div>
              <PlanBadge user={u} />
            </div>
            {planNote(u) && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{planNote(u)}</p>}
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div><dt className="text-[var(--text-subtle)]">Projects</dt><dd className="text-[var(--text-main)]"><Projects u={u} limit={data.freeLimit} /></dd></div>
              <div><dt className="text-[var(--text-subtle)]">Compiles</dt><dd className="text-[var(--text-main)]">{full(u.compilesTotal)}</dd></div>
              <div><dt className="text-[var(--text-subtle)]">AI msgs</dt><dd className="text-[var(--text-main)]">{full(u.aiMessagesTotal)}</dd></div>
              <div><dt className="text-[var(--text-subtle)]">Joined</dt><dd className="text-[var(--text-main)]">{date(u.createdAt)}</dd></div>
              <div className="col-span-2"><dt className="text-[var(--text-subtle)]">Last active</dt><dd className="text-[var(--text-main)]">{ago(u.lastActiveAt, now)}</dd></div>
            </dl>
          </li>
        ))}
      </ul>

      {/* Wider screens: a table. */}
      <div className="hidden overflow-x-auto rounded-xl border border-[var(--border-main)] md:block">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--bg-panel)] text-left text-[11px] text-[var(--text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium">Last active</th>
              <th className="px-3 py-2 text-right font-medium">Projects</th>
              <th className="px-3 py-2 text-right font-medium">Compiles</th>
              <th className="px-3 py-2 text-right font-medium">AI msgs</th>
              <th className="px-3 py-2 font-medium">Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.uid} className="border-t border-[var(--border-main)] align-top">
                <td className="max-w-[16rem] px-3 py-2">
                  <p className="truncate font-medium text-[var(--text-main)]">{u.name || "No name"}</p>
                  <p className="truncate text-[11px] text-[var(--text-muted)]">{u.email || "—"}{!u.verified && u.email ? " · not verified" : ""}{u.disabled ? " · disabled" : ""}</p>
                </td>
                <td className="px-3 py-2">
                  <PlanBadge user={u} />
                  {u.early && <span className="ml-1 text-[10px] text-[var(--text-muted)]">early access</span>}
                  {planNote(u) && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{planNote(u)}</p>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[var(--text-main)]">{date(u.createdAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-[var(--text-main)]">{ago(u.lastActiveAt, now)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--text-main)]"><Projects u={u} limit={data.freeLimit} /></td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--text-main)]">{full(u.compilesTotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--text-main)]">{full(u.aiMessagesTotal)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">{u.providers.map(providerName).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!list.length && <p className="py-10 text-center text-[12px] text-[var(--text-muted)]">No users match.</p>}
      {list.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-3 w-full rounded-lg border border-[var(--border-main)] py-2 text-[12px] font-medium text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
        >
          Show {full(Math.min(PAGE, list.length - shown))} more
        </button>
      )}
      <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-subtle)]">
        Compile and AI message totals are counted from when this dashboard went live. "Last active" is the most recent of the
        app's own record and the user's last sign-in.
      </p>
    </div>
  );
}
