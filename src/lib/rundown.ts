import { useSyncExternalStore } from "react";
import { tokenTotal, type RecentSession, type UsageStats } from "../types";
import { formatCompact, formatRelative } from "./format";
import type { Insight } from "./insights";

// ---- open-state store (opened from the palette or a button) ----
let open = false;
let listeners: Array<() => void> = [];
const emit = () => listeners.forEach((l) => l());

export function openRundown() {
  if (!open) {
    open = true;
    emit();
  }
}
export function closeRundown() {
  if (open) {
    open = false;
    emit();
  }
}
export function useRundownOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.push(l);
      return () => {
        listeners = listeners.filter((x) => x !== l);
      };
    },
    () => open,
    () => open
  );
}

// ---- context / text builders ----

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Structured context handed to the AI to narrate. */
export function buildContext(
  usage: UsageStats,
  recent: RecentSession[],
  insights: Insight[]
): string {
  const parts: string[] = [];
  parts.push(
    `Totals: ${formatCompact(tokenTotal(usage.tokens))} tokens across ${usage.projectCount} projects and ${usage.sessionCount} sessions.`
  );
  if (recent.length) {
    parts.push("Recent sessions:");
    for (const s of recent.slice(0, 5)) {
      parts.push(`- ${s.projectName}: ${s.title || s.firstPrompt || "session"} (${formatRelative(s.endTime)})`);
    }
  }
  if (insights.length) {
    parts.push("Notable:");
    for (const i of insights) parts.push(`- ${i.title}: ${i.detail}`);
  }
  return parts.join("\n");
}

/** No-AI fallback rundown, assembled from the data directly. */
export function deterministicRundown(
  usage: UsageStats,
  recent: RecentSession[],
  insights: Insight[]
): string {
  const bits: string[] = [];
  bits.push(
    `${greeting()}. Across your projects you've used ${formatCompact(tokenTotal(usage.tokens))} tokens over ${usage.sessionCount} sessions in ${usage.projectCount} projects.`
  );
  if (recent[0]) {
    bits.push(
      `Most recently you worked on "${recent[0].title || recent[0].firstPrompt || "a session"}" in ${recent[0].projectName}, ${formatRelative(recent[0].endTime)}.`
    );
  }
  const warn = insights.find((i) => i.tone === "warn");
  if (warn) bits.push(`Heads up: ${warn.detail}`);
  else if (insights[0]) bits.push(insights[0].detail);
  return bits.join(" ");
}
