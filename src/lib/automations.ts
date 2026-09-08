// Scheduled headless runs ("automations"): a prompt fired once a day at a set
// time while the app is open. Persisted in localStorage; executed by the
// AutomationRunner ticker mounted in App.

import { useSyncExternalStore } from "react";
import { mirrorAppState } from "./appState";
import { startJob } from "./jobs";

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  /** "HH:MM" 24h local time. */
  time: string;
  /** Days of week this runs (JS getDay, 0 = Sunday). Absent = every day. */
  days?: number[];
  /** Model override for the run (optional; absent on pre-existing entries). */
  model?: string;
  /** Runs via Windows Task Scheduler even when the app is closed. */
  system?: boolean;
  enabled: boolean;
  /** toDateString() of the last day this fired (so it runs once per day). */
  lastRun: string | null;
}

const KEY = "cipher-manager.automations";

let items: Automation[] = load();
let listeners: Array<() => void> = [];
let sequence = 0;

function load(): Automation[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
  disk.onPersist();
  for (const l of listeners) l();
}

// Shared on-disk copy — see lib/appState.ts.
const disk = mirrorAppState(
  "automations",
  (raw) => {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) {
        items = v;
        try {
          localStorage.setItem(KEY, raw);
        } catch {
          /* ignore */
        }
        for (const l of listeners) l();
      }
    } catch {
      /* bad file — keep local */
    }
  },
  () => JSON.stringify(items)
);

export const automationsReady = disk.ready;
const launching = new Set<string>();

export function automationDue(a: Automation, now = new Date()): boolean {
  if (!a.enabled || a.system || a.lastRun === now.toDateString()) return false;
  if (a.days && !a.days.includes(now.getDay())) return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time)) return false;
  const [h, m] = a.time.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

/** Manual and timer launches share acceptance bookkeeping and an in-flight guard. */
export async function runAutomation(id: string, { reveal = true, scheduled = false } = {}): Promise<string | null> {
  await automationsReady;
  const a = items.find((item) => item.id === id);
  if (!a || launching.has(id) || (scheduled && !automationDue(a))) return null;
  const canLaunch = () => {
    const current = items.find((item) => item.id === id);
    return !!current && (!scheduled || automationDue(current));
  };
  launching.add(id);
  try {
    const jobId = await startJob({ skill: "automation", label: a.name, prompt: a.prompt, model: a.model, reveal, canLaunch });
    if (jobId) {
      markRan(id, new Date().toDateString());
      await disk.flush().catch(() => {}); // shared mirror already offers a retry toast
    }
    return jobId;
  } finally {
    launching.delete(id);
  }
}

export function addAutomation(a: Omit<Automation, "id" | "lastRun">): void {
  items = [...items, { ...a, id: `au${Date.now()}_${sequence++}`, lastRun: null }];
  persist();
}

export function toggleAutomation(id: string): void {
  items = items.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a));
  persist();
}

export function removeAutomation(id: string): void {
  items = items.filter((a) => a.id !== id);
  persist();
}

export function markRan(id: string, day: string): void {
  items = items.map((a) => (a.id === id ? { ...a, lastRun: day } : a));
  persist();
}

export function getAutomations(): Automation[] {
  return items;
}

export function useAutomations(): Automation[] {
  return useSyncExternalStore(
    (l) => {
      listeners.push(l);
      return () => {
        listeners = listeners.filter((x) => x !== l);
      };
    },
    getAutomations,
    getAutomations
  );
}
