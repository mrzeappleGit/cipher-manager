// Fires due automations (once a day each, at/after their set time) while the
// app is open. Runs are real headless `claude -p` jobs, so the acting-mode
// gate applies — disabled automations and acting-off are skipped silently.

import { useEffect } from "react";
import { api, isTauri } from "../api";
import { automationDue, automationsReady, getAutomations, markRan, runAutomation } from "../lib/automations";
import { notifyDesktop } from "../lib/notify";
import { getSettings, settingsReady } from "../lib/settings";

/** Re-hydrate each automation's lastRun from the on-disk audit log. localStorage
 * can lose the lastRun write when the app is force-killed (WebView2 flushes it
 * lazily), which made automations re-fire on every launch; the audit log is the
 * durable record. ponytail: audit entries are written on job *finish*, so a run
 * killed mid-flight re-fires next launch — acceptable for once-a-day jobs. */
async function hydrateLastRuns(): Promise<void> {
  try {
    const entries = await api.getAudit(200);
    const today = new Date().toDateString();
    for (const a of getAutomations()) {
      if (a.lastRun === today) continue;
      const ranToday = entries.some(
        (e) =>
          e.skill === "automation" &&
          e.launched !== false &&
          !(e.launched == null && e.status === "failed" && e.exitCode == null) &&
          e.label === a.name &&
          new Date(e.startedAt).toDateString() === today
      );
      if (ranToday) markRan(a.id, today);
    }
  } catch {
    /* no audit yet (fresh install / mock mode) */
  }
}

let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try {
  if (!getSettings().actingMode) return;
  for (const a of getAutomations()) {
    if (!automationDue(a)) continue;
    const id = await runAutomation(a.id, { reveal: false, scheduled: true });
    if (id) notifyDesktop("Automation started", `${a.name} — output streams into the Jobs panel.`);
  }
  } finally { checking = false; }
}

export function AutomationRunner() {
  useEffect(() => {
    if (!isTauri()) return; // the phone must not launch a duplicate timer
    let alive = true;
    let t: ReturnType<typeof setInterval> | null = null;
    // Don't fire anything until lastRun is hydrated from the audit log, or a
    // launch after a lost localStorage write re-runs today's automations.
    Promise.all([settingsReady, automationsReady]).then(() => hydrateLastRuns()).then(() => {
      if (!alive) return;
      void check();
      t = setInterval(() => { void check(); }, 30_000);
    });
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, []);
  return null;
}
