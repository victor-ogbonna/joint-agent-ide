import React, { useMemo, useState } from "react";
import { CheckCircle2, XCircle, MinusCircle, Clock } from "lucide-react";
import { StatTile, Card, ChartCard, ColumnChart } from "./charts";
import { Toolbar, ErrorNote, Loading } from "./Toolbar";
import { useAdminData, type AdminGet, type Payments, type UsersResponse, type AdminUser } from "./data";
import { full, date, money, moneyShort, monthLabel } from "./format";

const S1 = "var(--viz-series-1)";

/** A payment's outcome as an icon and a word, never colour alone. */
function PaymentStatus({ status }: { status: string }) {
  const map: Record<string, { Icon: typeof CheckCircle2; text: string; color: string }> = {
    success: { Icon: CheckCircle2, text: "Paid", color: "var(--viz-good)" },
    failed: { Icon: XCircle, text: "Failed", color: "var(--viz-critical)" },
    abandoned: { Icon: MinusCircle, text: "Abandoned", color: "var(--text-subtle)" },
    reversed: { Icon: XCircle, text: "Reversed", color: "var(--viz-warning)" },
  };
  const m = map[status] ?? { Icon: Clock, text: status.charAt(0).toUpperCase() + status.slice(1), color: "var(--text-subtle)" };
  return (
    <span className="inline-flex items-center gap-1 text-[var(--text-main)]">
      <m.Icon size={13} style={{ color: m.color }} aria-hidden="true" />
      {m.text}
    </span>
  );
}

function channelName(c: string | null): string {
  if (!c) return "—";
  if (c === "card") return "Card";
  if (c === "bank") return "Bank";
  if (c === "bank_transfer") return "Bank transfer";
  if (c === "ussd") return "USSD";
  if (c === "mobile_money") return "Mobile money";
  return c;
}

/** Who pays, whose PRO is ending, and whose payment failed, from the users list. */
function Subscribers({ get }: { get: AdminGet }) {
  const { data, error } = useAdminData<UsersResponse>(get, "/api/admin/users");
  const groups = useMemo(() => {
    const users = data?.users ?? [];
    const byDate = (key: "renewsAt" | "proUntil") => (a: AdminUser, b: AdminUser) => (a[key] ?? 0) - (b[key] ?? 0);
    return {
      renewing: users.filter((u) => u.plan === "pro" && u.renewsAt).sort(byDate("renewsAt")),
      ending: users.filter((u) => u.plan === "pro" && !u.renewsAt).sort(byDate("proUntil")),
      failed: users.filter((u) => u.subscriptionStatus === "past_due"),
    };
  }, [data]);

  if (!data) return (
    <Card title="Subscribers">
      {error ? <p className="text-[12px] text-[var(--text-muted)]">{error}</p> : <p className="text-[12px] text-[var(--text-muted)]">Loading…</p>}
    </Card>
  );

  const section = (title: string, list: AdminUser[], note: (u: AdminUser) => string, empty: string) => (
    <div>
      <h4 className="text-[12px] font-semibold text-[var(--text-main)]">
        {title} <span className="font-normal tabular-nums text-[var(--text-muted)]">{full(list.length)}</span>
      </h4>
      {list.length ? (
        <ul className="mt-1.5 divide-y divide-[var(--border-main)] rounded-lg border border-[var(--border-main)]">
          {list.slice(0, 50).map((u) => (
            <li key={u.uid} className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[var(--text-main)]">{u.name || u.email || "No name"}</p>
                {u.name && u.email && <p className="truncate text-[11px] text-[var(--text-muted)]">{u.email}</p>}
              </div>
              <span className="shrink-0 text-right text-[11px] text-[var(--text-muted)]">{note(u)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{empty}</p>
      )}
      {list.length > 50 && <p className="mt-1 text-[11px] text-[var(--text-muted)]">and {full(list.length - 50)} more on the Users tab.</p>}
    </div>
  );

  return (
    <Card title="Subscribers" subtitle="From your users' accounts, so it includes people who haven't paid through Paystack yet this month">
      <div className="grid gap-4 md:grid-cols-3">
        {section("Renewing", groups.renewing, (u) => `renews ${date(u.renewsAt)}`, "No one yet.")}
        {section("Cancelled, PRO until the paid date", groups.ending, (u) => `ends ${date(u.proUntil)}`, "No one.")}
        {section("Last payment failed", groups.failed, () => "now on Free", "No failed payments.")}
      </div>
      {groups.failed.length > 0 && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          When a payment fails, the person is on the Free plan straight away and their subscription is stopped, so
          they aren't charged again. They can get PRO again from the Plans page.
        </p>
      )}
    </Card>
  );
}

const PAGE = 20;

/** Real money from Paystack: totals, month by month, and the latest payments. */
export default function PaymentsTab({ get }: { get: AdminGet }) {
  const { data, error, loading, reload } = useAdminData<Payments>(get, "/api/admin/payments");
  const [shown, setShown] = useState(PAGE);
  const refresh = () => void reload(true);

  if (!data) return (
    <>
      <Toolbar onRefresh={refresh} loading={loading} />
      {error ? <ErrorNote text={error} /> : <Loading />}
    </>
  );

  if (!data.configured) return (
    <>
      <Toolbar onRefresh={refresh} loading={loading} />
      <Card title="Paystack isn't connected">
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Add your Paystack secret key under Settings → Paystack subscription. Payments will show here as soon as it's saved.
        </p>
      </Card>
      <div className="mt-3"><Subscribers get={get} /></div>
    </>
  );

  const summary = data.summary!;
  const allRecent = data.recent ?? [];
  const recent = allRecent.slice(0, shown);
  const currencies = Object.keys(summary.byCurrency).sort((a, b) => summary.byCurrency[b].allTime - summary.byCurrency[a].allTime);
  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <Toolbar onRefresh={refresh} loading={loading} updatedAt={data.generatedAt} />
      {error && <ErrorNote text={error} />}

      {currencies.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Money received" value="—" detail="No successful payments yet" />
          <StatTile label="Failed payments" value={full(summary.failed)} alert={summary.failed > 0} detail="Payments Paystack reported as failed" />
        </div>
      ) : (
        currencies.map((cur) => {
          const c = summary.byCurrency[cur];
          return (
            <div key={cur} className="mb-3">
              {currencies.length > 1 && <p className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">In {cur}</p>}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="col-span-2 rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
                  <p className="text-[12px] text-[var(--text-muted)]">Received this month</p>
                  <p className="mt-1 break-words text-4xl font-semibold leading-none text-[var(--text-main)]">{money(c.thisMonth, cur)}</p>
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                    Last month: {money(c.lastMonth, cur)} · average payment: {money(c.payments ? c.allTime / c.payments : 0, cur)}
                  </p>
                </div>
                <StatTile label="All time" value={moneyShort(c.allTime, cur)} detail={money(c.allTime, cur)} />
                <StatTile
                  label="Payments"
                  value={full(c.payments)}
                  detail={c.failed ? undefined : "None failed"}
                  warning={c.failed ? `${full(c.failed)} failed` : undefined}
                />
              </div>
            </div>
          );
        })
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {currencies.map((cur) => {
          const rows = summary.byMonth.map((m) => ({ month: m.month, amount: m.amounts[cur] ?? 0 }));
          const fmt = (v: number) => money(v, cur);
          return (
            <ChartCard
              key={cur}
              title={`Money received per month${currencies.length > 1 ? ` (${cur})` : ""}`}
              subtitle="The last 12 months, after each payment went through"
              table={{ columns: [{ key: "month", label: "Month", format: monthLabel }, { key: "amount", label: "Received", format: fmt }], rows: [...rows].reverse() }}
            >
              <ColumnChart
                rows={rows}
                xKey="month"
                series={[{ key: "amount", label: "Received", color: S1 }]}
                formatX={(m: string) => monthLabel(m).split(" ")[0]}
                formatTooltipX={monthLabel}
                formatValue={fmt}
                formatTick={(v) => moneyShort(v, cur)}
                label={`Money received per month in ${cur}`}
              />
            </ChartCard>
          );
        })}
      </div>

      <div className="mt-3"><Subscribers get={get} /></div>

      <Card className="mt-3" title="Latest payments" subtitle={`The ${full(allRecent.length)} most recent, newest first`}>
        {!recent.length ? (
          <p className="py-4 text-center text-[12px] text-[var(--text-muted)]">No payments yet.</p>
        ) : (
          <>
            {/* Phones: one row per payment. */}
            <ul className="divide-y divide-[var(--border-main)] md:hidden">
              {recent.map((p) => (
                <li key={p.id} className="py-2.5 text-[12px]">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{p.email || "—"}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-[var(--text-main)]">{money(p.amount, p.currency)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <PaymentStatus status={p.status} />
                    <span>· {date(p.at)}</span>
                    <span>· {channelName(p.channel)}</span>
                  </div>
                </li>
              ))}
            </ul>
            {/* Wider screens: a table. */}
            <div className="hidden max-h-[28rem] overflow-auto rounded-lg border border-[var(--border-main)] md:block">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-[var(--bg-root)] text-left text-[11px] text-[var(--text-muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Paid with</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id} className="border-t border-[var(--border-main)]">
                      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-main)]">{date(p.at)}</td>
                      <td className="max-w-[18rem] truncate px-3 py-2 text-[var(--text-main)]">{p.email || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2"><PaymentStatus status={p.status} /></td>
                      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">{channelName(p.channel)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[var(--text-main)]">{money(p.amount, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {allRecent.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="mt-3 w-full rounded-lg border border-[var(--border-main)] py-2 text-[12px] font-medium text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
              >
                Show {full(Math.min(PAGE, allRecent.length - shown))} more
              </button>
            )}
          </>
        )}
      </Card>

      <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-subtle)]">
        These figures come straight from Paystack and are what you actually received, before Paystack's fees.
        {data.truncated ? " Only your latest 1,000 payments are counted, so the all-time totals are lower than the real ones." : ""}
        {" "}Paystack is asked again at most every 5 minutes, or straight away when you press Refresh.
      </p>
    </div>
  );
}
