import { useMemo, useState } from "react";
import { Milestone } from "lucide-react";
import { Page } from "../components/Layout";
import { Card, SectionTitle } from "../components/ui";
import { cn } from "../components/ui";
import {
  ROADMAP,
  STATUS_META,
  countByStatus,
  type RoadmapProject,
  type RoadmapStatus,
} from "../lib/roadmap";

const ACCENT: Record<RoadmapProject["accent"], string> = {
  cyan: "#00f5ff",
  violet: "#c000ff",
  magenta: "#ff0055",
};

const STATUS_ORDER: RoadmapStatus[] = ["shipped", "in-progress", "planned"];

export default function RoadmapPage() {
  const [project, setProject] = useState<string>("all");
  const [status, setStatus] = useState<RoadmapStatus | "all">("all");

  const visible = useMemo(
    () => (project === "all" ? ROADMAP : ROADMAP.filter((p) => p.id === project)),
    [project]
  );
  const totals = useMemo(() => countByStatus(visible), [visible]);
  const grand = totals.shipped + totals["in-progress"] + totals.planned;

  return (
    <Page
      title="Roadmap"
      subtitle="What's shipped and what's next across the Cipher suite"
    >
      {/* Summary + status legend */}
      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          {STATUS_ORDER.map((st) => (
            <button
              key={st}
              onClick={() => setStatus((s) => (s === st ? "all" : st))}
              className={cn(
                "flex items-center gap-2 transition-opacity",
                status !== "all" && status !== st && "opacity-40"
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: STATUS_META[st].dot, boxShadow: `0 0 7px ${STATUS_META[st].dot}` }}
              />
              <span className="font-display text-xl font-bold text-text">{totals[st]}</span>
              <span className="font-body text-sm text-muted">{STATUS_META[st].label}</span>
            </button>
          ))}
          <div className="ml-auto font-mono text-xs text-faint">
            {grand} items · {grand ? Math.round((totals.shipped / grand) * 100) : 0}% shipped
          </div>
        </div>
        <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-surface-1">
          {STATUS_ORDER.map((st) =>
            totals[st] > 0 ? (
              <div
                key={st}
                style={{ width: `${(totals[st] / grand) * 100}%`, backgroundColor: STATUS_META[st].dot }}
              />
            ) : null
          )}
        </div>
      </Card>

      {/* Project filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        <FilterChip active={project === "all"} onClick={() => setProject("all")}>
          All projects
        </FilterChip>
        {ROADMAP.map((p) => (
          <FilterChip
            key={p.id}
            active={project === p.id}
            onClick={() => setProject(p.id)}
            dot={ACCENT[p.accent]}
          >
            {p.name}
          </FilterChip>
        ))}
      </div>

      <div className="space-y-10">
        {visible.map((p) => (
          <ProjectBlock key={p.id} project={p} statusFilter={status} />
        ))}
      </div>
    </Page>
  );
}

function ProjectBlock({
  project,
  statusFilter,
}: {
  project: RoadmapProject;
  statusFilter: RoadmapStatus | "all";
}) {
  const accent = ACCENT[project.accent];
  const counts = countByStatus([project]);
  const total = counts.shipped + counts["in-progress"] + counts.planned;
  const pct = total ? Math.round((counts.shipped / total) * 100) : 0;

  return (
    <section>
      {/* Project header */}
      <div className="mb-4 flex items-center gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border"
          style={{ borderColor: `${accent}55`, color: accent, boxShadow: `inset 0 0 12px ${accent}22` }}
        >
          <Milestone className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold text-text">{project.name}</div>
          <div className="truncate font-body text-[13px] text-muted">{project.tagline}</div>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-1">
            <div className="h-full" style={{ width: `${pct}%`, backgroundColor: accent }} />
          </div>
          <span className="font-mono text-[11px] text-faint">{pct}%</span>
        </div>
      </div>

      <div className="space-y-4">
        {project.phases.map((phase) => {
          const items = phase.items.filter(
            (it) => statusFilter === "all" || it.status === statusFilter
          );
          if (items.length === 0) return null;
          return (
            <div key={phase.name}>
              <SectionTitle right={phase.note && <span className="text-xs text-faint">{phase.note}</span>}>
                {phase.name}
              </SectionTitle>
              <Card className="overflow-hidden p-0">
                {items.map((it, i) => (
                  <div
                    key={it.title}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3",
                      i > 0 && "border-t border-outline"
                    )}
                  >
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: STATUS_META[it.status].dot,
                        boxShadow:
                          it.status !== "planned" ? `0 0 6px ${STATUS_META[it.status].dot}` : "none",
                      }}
                      title={STATUS_META[it.status].label}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-body text-sm font-semibold text-text">{it.title}</div>
                      {it.detail && (
                        <div className="mt-0.5 font-body text-[13px] leading-relaxed text-muted">
                          {it.detail}
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10.5px]",
                        it.status === "planned"
                          ? "border-outline text-muted"
                          : "border-transparent"
                      )}
                      style={
                        it.status !== "planned"
                          ? { color: STATUS_META[it.status].dot, backgroundColor: `${STATUS_META[it.status].dot}18` }
                          : undefined
                      }
                    >
                      {STATUS_META[it.status].label}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  dot,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-body text-sm font-semibold transition-colors",
        active
          ? "border-cyan/50 bg-surface-2 text-text"
          : "border-outline text-muted hover:border-cyan/40 hover:text-text"
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} />}
      {children}
    </button>
  );
}
