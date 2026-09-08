import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cpu,
  HardDrive,
  Layers,
  MessagesSquare,
  SquareTerminal,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Page } from "../components/Layout";
import { ActivityArea, UsageDonut } from "../components/charts";
import { ActivityMap } from "../components/ActivityMap";
import { UsageCore } from "../components/DataCore";
import { RecentActivity } from "../components/RecentActivity";
import { CreatorCard } from "../components/CreatorCard";
import { Directives } from "../components/Directives";
import { Insights } from "../components/Insights";
import { Bar, Button, Card, ErrorState, Loading, SectionTitle, StatCard } from "../components/ui";
import { api, isTauri } from "../api";
import { notify } from "../lib/toast";
import { useCachedAsync } from "../lib/useAsync";
import { formatBytes, formatCompact, formatDate, modelColor, prettyModel } from "../lib/format";
import { tokenTotal } from "../types";

export default function Dashboard() {
  const { data, error, loading, reload } = useCachedAsync("usageStats", () => api.getUsageStats());
  const navigate = useNavigate();

  if (loading) return <Loading label="Scanning ~/.claude…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const totalTokens = tokenTotal(data.tokens);
  const topProjects = [...data.byProject]
    .sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens))
    .slice(0, 8);
  const maxProjectTokens = topProjects.length ? tokenTotal(topProjects[0].tokens) : 1;
  const totalModelTokens = data.byModel.reduce((a, m) => a + tokenTotal(m.tokens), 0) || 1;

  return (
    <Page
      title="Dashboard"
      subtitle={
        data.firstActivity
          ? `Activity from ${formatDate(data.firstActivity)} to ${formatDate(data.lastActivity)}`
          : "Overview of your Claude Code usage"
      }
      actions={
        isTauri() && (
          <Button
            variant="primary"
            onClick={() =>
              api.openTerminal(".", "herdr").catch((e) =>
                notify.error(String((e as { message?: string })?.message ?? e))
              )
            }
            title="Open a terminal running herdr"
          >
            <SquareTerminal className="h-4 w-4" /> herdr
          </Button>
        )
      }
    >
      <UsageCore usage={data} onOpenProject={(id) => navigate(`/projects/${id}`)} />

      <RecentActivity />

      <CreatorCard />

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Tokens"
          value={formatCompact(totalTokens)}
          sub="all projects"
          icon={Cpu}
          accent="#a78bfa"
        />
        <StatCard
          label="Input"
          value={formatCompact(data.tokens.input + data.tokens.cacheRead + data.tokens.cacheWrite5m + data.tokens.cacheWrite1h)}
          sub="incl. cache"
          icon={ArrowDownToLine}
          accent="#38bdf8"
        />
        <StatCard
          label="Output"
          value={formatCompact(data.tokens.output)}
          icon={ArrowUpFromLine}
          accent="#34d399"
        />
        <StatCard
          label="Messages"
          value={formatCompact(data.messageCount)}
          icon={MessagesSquare}
          accent="#f472b6"
        />
        <StatCard
          label="Sessions"
          value={formatCompact(data.sessionCount)}
          sub={`${data.projectCount} projects`}
          icon={Layers}
          accent="#fbbf24"
        />
        <StatCard
          label="Transcript size"
          value={formatBytes(data.totalSizeBytes)}
          icon={HardDrive}
          accent="#7c6cf5"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Directives />
        <Insights usage={data} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Usage over time</SectionTitle>
          {data.byDay.length ? (
            <ActivityArea data={data.byDay} />
          ) : (
            <div className="py-16 text-center text-sm text-muted">No dated activity yet.</div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle>Usage by model</SectionTitle>
          {data.byModel.length ? (
            <>
              <UsageDonut data={data.byModel} />
              <div className="mt-4 space-y-2">
                {data.byModel.map((m) => {
                  const t = tokenTotal(m.tokens);
                  return (
                    <div key={m.model} className="flex items-center gap-2 text-sm">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: modelColor(m.model) }}
                      />
                      <span className="flex-1 truncate text-fg">{prettyModel(m.model)}</span>
                      <span className="tabular-nums text-muted">{formatCompact(t)}</span>
                      <span className="w-10 text-right tabular-nums text-faint">
                        {Math.round((t / totalModelTokens) * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="py-16 text-center text-sm text-muted">No model usage yet.</div>
          )}
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <SectionTitle right={<span className="text-xs text-faint">daily tokens</span>}>
          Usage map
        </SectionTitle>
        <ActivityMap data={data.byDay} />
      </Card>

      <Card className="mt-4 p-5">
        <SectionTitle right={<span className="text-xs text-faint">by tokens</span>}>
          Top projects
        </SectionTitle>
        {topProjects.length ? (
          <div className="space-y-3">
            {topProjects.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="group block w-full text-left"
              >
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-fg group-hover:text-accent-2">
                    {p.name}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">
                    {formatCompact(tokenTotal(p.tokens))} tokens
                  </span>
                </div>
                <Bar value={tokenTotal(p.tokens)} max={maxProjectTokens} />
              </button>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted">No projects yet.</div>
        )}
      </Card>
    </Page>
  );
}
