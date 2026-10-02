import React from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip } from "recharts";

/**
 * The serial plotter's chart. Its own file so the charting library downloads
 * only when the plotter opens (App.tsx, lazyPart).
 */
export default function SerialPlotterChart({ data }: { data: { index: number; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
        <XAxis dataKey="index" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} stroke="var(--border-main)" />
        <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} stroke="var(--border-main)" />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '4px', fontSize: '12px', color: 'var(--text-main)' }}
          itemStyle={{ color: '#a855f7' }}
        />
        <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
