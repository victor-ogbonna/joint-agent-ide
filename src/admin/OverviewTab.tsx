import React, { useState } from "react";
import { StatTile, Card, ChartCard, ColumnChart, BarList, StatusBadge } from "./charts";
import { Toolbar, ErrorNote, Loading, type Range } from "./Toolbar";
import { useAdminData, type AdminGet, type Overview, type ServerHealth } from "./data";
import { compact, full, shortDay, longDay, moneyShort, percent } from "./format";

const S1 = "var(--viz-series-1)";
const S2 = "var(--viz-series-2)";

export default function OverviewTab({ get }: { get: AdminGet }) {
  const [range, setRange] = useState<Range>(30);
  const { data, error, loading, reload } = useAdminData<Overview>(get, `/api/admin/overview?days=${range}`);
  const server = useAdminData<ServerHealth>(get, "/api/admin/server", 30000);

  const refresh = () => { void reload(true); void server.reload(); };
  if (!data) return (
    <>
      <Toolbar range={range} onRange={setRange} onRefresh={refresh} loading={loading} />
      {error ? <ErrorNote text={error} /> : <Loading />}
    </>
  );

  const u = data.users;
  const t = data.today;
  const compilesToday = t.compilesOk + t.compilesFailed;
  const payingPro = u.plans.pro;
  const series = data.series;
  const dayCols = (key: string, label: string, format = full) => ({
    columns: [{ key: "day", label: "Day", format: longDay }, { key, label, format }],
    rows: [...series].reverse(),
  });

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <Toolbar range={range} onRange={setRange} onRefresh={refresh} loading={loading} updatedAt={data.generatedAt} />
      {error && <ErrorNote text={error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 flex flex-col justify-center rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4 lg:row-span-2">
          <p className="text-[12px] text-[var(--text-muted)]">Total users</p>
          <p className="mt-1 text-5xl font-semibold leading-none text-[var(--text-main)]">{full(u.total)}</p>
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            +{full(u.signups.d7)} this week · +{full(u.signups.d30)} in 30 days · {full(u.verified)} verified
            {u.disabled ? ` · ${full(u.disabled)} disabled` : ""}
          </p>
        </div>
        <StatTile label="New sign-ups today" value={full(u.signups.today)} detail={`7 days: ${full(u.signups.d7)} · 30 days: ${full(u.signups.d30)}`} />
        <StatTile label="Active users today" value={full(u.active.d1)} detail={`7 days: ${full(u.active.d7)} · 30 days: ${full(u.active.d30)}`} />
        <StatTile
          label="PRO subscribers"
          value={full(payingPro)}
          detail={<>{full(u.plans.proRenewing)} renewing · {full(u.plans.proEnding)} ending<br />About {moneyShort(payingPro * data.proPrice, "USD")}/month</>}
        />
        <div className="min-w-0 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3.5">
          <p className="text-[11px] text-[var(--text-muted)]">Server</p>
          <div className="mt-1.5">{server.data ? <StatusBadge level={server.data.verdict.level} large /> : <span className="text-[13px] text-[var(--text-muted)]">Checking…</span>}</div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
            {server.data ? (server.data.verdict.reasons[0] ? capitalise(server.data.verdict.reasons[0]) : "Everything is running normally.") : ""}
          </p>
        </div>
        <StatTile
          label="Compiles today"
          value={full(compilesToday)}
          detail={`${full(t.compilesOk)} succeeded · ${full(t.compilesFailed)} failed${t.compilesBusy ? ` · ${full(t.compilesBusy)} turned away` : ""}`}
        />
        <StatTile label="AI messages today" value={full(t.aiMessages)} detail={`Free: ${full(t.aiFree)} · PRO: ${full(t.aiPro)} · voice notes: ${full(t.voiceNotes)}`} />
        <StatTile
          label="Saved projects"
          value={full(data.projects.total)}
          detail={`${full(u.withProjects)} users have projects`}
          warning={u.freeOverLimit
            ? `${full(u.freeOverLimit)} Free account${u.freeOverLimit === 1 ? " is" : "s are"} over the ${data.projects.freeLimit}-project limit (see Users)`
            : undefined}
        />
        <StatTile label="Page visits today" value={full(t.pageViews)} detail={`${compact(data.totals.pageViews)} in the last ${data.days} days`} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <ChartCard title="Sign-ups per day" subtitle={`${full(data.totals.signups)} in the last ${data.days} days`} table={dayCols("signups", "Sign-ups")}>
          <ColumnChart rows={series} xKey="day" series={[{ key: "signups", label: "Sign-ups", color: S1 }]} formatX={shortDay} formatTooltipX={longDay} label={`Sign-ups per day over the last ${data.days} days`} />
        </ChartCard>
        <ChartCard title="Active users per day" subtitle={`Busiest day: ${full(data.totals.peakActiveUsers)}`} table={dayCols("activeUsers", "Active users")}>
          <ColumnChart rows={series} xKey="day" series={[{ key: "activeUsers", label: "Active users", color: S1 }]} formatX={shortDay} formatTooltipX={longDay} label="Active users per day" />
        </ChartCard>
        <ChartCard
          title="Compiles per day"
          subtitle={`${full(data.totals.compilesOk + data.totals.compilesFailed)} in total${data.totals.compileSuccessRate !== null ? ` · ${data.totals.compileSuccessRate}% succeeded` : ""}`}
          table={{
            columns: [{ key: "day", label: "Day", format: longDay }, { key: "compilesOk", label: "Succeeded", format: full }, { key: "compilesFailed", label: "Failed", format: full }],
            rows: [...series].reverse(),
          }}
        >
          <ColumnChart
            rows={series}
            xKey="day"
            series={[{ key: "compilesOk", label: "Succeeded", color: S1 }, { key: "compilesFailed", label: "Failed", color: S2 }]}
            formatX={shortDay}
            formatTooltipX={longDay}
            label="Compiles per day, succeeded and failed"
          />
        </ChartCard>
        <ChartCard title="AI messages per day" subtitle={`${full(data.totals.aiMessages)} in total · Free ${full(data.totals.aiFree)} · PRO ${full(data.totals.aiPro)}`} table={dayCols("aiMessages", "AI messages")}>
          <ColumnChart rows={series} xKey="day" series={[{ key: "aiMessages", label: "AI messages", color: S1 }]} formatX={shortDay} formatTooltipX={longDay} label="AI messages per day" />
        </ChartCard>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card title="Plans" subtitle={`${full(u.plans.early)} with early access${u.pastDue ? ` · ${full(u.pastDue)} with a failed payment` : ""}`}>
          <BarList items={[
            { label: "Free", value: u.plans.free, note: `${percent(u.plans.free, u.total)}%` },
            { label: "PRO (paying)", value: u.plans.pro, note: `${percent(u.plans.pro, u.total)}%` },
            { label: "PRO (granted)", value: u.plans.granted },
            { label: "PRO (team or school license)", value: u.plans.team ?? 0 },
            { label: "PRO trial (creator code)", value: u.plans.trial ?? 0 },
            { label: "Owner", value: u.plans.owner },
          ]} />
        </Card>
        <Card title="Compiles by board" subtitle={`Last ${data.days} days`}>
          <BarList items={data.boards.slice(0, 8).map((b) => ({ label: b.name, value: b.count }))} emptyText="No compiles counted yet." />
        </Card>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-subtle)]">
        Users, sign-ups and projects include their full history. Compiles, AI messages, voice notes and visits are counted
        {data.trackingSince ? ` from ${longDay(data.trackingSince)}, when this dashboard went live` : " from when this dashboard went live"}.
        Revenue here is an estimate at ${data.proPrice} per PRO subscriber; the Payments tab has the real figures from Paystack.
        {" "}Sign-in methods: {Object.entries(u.providers).map(([p, c]) => `${providerName(p)} ${compact(c)}`).join(" · ") || "—"}.
      </p>
    </div>
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

export function providerName(p: string): string {
  if (p === "google.com") return "Google";
  if (p === "password") return "Email";
  if (p === "github.com") return "GitHub";
  return p;
}
