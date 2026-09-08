// Client-side Deck logic — ported from CipherDeck's model.rs so the countdown,
// "up next", task buckets, and stats stay live without refetching.

import type { DeckDashboard, DeckEvent, DeckTask } from "../types";

export type Mode = "now" | "next";
export type Bucket = "Overdue" | "Today" | "Upcoming";

export interface ParsedEvent extends Omit<DeckEvent, "start" | "end"> {
  start: Date;
  end: Date;
}
export interface ParsedTask extends Omit<DeckTask, "due"> {
  due: Date;
}

export function parseEvents(d: DeckDashboard): ParsedEvent[] {
  return d.events.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
}
export function parseTasks(d: DeckDashboard): ParsedTask[] {
  return d.tasks.map((t) => ({ ...t, due: new Date(t.due) }));
}

/** Convert an Asana permalink to the desktop app's deep link. The app registers
 * the `asanadesktop` scheme and keeps the app.asana.com host — so we just swap
 * the scheme. Returns null if it isn't an Asana web URL. */
export function asanaDeepLink(url: string): string | null {
  const m = url.match(/^https?:\/\/(app\.asana\.com\/.+)$/i);
  return m ? `asanadesktop://${m[1]}` : null;
}

/** Convert a meeting URL to a desktop-app deep link (Zoom / Teams). Returns null
 * for links with no known app scheme (e.g. Google Meet — web only). */
export function meetingDeepLink(url: string): string | null {
  // Zoom: https://<sub>.zoom.us/j|w|s/<confno>?pwd=<pwd> → zoommtg://zoom.us/join?…
  const zoom = url.match(/^https?:\/\/[\w.-]*zoom\.us\/(?:j|w|s)\/(\d+)/i);
  if (zoom) {
    let pwd = "";
    try {
      pwd = new URL(url).searchParams.get("pwd") ?? "";
    } catch {
      /* ignore */
    }
    return `zoommtg://zoom.us/join?action=join&confno=${zoom[1]}${
      pwd ? `&pwd=${encodeURIComponent(pwd)}` : ""
    }`;
  }
  // Teams: keep the path, swap the scheme+host for the app's msteams: scheme.
  if (/^https?:\/\/teams\.microsoft\.com\//i.test(url)) {
    return url.replace(/^https?:\/\/teams\.microsoft\.com/i, "msteams:");
  }
  return null;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function fmtTime(d: Date): string {
  const h24 = d.getHours();
  const m = d.getMinutes();
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Minutes between two instants (rounded). */
export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

/** Compact duration: "45m", "1h", "1h 30m". */
export function durLabel(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** A relative countdown like "in 12m", "in 1h 5m", "now", "5m ago". */
export function relLabel(target: Date, now: Date): string {
  const mins = minutesBetween(now, target);
  if (mins === 0) return "now";
  if (mins > 0) return `in ${durLabel(mins)}`;
  return `${durLabel(-mins)} ago`;
}

export function todaysEvents(events: ParsedEvent[], now: Date): ParsedEvent[] {
  return events
    .filter((e) => sameDay(e.start, now))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function currentOrNext(
  events: ParsedEvent[],
  now: Date
): { event: ParsedEvent; mode: Mode } | null {
  const today = todaysEvents(events, now);
  const happening = today.find((e) => e.start <= now && e.end > now);
  if (happening) return { event: happening, mode: "now" };
  const upNext = today.find((e) => e.start > now);
  if (upNext) return { event: upNext, mode: "next" };
  const future = events
    .filter((e) => e.start > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return future.length ? { event: future[0], mode: "next" } : null;
}

/** A stable key for a task, used to mute it from the AI summary. */
export function taskKey(t: ParsedTask): string {
  return t.url || `${t.proj}|${t.name}|${t.due.getTime()}`;
}

export function taskBucket(due: Date, now: Date): Bucket {
  if (sameDay(due, now)) return "Today";
  return due < now ? "Overdue" : "Upcoming";
}

export function daysUntil(due: Date, now: Date): number {
  return Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86400000);
}

export function dueLabel(due: Date, now: Date): string {
  const time = fmtTime(due);
  if (sameDay(due, now)) return `Today · ${time}`;
  const days = daysUntil(due, now);
  if (days === 1) return `Tomorrow · ${time}`;
  if (days === -1) return "Yesterday";
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days < 7) return `${due.toLocaleDateString(undefined, { weekday: "short" })} · ${time}`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact markdown snapshot of today's deck, written to ~/.claude/cipher-deck/
 * so headless skill runs (e.g. morning-brief) can see calendar + tasks the CLI
 * can't fetch itself (ICS/Asana credentials live only in the app). */
export function deckSnapshotMarkdown(d: DeckDashboard, now: Date, hiddenTags: string[]): string {
  const hidden = new Set(hiddenTags.map((t) => t.toLowerCase()));
  const meetings = todaysEvents(parseEvents(d), now).filter((e) => e.kind !== "Block");
  const tasks = parseTasks(d).filter((t) => !t.tags.some((tag) => hidden.has(tag.toLowerCase())));
  const by = (b: Bucket) => tasks.filter((t) => taskBucket(t.due, now) === b);
  const task = (t: ParsedTask) => `- ${t.name} (${t.proj}, ${dueLabel(t.due, now)})`;
  const list = (lines: string[]) => (lines.length ? lines : ["- none"]);
  return [
    `# Deck — ${now.toDateString()}`,
    ``,
    `## Meetings today`,
    ...list(
      meetings.map(
        (e) => `- ${fmtTime(e.start)} ${e.title}${e.location !== "—" ? ` · ${e.location}` : ""}`
      )
    ),
    ``,
    `## Overdue`,
    ...list(by("Overdue").map(task)),
    ``,
    `## Due today`,
    ...list(by("Today").map(task)),
    ``,
    `## Upcoming`,
    ...list(by("Upcoming").slice(0, 8).map(task)),
    ``,
  ].join("\n");
}

export interface DeckStats {
  meetingsToday: number;
  timeBooked: string;
  tasksDueThisWeek: number;
  overdue: number;
}

export function computeStats(
  events: ParsedEvent[],
  tasks: ParsedTask[],
  now: Date
): DeckStats {
  const today = todaysEvents(events, now);
  const meetingsToday = today.filter((e) => e.kind !== "Block").length;
  const busy = today.reduce((sum, e) => sum + minutesBetween(e.start, e.end), 0);

  const sot = startOfDay(now);
  const weekEnd = new Date(sot.getTime());
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const tasksDueThisWeek = tasks.filter((t) => t.due >= sot && t.due <= weekEnd).length;
  const overdue = tasks.filter((t) => taskBucket(t.due, now) === "Overdue").length;

  return { meetingsToday, timeBooked: durLabel(busy), tasksDueThisWeek, overdue };
}

/** The first free gap of ≥30 min in the rest of today. `end` is null when
 * nothing else is scheduled after `start` (free until end of day). */
export function nextFreeBlock(
  events: ParsedEvent[],
  now: Date
): { start: Date; end: Date | null } {
  const MIN_GAP = 30;
  const rest = todaysEvents(events, now).filter((e) => e.end > now);
  let cursor = now;
  for (const e of rest) {
    if (minutesBetween(cursor, e.start) >= MIN_GAP) return { start: cursor, end: e.start };
    if (e.end > cursor) cursor = e.end;
  }
  return { start: cursor, end: null };
}

/** Events grouped by each of the next 7 days (for the week-ahead strip). */
export function weekAhead(events: ParsedEvent[], now: Date): { day: Date; events: ParsedEvent[] }[] {
  const out: { day: Date; events: ParsedEvent[] }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = startOfDay(now);
    day.setDate(day.getDate() + i);
    out.push({
      day,
      events: events
        .filter((e) => sameDay(e.start, day))
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    });
  }
  return out;
}
