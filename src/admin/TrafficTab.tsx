import React, { useState } from "react";
import { StatTile, ChartCard, ColumnChart } from "./charts";
import { Toolbar, ErrorNote, Loading, type Range } from "./Toolbar";
import { useAdminData, type AdminGet, type Overview, type SeriesRow } from "./data";
import { full, compact, duration, shortDay, longDay } from "./format";

const S1 = "var(--viz-series-1)";

/** Visits, requests and what people do in the app, day by day. */
export default function TrafficTab({ get }: { get: AdminGet }) {
  const [range, setRange] = useState<Range>(30);
  const { data, error, loading, reload } = useAdminData<Overview>(get, `/api/admin/overview?days=${range}`);
  const refresh = () => void reload(true);
  if (!data) return (
    <>
      <Toolbar range={range} onRange={setRange} onRefresh={refresh} loading={loading} />
      {error ? <ErrorNote text={error} /> : <Loading />}
    </>
  );

  const series = data.series;
  const tot = data.totals;
  const chart = (key: keyof SeriesRow, title: string, subtitle: string, label: string, format: (v: number) => string = full) => (
    <ChartCard
      title={title}
      subtitle={subtitle}
      table={{ columns: [{ key: "day", label: "Day", format: longDay }, { key, label, format: (v: any) => (v === null ? "—" : format(v)) }], rows: [...series].reverse() }}
    >
      <ColumnChart rows={series} xKey="day" series={[{ key, label, color: S1 }]} formatX={shortDay} formatTooltipX={longDay} formatValue={format} label={`${title} over the last ${data.days} days`} />
    </ChartCard>
  );

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <Toolbar range={range} onRange={setRange} onRefresh={refresh} loading={loading} updatedAt={data.generatedAt} />
      {error && <ErrorNote text={error} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Page visits" value={compact(tot.pageViews)} detail={`Last ${data.days} days`} />
        <StatTile label="App requests" value={compact(tot.apiRequests)} detail={`Last ${data.days} days`} />
        <StatTile label="New projects" value={full(tot.projectsCreated)} detail={`Last ${data.days} days`} />
        <StatTile label="Compile success" value={tot.compileSuccessRate === null ? "—" : `${tot.compileSuccessRate}%`} detail={`${full(tot.compilesOk)} of ${full(tot.compilesOk + tot.compilesFailed)}`} />
        <StatTile label="Average compile" value={duration(tot.avgCompileMs)} detail={`Longest: ${duration(tot.maxCompileMs)}`} />
        <StatTile
          label="Compiles that waited"
          value={full(tot.compileWaits)}
          detail={tot.compilesBusy ? undefined : "None turned away"}
          warning={tot.compilesBusy ? `${full(tot.compilesBusy)} turned away: the server was full` : undefined}
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {chart("pageViews", "Page visits per day", `${full(tot.pageViews)} in total`, "Visits")}
        {chart("apiRequests", "App requests per day", "Every action in the app talks to the server; this counts them", "Requests", compact)}
        {chart("projectsCreated", "New projects per day", `${full(tot.projectsCreated)} in total`, "New projects")}
        {chart("voiceNotes", "Voice notes per day", `${full(tot.voiceNotes)} in total`, "Voice notes")}
        {chart("libraryAdds", "Libraries added per day", `${full(tot.libraryAdds)} from the catalogue, .zip or GitHub`, "Libraries added")}
        {chart("avgCompileMs", "Average compile time per day", "Rising times mean the server is getting busier", "Average compile", (v) => duration(v))}
        {chart("compileWaits", "Compiles that waited for a turn", "Builds take turns so the server never runs out of memory; see the Server tab", "Waited")}
        {chart("cancellations", "Subscription cancellations per day", `${full(tot.cancellations)} in total · ${full(tot.paymentsFailed)} failed payments`, "Cancellations")}
      </div>
    </div>
  );
}
