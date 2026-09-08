import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";
import { tokenTotal, type DayUsage, type ModelUsage } from "../types";
import { formatCompact, modelColor, prettyModel } from "../lib/format";

const AXIS = { fontSize: 10.5, fill: "#6b6b7b", fontFamily: "JetBrains Mono, monospace" };

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-outline bg-surface-3 px-3 py-2 font-mono text-xs shadow-[var(--cm-shadow-2)]">
      {children}
    </div>
  );
}

function dayTick(day: string): string {
  const parts = day.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
}

/** Token usage over time — cyan area chart. */
export function ActivityArea({ data }: { data: DayUsage[] }) {
  const rows = data.map((d) => ({
    day: d.day,
    tokens: tokenTotal(d.tokens),
    messageCount: d.messageCount,
  }));
  return (
    <ResponsiveContainer width="100%" height={236}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00f5ff" stopOpacity={0.28} />
            <stop offset="72%" stopColor="#00f5ff" stopOpacity={0.04} />
            <stop offset="100%" stopColor="#00f5ff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="day"
          tickFormatter={dayTick}
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          minTickGap={26}
        />
        <YAxis
          tickFormatter={(v) => formatCompact(v)}
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          width={46}
        />
        <Tooltip
          cursor={{ stroke: "#2a2a38" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as { day: string; tokens: number; messageCount: number };
            return (
              <TooltipBox>
                <div className="mb-1 text-muted">{d.day}</div>
                <div className="text-cyan">{formatCompact(d.tokens)} tok</div>
                <div className="text-faint">{d.messageCount} messages</div>
              </TooltipBox>
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="tokens"
          stroke="#00f5ff"
          strokeWidth={2}
          fill="url(#tokenFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Token usage split by model — neon donut. */
export function UsageDonut({ data }: { data: ModelUsage[] }) {
  const items = data
    .map((d) => ({ ...d, total: tokenTotal(d.tokens) }))
    .filter((d) => d.total > 0);
  return (
    <ResponsiveContainer width="100%" height={168}>
      <PieChart>
        <Pie
          data={items}
          dataKey="total"
          nameKey="model"
          innerRadius={52}
          outerRadius={78}
          paddingAngle={2.5}
          stroke="#070b0f"
          strokeWidth={1.5}
        >
          {items.map((d) => (
            <Cell key={d.model} fill={modelColor(d.model)} />
          ))}
        </Pie>
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as ModelUsage & { total: number };
            return (
              <TooltipBox>
                <div className="mb-1 text-text">{prettyModel(d.model)}</div>
                <div style={{ color: modelColor(d.model) }}>{formatCompact(d.total)} tok</div>
                <div className="text-faint">{d.messageCount.toLocaleString()} messages</div>
              </TooltipBox>
            );
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
