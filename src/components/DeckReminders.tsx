// Global Deck side-effects: the shared deck-data hook, meeting reminders, the
// once-a-day digest, and the open-in-app helpers. Mounted once in App so
// notifications fire from any page, not just the Deck.

import { useEffect, useRef } from "react";
import { api, isTauri } from "../api";
import * as deck from "../lib/deck";
import { autoRecordTick } from "../lib/meetingRec";
import { codexAutoSync } from "../lib/codexSync";
import { notifyDesktop } from "../lib/notify";
import { getSettings, useSettings, type AppSettings } from "../lib/settings";
import { withToast } from "../lib/toast";
import { useCachedAsync } from "../lib/useAsync";
import type { DeckDashboard } from "../types";
import { keyRef, keyConfigured } from "../lib/secrets";

/** Open an Asana task — the desktop app (asanadesktop://) when enabled, else web. */
export function openTask(url: string | null) {
  if (!url) return;
  const s = getSettings();
  const target = s.asanaOpenInApp && isTauri() ? deck.asanaDeepLink(url) ?? url : url;
  withToast(api.openUrl(target), { error: "Couldn't open task" });
}

/** Open a meeting — the Zoom/Teams desktop app when enabled, else the browser. */
export function openMeeting(url: string | null) {
  if (!url) return;
  const s = getSettings();
  const target = s.meetingsOpenInApp && isTauri() ? deck.meetingDeepLink(url) ?? url : url;
  withToast(api.openUrl(target), { error: "Couldn't open meeting" });
}

/** The deck dashboard, cached per config — shared by the Deck page and the
 * global reminder ticker (same key → one fetch, kept in sync). */
export function useDeckData() {
  const settings = useSettings();
  const cfgKey = `${settings.icsUrls.join("|")}::${settings.asanaToken}::${settings.asanaProject}::${settings.asanaWorkspace}`;
  return useCachedAsync(`deck:${cfgKey}`, async () => {
    const d = await api.getDeck({
      icsUrls: settings.icsUrls,
      asanaToken: keyRef("asana-token", settings.asanaToken),
      asanaProject: settings.asanaProject,
      asanaWorkspace: settings.asanaWorkspace,
    });
    // serve.exe can be firewalled off the internet (Bitdefender), so remote
    // clients would only ever see sample data. The desktop app stashes each
    // live deck in the shared app state; clients whose own fetch came back
    // dead use that instead — the phone mirrors the desktop's deck.
    if (d.live) {
      if (isTauri()) void api.saveAppState("deck-cache", JSON.stringify(d)).catch(() => {});
      return d;
    }
    try {
      const cached = await api.loadAppState("deck-cache");
      if (cached) {
        const c = JSON.parse(cached) as DeckDashboard;
        if (c.live) return c;
      }
    } catch {
      /* corrupt/missing cache → fall through to whatever getDeck returned */
    }
    return d;
  });
}

// Events already notified this session (keyed by title + start time).
const reminded = new Set<string>();
const DIGEST_KEY = "cipher-manager.deck-digest";

function runChecks(d: DeckDashboard, s: AppSettings, now: Date) {
  if (!d.live) return; // never notify from sample data

  const events = deck.todaysEvents(deck.parseEvents(d), now);

  // Auto-start/stop the meeting recorder alongside the calendar (opt-in).
  autoRecordTick(events, now, s.autoRecordMeetings);

  if (s.meetingReminders) {
    for (const e of events) {
      if (e.kind === "Block") continue;
      const mins = deck.minutesBetween(now, e.start);
      const key = `${e.title}|${e.start.getTime()}`;
      if (mins > 0 && mins <= 2 && !reminded.has(key)) {
        reminded.add(key);
        notifyDesktop(
          e.title,
          `Starts ${deck.relLabel(e.start, now)}${e.location !== "—" ? ` · ${e.location}` : ""}`,
          e.url ? () => openMeeting(e.url) : undefined
        );
      }
    }
  }

  // Once-a-day digest at (or, if the app opens later, after) the chosen time.
  if (s.digestTime) {
    const [h, m] = s.digestTime.split(":").map(Number);
    if (!Number.isNaN(h) && now.getHours() * 60 + now.getMinutes() >= h * 60 + (m || 0)) {
      const today = now.toDateString();
      try {
        if (localStorage.getItem(DIGEST_KEY) === today) return;
        localStorage.setItem(DIGEST_KEY, today);
      } catch {
        return;
      }
      const meetings = events.filter((e) => e.kind !== "Block");
      const hidden = new Set(s.hiddenTags.map((t) => t.toLowerCase()));
      const tasks = deck
        .parseTasks(d)
        .filter((t) => !t.tags.some((tag) => hidden.has(tag.toLowerCase())));
      const dueToday = tasks.filter((t) => deck.taskBucket(t.due, now) === "Today").length;
      const overdue = tasks.filter((t) => deck.taskBucket(t.due, now) === "Overdue").length;
      const first = meetings.find((e) => e.end > now);
      notifyDesktop(
        "Your day ahead",
        `${meetings.length} meeting${meetings.length === 1 ? "" : "s"}, ${dueToday} due today, ${overdue} overdue` +
          (first ? ` · first: ${deck.fmtTime(first.start)} ${first.title}` : "")
      );
    }
  }
}

export function DeckReminders() {
  const settings = useSettings();
  const configured = settings.icsUrls.length > 0 || keyConfigured("asana-token", settings.asanaToken);
  return configured ? <RemindersInner /> : null;
}

function RemindersInner() {
  const { data, refresh } = useDeckData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Keep ~/.claude/cipher-deck/today.md current so headless skill runs
  // (morning-brief) can fold today's deck into their output.
  useEffect(() => {
    if (!data?.live) return;
    api
      .saveDeckSnapshot(deck.deckSnapshotMarkdown(data, new Date(), getSettings().hiddenTags))
      .catch(() => {
        /* best-effort */
      });
  }, [data]);

  // CipherCodex → vault: quiet daily sync (24h gate lives in codexAutoSync);
  // re-checked hourly so a long-running app still syncs the next day.
  useEffect(() => {
    const sync = () => void codexAutoSync(getSettings().vaultDir);
    sync();
    const t = setInterval(sync, 60 * 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const check = () => {
      const d = dataRef.current;
      if (d) runChecks(d, getSettings(), new Date());
    };
    check();
    const tick = setInterval(check, 30_000);
    // Background re-fetch every 5 minutes so reminders and the Deck stay current.
    const re = setInterval(() => refreshRef.current(), 5 * 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(re);
    };
  }, []);

  return null;
}
