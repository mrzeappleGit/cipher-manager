import { Clock, Database, FolderGit2, HardDrive, Zap, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { useCachedAsync } from "../lib/useAsync";
import { buildInsights, type Insight } from "../lib/insights";
import { Card, SectionTitle } from "./ui";
import type { UsageStats } from "../types";

const ICON: Record<Insight["kind"], LucideIcon> = {
  peak: Zap,
  project: FolderGit2,
  dormant: Clock,
  cache: Database,
  disk: HardDrive,
};

const TONE: Record<Insight["tone"], string> = {
  good: "#00f5ff",
  warn: "#fbbf24",
  info: "#b8b8c8",
};

export function Insights({ usage }: { usage: UsageStats }) {
  const { data: projects } = useCachedAsync("projects", () => api.listProjects());
  const insights = buildInsights(usage, projects ?? []);

  return (
    <Card className="p-5">
      <SectionTitle>Insights</SectionTitle>
      {insights.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted">Nothing notable right now — all steady.</div>
      ) : (
        <div className="space-y-2.5">
          {insights.map((ins) => {
            const Icon = ICON[ins.kind];
            const color = TONE[ins.tone];
            return (
              <div key={ins.id} className="flex gap-3 rounded-[10px] border border-outline bg-bg px-3 py-2.5">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `${color}1f`, color }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <div className="font-body text-[13px] font-semibold text-text">{ins.title}</div>
                  <div className="mt-0.5 font-body text-xs leading-relaxed text-muted">{ins.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
