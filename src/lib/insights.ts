import { tokenTotal, type ProjectSummary, type UsageStats } from "../types";
import { formatBytes, formatCompact, formatDate } from "./format";

export type InsightTone = "good" | "warn" | "info";

export interface Insight {
  id: string;
  tone: InsightTone;
  kind: "peak" | "project" | "dormant" | "cache" | "disk";
  title: string;
  detail: string;
}

/** Derive notable observations from the usage stats + project list. */
export function buildInsights(usage: UsageStats, projects: ProjectSummary[]): Insight[] {
  const out: Insight[] = [];

  // Peak usage day (vs. the median active day).
  const days = usage.byDay.map((d) => ({ day: d.day, t: tokenTotal(d.tokens) })).filter((d) => d.t > 0);
  if (days.length >= 4) {
    const sorted = [...days].sort((a, b) => a.t - b.t);
    const median = sorted[Math.floor(sorted.length / 2)].t;
    const peak = days.reduce((m, d) => (d.t > m.t ? d : m), days[0]);
    if (median > 0 && peak.t > median * 1.8) {
      out.push({
        id: "peak",
        tone: "info",
        kind: "peak",
        title: "Peak usage day",
        detail: `${formatDate(peak.day)} used ${formatCompact(peak.t)} tokens — ${(peak.t / median).toFixed(1)}× a typical day.`,
      });
    }
  }

  // Concentration in the top project.
  const totalTok = tokenTotal(usage.tokens) || 1;
  const topP = [...usage.byProject].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens))[0];
  if (topP) {
    const share = tokenTotal(topP.tokens) / totalTok;
    if (share > 0.4) {
      out.push({
        id: "conc",
        tone: "info",
        kind: "project",
        title: "Concentrated usage",
        detail: `${topP.name} accounts for ${Math.round(share * 100)}% of all your tokens.`,
      });
    }
  }

  // Dormant projects (had activity, none in 30+ days).
  const now = Date.now();
  const dormant = projects.filter(
    (p) =>
      p.sessionCount > 0 &&
      p.lastActivity &&
      now - Date.parse(p.lastActivity) > 30 * 86_400_000
  );
  if (dormant.length) {
    out.push({
      id: "dormant",
      tone: "warn",
      kind: "dormant",
      title: `${dormant.length} dormant project${dormant.length > 1 ? "s" : ""}`,
      detail: `No activity in 30+ days: ${dormant.slice(0, 3).map((p) => p.name).join(", ")}${dormant.length > 3 ? "…" : ""}.`,
    });
  }

  // Cache reuse efficiency.
  const inTot =
    usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite5m + usage.tokens.cacheWrite1h;
  if (inTot > 0) {
    const ratio = usage.tokens.cacheRead / inTot;
    if (ratio > 0.7) {
      out.push({
        id: "cache",
        tone: "good",
        kind: "cache",
        title: "Strong cache reuse",
        detail: `${Math.round(ratio * 100)}% of input tokens were cache reads — efficient context reuse.`,
      });
    }
  }

  // Disk footprint.
  if (usage.totalSizeBytes > 200 * 1024 * 1024) {
    out.push({
      id: "disk",
      tone: "info",
      kind: "disk",
      title: "Transcripts using disk",
      detail: `${formatBytes(usage.totalSizeBytes)} of transcripts on disk — review in Cleanup.`,
    });
  }

  return out.slice(0, 5);
}
