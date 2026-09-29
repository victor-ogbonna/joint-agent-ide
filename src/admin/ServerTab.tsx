import React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { StatTile, Card, ChartCard, ColumnChart, Meter, StatusBadge } from "./charts";
import { Toolbar, ErrorNote, Loading } from "./Toolbar";
import { useAdminData, type AdminGet, type ServerHealth } from "./data";
import { full, duration, bytes, uptime } from "./format";

const S1 = "var(--viz-series-1)";

const SERVICES: { key: string; label: string; off: string }[] = [
  { key: "deepseek", label: "DeepSeek AI", off: "The AI assistant can't answer." },
  { key: "gemini", label: "Gemini voice notes", off: "Voice notes can't be turned into text." },
  { key: "firebase", label: "Firebase (accounts and projects)", off: "Sign-in, saved projects and this dashboard's user figures don't work." },
  { key: "paystack", label: "Paystack payments", off: "No one can buy PRO." },
  { key: "feedbackEmail", label: "Feedback email", off: "Feedback is saved but not emailed to you." },
];

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Check({ on, label, note }: { on: boolean; label: string; note?: string }) {
  return (
    <li className="flex items-start gap-2 py-2 text-[12px]">
      {on
        ? <CheckCircle2 size={15} className="mt-px shrink-0" style={{ color: "var(--viz-good)" }} aria-hidden="true" />
        : <XCircle size={15} className="mt-px shrink-0" style={{ color: "var(--viz-critical)" }} aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p className="text-[var(--text-main)]">{label}</p>
        {note && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{note}</p>}
      </div>
      <span className="shrink-0 text-[11px] font-medium text-[var(--text-muted)]">{on ? "On" : "Off"}</span>
    </li>
  );
}

/** How the server is coping right now, refreshed every 15 seconds. */
export default function ServerTab({ get }: { get: AdminGet }) {
  const { data, error, loading, reload } = useAdminData<ServerHealth>(get, "/api/admin/server", 15000);
  const refresh = () => void reload();

  if (!data) return (
    <>
      <Toolbar onRefresh={refresh} loading={loading} />
      {error ? <ErrorNote text={error} /> : <Loading />}
    </>
  );

  const { verdict, cpu, memory, disk, builds, traffic } = data;
  const t = builds.today;
  const memUsed = memory.total - memory.available;
  const diskUsed = disk.total - disk.free;
  const loadText = (l: number) => `${l.toFixed(2)} of ${cpu.cores}`;
  const hourRows = traffic.lastHour;
  const hourRequests = hourRows.reduce((a, r) => a + r.requests, 0);
  const hourCompiles = hourRows.reduce((a, r) => a + r.compiles, 0);
  const hourTable = (key: string, label: string) => ({
    columns: [{ key: "at", label: "Minute", format: clock }, { key, label, format: full }],
    rows: [...hourRows].reverse(),
  });

  return (
    <div>
      <Toolbar onRefresh={refresh} loading={loading} updatedAt={data.generatedAt} />
      {error && <ErrorNote text={error} />}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="shrink-0 sm:w-48">
            <p className="text-[12px] text-[var(--text-muted)]">Server health</p>
            <div className="mt-1"><StatusBadge level={verdict.level} large /></div>
          </div>
          <div className="min-w-0 flex-1 text-[12px] leading-relaxed">
            {verdict.reasons.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-[var(--text-main)]">
                {verdict.reasons.map((r) => <li key={r}>{r.charAt(0).toUpperCase() + r.slice(1)}.</li>)}
              </ul>
            ) : (
              <p className="text-[var(--text-main)]">Everything is running normally. The server has room to spare.</p>
            )}
            {verdict.advice && <p className="mt-2 font-medium text-[var(--text-main)]">{verdict.advice}</p>}
          </div>
        </div>
      </Card>

      <Card className="mt-3" title="Capacity right now">
        <div className="grid gap-5 md:grid-cols-3">
          <Meter
            label="Processor"
            used={cpu.load1}
            total={cpu.cores}
            high={80}
            critical={100}
            detail={<>Cores busy: {loadText(cpu.load1)} now · {loadText(cpu.load5)} over 5 min · {loadText(cpu.load15)} over 15 min</>}
          />
          <Meter
            label="Memory"
            used={memUsed}
            total={memory.total}
            high={80}
            critical={90}
            detail={<>{bytes(memUsed)} of {bytes(memory.total)} used · this app: {bytes(memory.processRss)}</>}
          />
          <Meter
            label="Disk"
            used={diskUsed}
            total={disk.total}
            high={85}
            critical={95}
            detail={<>{bytes(disk.free)} free of {bytes(disk.total)} · libraries: {bytes(disk.librariesBytes)} · settings and lists: {bytes(disk.dataBytes)}</>}
          />
        </div>
      </Card>

      <h3 className="mb-2 mt-5 text-[13px] font-semibold text-[var(--text-main)]">Compiles</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="At the same time" value={full(builds.slots)} detail={`What ${cpu.cores} cores and ${bytes(memory.total)} of memory allow`} />
        <StatTile label="Running now" value={full(builds.running)} detail={`of ${full(builds.slots)}`} />
        <StatTile
          label="Waiting for a turn"
          value={full(builds.waiting)}
          alert={builds.waiting >= builds.slots * 3}
          detail={builds.waiting ? "They start as soon as one finishes" : "No one is waiting"}
        />
        <StatTile
          label="Compiles today"
          value={full(t.ok + t.failed)}
          detail={`${full(t.ok)} succeeded · ${full(t.failed)} failed`}
          warning={t.busy ? `${full(t.busy)} turned away: the server was full` : undefined}
        />
        <StatTile label="Average compile today" value={duration(t.avgMs)} detail={`Longest: ${duration(t.maxMs)}`} />
        <StatTile
          label="Waited today"
          value={full(t.waits)}
          detail={t.waits ? `Average wait ${duration(t.avgWaitMs)} · longest ${duration(t.longestWaitMs)}` : "No compile had to wait"}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Each compile can use a whole core and up to about 1 GB of memory, so the server runs {full(builds.slots)} at a time
        and the rest wait in line, first come, first served. A compile that waits more than 10 minutes, or arrives when
        60 are already waiting, is turned away with "the build server is very busy", and it doesn't count against the
        user's allowance. "Today" starts at midnight UTC.
      </p>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <ChartCard
          title="App requests in the last hour"
          subtitle={`${full(hourRequests)} in the hour · ${full(traffic.requestsLastMinute)} in the last full minute`}
          table={hourTable("requests", "Requests")}
        >
          <ColumnChart rows={hourRows} xKey="at" series={[{ key: "requests", label: "Requests", color: S1 }]} formatX={clock} label="App requests per minute over the last hour" />
        </ChartCard>
        <ChartCard title="Compiles in the last hour" subtitle={`${full(hourCompiles)} in the hour`} table={hourTable("compiles", "Compiles")}>
          <ColumnChart rows={hourRows} xKey="at" series={[{ key: "compiles", label: "Compiles", color: S1 }]} formatX={clock} label="Compiles per minute over the last hour" />
        </ChartCard>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card title="Services">
          <ul className="divide-y divide-[var(--border-main)]">
            {SERVICES.map((s) => (
              <Check key={s.key} on={!!data.services[s.key]} label={s.label} note={data.services[s.key] ? undefined : s.off} />
            ))}
            <Check
              on={data.isolation.isolated}
              label="Compiles run in their own locked-down account"
              note={data.isolation.isolated ? undefined : `They run as the main server account, so they could read its keys (${data.isolation.reason}).`}
            />
            <Check
              on={!!data.buildCache?.enabled}
              label="Build cache (reuses compiled files, so compiles are faster)"
              note={data.buildCache?.enabled
                ? `Using ${bytes(data.buildCache.bytes)} of its ${bytes(data.buildCache.maxBytes)} limit.`
                : "Every compile builds the Arduino core from scratch. Turn on with BUILD_CACHE=on in the server's .env."}
            />
          </ul>
        </Card>
        <Card title="Server">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
            <div><dt className="text-[11px] text-[var(--text-muted)]">App running for</dt><dd className="text-[var(--text-main)]">{uptime(data.uptime.processSeconds)}</dd></div>
            <div><dt className="text-[11px] text-[var(--text-muted)]">Server switched on for</dt><dd className="text-[var(--text-main)]">{uptime(data.uptime.systemSeconds)}</dd></div>
            <div><dt className="text-[11px] text-[var(--text-muted)]">Processor</dt><dd className="text-[var(--text-main)]">{cpu.cores} core{cpu.cores === 1 ? "" : "s"}{cpu.model ? ` · ${cpu.model}` : ""}</dd></div>
            <div><dt className="text-[11px] text-[var(--text-muted)]">Memory</dt><dd className="text-[var(--text-main)]">{bytes(memory.total)}</dd></div>
            <div><dt className="text-[11px] text-[var(--text-muted)]">Disk</dt><dd className="text-[var(--text-main)]">{bytes(disk.total)}</dd></div>
            <div><dt className="text-[11px] text-[var(--text-muted)]">Software</dt><dd className="text-[var(--text-main)]">Node {data.runtime.node.replace(/^v/, "")} · {data.runtime.platform} {data.runtime.arch}</dd></div>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            "App running for" restarts from zero after each deploy or restart; the last-hour charts start over then too.
          </p>
        </Card>
      </div>
    </div>
  );
}
