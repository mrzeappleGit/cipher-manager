import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  CalendarRange,
  CheckSquare,
  Clock,
  Copy,
  EyeOff,
  ExternalLink,
  LayoutList,
  ListTodo,
  ListTree,
  MapPin,
  MessageSquare,
  Mic,
  Paperclip,
  Play,
  Plus,
  Radio,
  Search,
  Sparkles,
  Square,
  Trash2,
  User,
  Users,
  Video,
  X,
} from "lucide-react";
import { Page } from "../components/Layout";
import { Button, Card, ErrorState, Loading, SectionTitle, Spinner, StatCard, cn } from "../components/ui";
import { RecordMeetingButton } from "../components/MeetingRecorder";
import { SpeakButton } from "../components/SpeakButton";
import { PackagesCard } from "../components/PackagesCard";
import { api, isSnapshot, isTauri } from "../api";
import { notify } from "../lib/toast";
import { getSettings, setSettings, toggleHiddenField, toggleHiddenTag, useSettings } from "../lib/settings";
import { openMeeting, openTask, useDeckData } from "../components/DeckReminders";
import { useAsync, useCachedAsync } from "../lib/useAsync";
import { matchingPeoplePages, rebuildPeoplePages } from "../lib/people";
import { buildPrep, type PrepData } from "../lib/prep";
import {
  aiExtractTasks,
  aiSummarize,
  importAudioNote,
  myActions,
  parseMeetingNote,
  aiNameSpeakers,
  renameSpeakers,
  retryRecordingNote,
  transcriptSpeakers,
  useMeetingRec,
  withSummary,
  withTasks,
  type MeetingNoteParts,
} from "../lib/meetingRec";
import type { DocFile, RecordingFile } from "../types";
import { isProviderReady, suggestTodos, summarizeDeck } from "../lib/ai";
import {
  addTodo,
  clearDoneTodos,
  removeTodo,
  toggleIgnore,
  toggleTodo,
  useIgnored,
  useTodos,
} from "../lib/deckStore";
import * as deck from "../lib/deck";
import type { DeckEventKind, HaEntity, TaskDetail } from "../types";
import { keyRef } from "../lib/secrets";

const SUMMARY_PREFIX = "cipher-manager.deck-summary.";

const KIND_TAG: Record<DeckEventKind, string> = {
  Video: "VIDEO",
  Room: "IN PERSON",
  Block: "BLOCK",
  Other: "EVENT",
};

const KIND_COLOR: Record<DeckEventKind, string> = {
  Video: "#00f5ff",
  Room: "#c000ff",
  Block: "#555",
  Other: "#ff0055",
};

function greeting(h: number): string {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function DeckPage() {
  const settings = useSettings();
  // Fetched (and auto-refreshed) via the shared hook — see DeckReminders.
  const { data, error, loading, reload, updatedAt } = useDeckData();

  // Live tick for the clock + countdown.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const [view, setView] = useState<"agenda" | "week">("agenda");
  const [detailTask, setDetailTask] = useState<deck.ParsedTask | null>(null);
  const [detailEvent, setDetailEvent] = useState<deck.ParsedEvent | null>(null);
  const [query, setQuery] = useState("");

  const events = useMemo(() => (data ? deck.parseEvents(data) : []), [data]);
  const allTasks = useMemo(() => (data ? deck.parseTasks(data) : []), [data]);
  // Drop tasks carrying any hidden tag; optionally keep only tasks assigned to me.
  const tasks = useMemo(() => {
    const hidden = new Set(settings.hiddenTags.map((t) => t.toLowerCase()));
    const me = settings.asanaMe.trim().toLowerCase();
    const mineOnly = settings.deckMineOnly && me !== "";
    return allTasks.filter(
      (t) =>
        !t.tags.some((tag) => hidden.has(tag.toLowerCase())) &&
        (!mineOnly || t.assignee?.toLowerCase() === me)
    );
  }, [allTasks, settings.hiddenTags, settings.deckMineOnly, settings.asanaMe]);

  const today = useMemo(() => deck.todaysEvents(events, now), [events, now]);
  const upNext = useMemo(() => deck.currentOrNext(events, now), [events, now]);
  const stats = useMemo(() => deck.computeStats(events, tasks, now), [events, tasks, now]);
  const week = useMemo(() => deck.weekAhead(events, now), [events, now]);

  const buckets = useMemo(() => {
    const b: Record<deck.Bucket, deck.ParsedTask[]> = { Overdue: [], Today: [], Upcoming: [] };
    for (const t of tasks) b[deck.taskBucket(t.due, now)].push(t);
    for (const k of Object.keys(b) as deck.Bucket[]) b[k].sort((x, y) => x.due.getTime() - y.due.getTime());
    return b;
  }, [tasks, now]);

  // Search narrows only the displayed columns — stats and the AI summary keep
  // using the full buckets.
  const shownBuckets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buckets;
    const match = (t: deck.ParsedTask) =>
      [t.name, t.proj, t.section, t.assignee].some((x) => x?.toLowerCase().includes(q));
    return {
      Overdue: buckets.Overdue.filter(match),
      Today: buckets.Today.filter(match),
      Upcoming: buckets.Upcoming.filter(match),
    };
  }, [buckets, query]);

  if (loading) return <Loading label="Loading your day…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const name = settings.deckName.trim();

  return (
    <Page
      title={`${greeting(now.getHours())}${name ? `, ${name}` : ""}`}
      subtitle={
        <span className="inline-flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">{deck.fmtTime(now)}</span>
          <span className="text-outline">·</span>
          {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </span>
      }
      actions={
        <span className="inline-flex items-center gap-2">
          <RecordMeetingButton title={upNext?.event.title} />
          {updatedAt !== null && (
            <span className="font-mono text-[10px] text-faint">
              synced {deck.relLabel(new Date(updatedAt), now)}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px]",
              data.live ? "border-cyan/40 text-cyan" : "border-outline text-muted"
            )}
            title={data.notes.join("\n") || data.source}
          >
            <Radio className="h-3 w-3" /> {data.live ? "live" : "sample"}
          </span>
        </span>
      }
    >
      {/* Up next hero */}
      {upNext && <UpNext upNext={upNext} now={now} />}

      {/* AI day summary */}
      <DaySummary today={today} buckets={buckets} now={now} className="mt-5" />

      {/* Calendar (agenda / week) + to-do */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <section>
          <SectionTitle
            right={
              <div className="flex items-center gap-1 rounded-lg border border-outline p-0.5">
                <ViewTab active={view === "agenda"} onClick={() => setView("agenda")} icon={LayoutList}>
                  Agenda
                </ViewTab>
                <ViewTab active={view === "week"} onClick={() => setView("week")} icon={CalendarRange}>
                  Week
                </ViewTab>
              </div>
            }
          >
            {view === "agenda" ? "Today's agenda" : "This week"}
          </SectionTitle>
          {view === "agenda" ? (
            <Card className="overflow-hidden p-0">
              {today.length === 0 ? (
                <div className="px-4 py-8 text-center font-body text-sm text-muted">
                  Nothing on the calendar today.
                </div>
              ) : (
                today.map((e, i) => <AgendaRow key={i} e={e} now={now} onOpen={setDetailEvent} />)
              )}
            </Card>
          ) : (
            <CalendarWeek week={week} now={now} />
          )}
        </section>

        <section>
          <SectionTitle>To-do</SectionTitle>
          <TodoList today={today} buckets={buckets} now={now} />
        </section>
      </div>

      {/* At a glance */}
      <div className="mt-6">
        <SectionTitle>At a glance</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Meetings today" value={stats.meetingsToday} />
          <StatCard label="Time booked" value={stats.timeBooked} />
          <StatCard label="Due this week" value={stats.tasksDueThisWeek} />
          <StatCard label="Overdue" value={stats.overdue} />
          <FreeBlockCard events={events} now={now} />
        </div>
      </div>

      {/* What's arriving — read off shipping mail; hides itself when empty. */}
      <PackagesCard />

      {/* Meeting notes from the recorder (vault output/meetings) */}
      <MeetingNotes />

      {/* One-tap scripts (~/.claude/cipher-manager/scripts) — e.g. "endWork"
          kills the work apps; runs on the PC even when tapped from the phone. */}
      <QuickScripts />
      <HomeCard />

      {/* Tasks */}
      <div className="mt-6">
        <SectionTitle
          right={
            <span className="flex items-center gap-2 text-xs text-faint">
              <span className="flex items-center gap-1.5 rounded-lg border border-outline px-2 py-1">
                <Search className="h-3 w-3 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter tasks…"
                  className="w-32 bg-transparent font-body text-xs text-text outline-none placeholder:text-faint"
                />
                {query && (
                  <button onClick={() => setQuery("")} title="Clear" className="text-faint hover:text-text">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
              {settings.asanaMe.trim() && (
                <ViewTab
                  active={settings.deckMineOnly}
                  onClick={() => setSettings({ deckMineOnly: !settings.deckMineOnly })}
                  icon={User}
                >
                  Mine
                </ViewTab>
              )}
              <span>{tasks.length} tasks</span>
            </span>
          }
        >
          Tasks
        </SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TaskColumn title="Overdue" icon={AlertTriangle} tone="#ff0055" tasks={shownBuckets.Overdue} now={now} onOpen={setDetailTask} />
          <TaskColumn title="Today" icon={CheckSquare} tone="#00f5ff" tasks={shownBuckets.Today} now={now} onOpen={setDetailTask} />
          <TaskColumn title="Upcoming" icon={CalendarClock} tone="#c000ff" tasks={shownBuckets.Upcoming} now={now} onOpen={setDetailTask} />
        </div>
      </div>

      {data.notes.length > 0 && (
        <div className="mt-5 rounded-lg border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-xs text-warn">
          {data.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      {detailTask && (
        <TaskDetailModal task={detailTask} now={now} onClose={() => setDetailTask(null)} />
      )}
      {detailEvent && (
        <EventDetailModal e={detailEvent} now={now} onClose={() => setDetailEvent(null)} />
      )}
    </Page>
  );
}

function FreeBlockCard({ events, now }: { events: deck.ParsedEvent[]; now: Date }) {
  const b = deck.nextFreeBlock(events, now);
  const startsNow = b.start.getTime() - now.getTime() < 60_000;
  const from = startsNow ? "Now" : deck.fmtTime(b.start);
  return (
    <StatCard
      label="Next free block"
      value={b.end ? deck.durLabel(deck.minutesBetween(b.start, b.end)) : "Free"}
      sub={
        b.end
          ? `${from} – ${deck.fmtTime(b.end)}`
          : startsNow
            ? "rest of day"
            : `from ${deck.fmtTime(b.start)}`
      }
    />
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function DaySummary({
  today,
  buckets,
  now,
  className,
}: {
  today: deck.ParsedEvent[];
  buckets: Record<deck.Bucket, deck.ParsedTask[]>;
  now: Date;
  className?: string;
}) {
  const settings = useSettings();
  const ready = isProviderReady(settings);
  const ignored = useIgnored();
  const todos = useTodos();
  const dayKey = ymd(now);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      setText(localStorage.getItem(SUMMARY_PREFIX + dayKey));
    } catch {
      /* ignore */
    }
  }, [dayKey]);

  async function generate() {
    setLoading(true);
    try {
      const keep = (t: deck.ParsedTask) => !ignored.has(deck.taskKey(t));

      // Pull the last comment or two on overdue/today tasks for context.
      let comments: string[] = [];
      const token = keyRef("asana-token", settings.asanaToken);
      const due = [...buckets.Overdue, ...buckets.Today].filter(keep);
      const ids = due.map((t) => t.id).filter(Boolean).slice(0, 10);
      if (token && ids.length) {
        try {
          const nameById = new Map(due.map((t) => [t.id, t.name]));
          const tc = await api.getTaskComments(token, ids);
          comments = tc.flatMap((x) =>
            x.comments.map((c) => `${nameById.get(x.id) ?? "Task"} — ${c.author}: "${c.text.slice(0, 220)}"`)
          );
        } catch {
          /* comments are best-effort */
        }
      }

      const input = {
        dateLabel: now.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        }),
        events: today.map((e) => ({
          time: deck.fmtTime(e.start),
          title: e.title,
          location: e.location,
          kind: e.kind,
        })),
        overdue: buckets.Overdue.filter(keep).map((t) => `${t.name} (${t.proj})`),
        dueToday: buckets.Today.filter(keep).map((t) => `${t.name} (${t.proj})`),
        upcoming: buckets.Upcoming.filter(keep)
          .slice(0, 8)
          .map((t) => `${t.name} (${t.proj}, ${deck.dueLabel(t.due, now)})`),
        todos: todos.filter((t) => !t.done).map((t) => t.text),
        comments,
      };
      const out = await summarizeDeck(input);
      setText(out);
      try {
        localStorage.setItem(SUMMARY_PREFIX + dayKey, out);
      } catch {
        /* ignore */
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className={cn("p-5", className)}>
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet" />
        <span className="font-display text-sm font-bold text-text">Summary of your day</span>
        <div className="ml-auto flex items-center gap-3">
          {text && <SpeakButton id="deck-summary" text={text} />}
          <Button variant="subtle" onClick={generate} disabled={loading || !ready}>
            {loading ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
            {text ? "Regenerate" : "Summarize my day"}
          </Button>
        </div>
      </div>
      {!ready ? (
        <p className="font-body text-sm text-muted">
          Add an AI provider in{" "}
          <Link to="/settings" className="text-cyan hover:underline">
            Settings
          </Link>{" "}
          to generate a spoken-friendly briefing of your day.
        </p>
      ) : text ? (
        <p className="selectable font-body text-[15px] leading-relaxed text-text">{text}</p>
      ) : (
        <p className="font-body text-sm text-muted">
          Get an AI briefing of today's meetings and tasks — what to expect and what matters most.
        </p>
      )}
    </Card>
  );
}

function UpNext({ upNext, now }: { upNext: { event: deck.ParsedEvent; mode: deck.Mode }; now: Date }) {
  const { event: e, mode } = upNext;
  const accent = KIND_COLOR[e.kind];
  const countdown = mode === "now" ? `ends ${deck.relLabel(e.end, now)}` : deck.relLabel(e.start, now);

  return (
    <Card className="relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.13]"
        style={{ background: `radial-gradient(circle at 88% 0%, ${accent}, transparent 55%)` }}
      />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-wide"
            style={{ color: "#05060a", background: mode === "now" ? "#00f5ff" : accent }}
          >
            {mode === "now" ? "Happening now" : "Up next"}
          </span>
          <span className="font-mono text-sm" style={{ color: accent }}>
            {countdown}
          </span>
        </div>
        <div className="mt-2 font-display text-[26px] font-bold leading-tight text-text">{e.title}</div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-body text-sm text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-4 w-4" /> {deck.fmtTime(e.start)} – {deck.fmtTime(e.end)}
            <span className="text-faint">({deck.durLabel(deck.minutesBetween(e.start, e.end))})</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            {e.kind === "Video" ? <Video className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
            {e.location}
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide"
              style={{ color: accent, background: `${accent}1e` }}
            >
              {KIND_TAG[e.kind]}
            </span>
          </span>
          {e.who && (
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-4 w-4" /> {e.who}
            </span>
          )}
        </div>
        {e.url && (
          <div className="mt-4">
            <Button variant="primary" onClick={() => openMeeting(e.url)}>
              <ExternalLink className="h-4 w-4" /> Join call
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function AgendaRow({
  e,
  now,
  onOpen,
}: {
  e: deck.ParsedEvent;
  now: Date;
  onOpen: (e: deck.ParsedEvent) => void;
}) {
  const accent = KIND_COLOR[e.kind];
  const isPast = e.end <= now;
  const isNow = e.start <= now && e.end > now;
  return (
    <div
      onClick={() => onOpen(e)}
      className={cn(
        "flex cursor-pointer items-center gap-3 border-b border-outline px-4 py-3 transition-colors last:border-0 hover:bg-surface-3",
        isPast && "opacity-50"
      )}
    >
      <div className="w-16 shrink-0 text-right font-mono text-xs text-muted">{deck.fmtTime(e.start)}</div>
      <span className="h-8 w-[3px] shrink-0 rounded-full" style={{ background: accent }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-body text-sm font-semibold text-text">{e.title}</span>
          {isNow && (
            <span className="shrink-0 rounded-full bg-cyan px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#05060a]">
              NOW
            </span>
          )}
        </div>
        <div className="truncate font-body text-xs text-muted">{e.location}</div>
      </div>
      {e.url && e.kind === "Video" && (
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            openMeeting(e.url);
          }}
          className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
          title="Join"
        >
          <Video className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function fieldChipColor(name: string, value: string): string | null {
  if (/priorit|urgen/i.test(name)) {
    const v = value.toLowerCase();
    if (v.includes("high") || v.includes("urgent")) return "#ff0055";
    if (v.includes("med")) return "#fbbf24";
    if (v.includes("low")) return "#8a8a99";
  }
  return null;
}

function Chip({ children, color }: { children: ReactNode; color?: string | null }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide"
      style={
        color
          ? { color, background: `${color}1e` }
          : { color: "var(--color-muted)", background: "var(--color-surface-1)" }
      }
    >
      {children}
    </span>
  );
}

function TaskColumn({
  title,
  icon: Icon,
  tone,
  tasks,
  now,
  onOpen,
}: {
  title: string;
  icon: typeof CheckSquare;
  tone: string;
  tasks: deck.ParsedTask[];
  now: Date;
  onOpen: (t: deck.ParsedTask) => void;
}) {
  const ignored = useIgnored();
  const { hiddenFields } = useSettings();
  const isHidden = (name: string) => hiddenFields.some((h) => h.toLowerCase() === name.toLowerCase());
  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b border-outline px-4 py-3">
        <Icon className="h-4 w-4" style={{ color: tone }} />
        <span className="font-display text-sm font-bold text-text">{title}</span>
        <span className="ml-auto font-mono text-xs text-faint">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="px-4 py-6 text-center font-body text-xs text-muted">Nothing here.</div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          {tasks.map((t, i) => {
            const muted = ignored.has(deck.taskKey(t));
            return (
              <div
                key={i}
                onClick={() => onOpen(t)}
                className={cn(
                  "group cursor-pointer border-b border-outline px-4 py-2.5 transition-colors last:border-0 hover:bg-surface-3",
                  muted && "opacity-45"
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-body text-sm text-text">{t.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
                      <span className="text-faint">{t.proj}</span>
                      <span className="text-outline">·</span>
                      <span style={{ color: title === "Overdue" ? "#ff0055" : "var(--color-muted)" }}>
                        {deck.dueLabel(t.due, now)}
                      </span>
                      {muted && <span className="text-faint">· muted</span>}
                    </div>
                    {(t.assignee || t.section || t.fields.length > 0 || t.tags.length > 0 || t.numSubtasks > 0) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {t.assignee && (
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted">
                            <User className="h-3 w-3" /> {t.assignee}
                          </span>
                        )}
                        {t.section && <Chip>{t.section}</Chip>}
                        {t.fields
                          .filter((f) => !isHidden(f.name))
                          .map((f) => (
                            <Chip key={f.name} color={fieldChipColor(f.name, f.value)}>
                              {f.value}
                            </Chip>
                          ))}
                        {t.tags.map((tag) => (
                          <Chip key={tag} color="#c000ff">
                            #{tag}
                          </Chip>
                        ))}
                        {t.numSubtasks > 0 && (
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
                            <ListTree className="h-3 w-3" /> {t.numSubtasks}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleIgnore(deck.taskKey(t));
                    }}
                    title={muted ? "Include in the day summary" : "Ignore in the day summary"}
                    className={cn(
                      "shrink-0 rounded p-1 text-faint transition-all hover:text-cyan",
                      !muted && "opacity-0 group-hover:opacity-100"
                    )}
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function EventDetailModal({
  e,
  now,
  onClose,
}: {
  e: deck.ParsedEvent;
  now: Date;
  onClose: () => void;
}) {
  const accent = KIND_COLOR[e.kind];
  // People pages whose name appears in the meeting title — the 1:1 brief.
  const { data: people } = useAsync(() => matchingPeoplePages(e.title), [e.title]);
  const vaultDir = useSettings().vaultDir.trim();
  const [prep, setPrep] = useState<PrepData | null>(null);
  const [prepBusy, setPrepBusy] = useState(false);

  async function runPrep() {
    if (prepBusy) return;
    setPrepBusy(true);
    try {
      setPrep(await buildPrep(e.title));
    } catch (err) {
      notify.error(String((err as Error).message ?? err));
    } finally {
      setPrepBusy(false);
    }
  }

  const openNote = (rel: string) =>
    void api
      .openUrl(
        `obsidian://open?path=${encodeURIComponent(`${vaultDir.replace(/[/\\]+$/, "")}/${rel}`)}`
      )
      .catch(() => notify.error("Couldn't open Obsidian"));
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[16px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-outline px-5 py-3.5">
          {e.kind === "Video" ? (
            <Video className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} />
          ) : (
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-body text-sm font-semibold text-text">{e.title}</div>
            <div className="mt-0.5 font-mono text-[11px] text-faint">
              {deck.fmtTime(e.start)} – {deck.fmtTime(e.end)} (
              {deck.durLabel(deck.minutesBetween(e.start, e.end))}) · {deck.relLabel(e.start, now)}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-body text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              {e.kind === "Video" ? <Video className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
              {e.location}
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide"
                style={{ color: accent, background: `${accent}1e` }}
              >
                {KIND_TAG[e.kind]}
              </span>
            </span>
            {e.who && (
              <span className="inline-flex items-center gap-1.5">
                <Users className="h-4 w-4" /> {e.who}
              </span>
            )}
          </div>

          {e.description?.trim() ? (
            <p className="selectable whitespace-pre-wrap font-body text-sm leading-relaxed text-text">
              {e.description.trim()}
            </p>
          ) : (
            <p className="font-body text-sm text-faint">No agenda text in the invite.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {e.url && (
              <Button variant="primary" onClick={() => openMeeting(e.url)}>
                <ExternalLink className="h-4 w-4" /> Join call
              </Button>
            )}
            {isTauri() && (
              <Button
                onClick={() => {
                  void api.pickAudioFile().then((p) => {
                    if (!p) return;
                    onClose();
                    void importAudioNote(p, e.title);
                  });
                }}
                title="Pick a recording of this meeting — transcribes, summarizes, and files the note under this meeting's title"
              >
                <MessageSquare className="h-4 w-4" /> Transcribe a recording
              </Button>
            )}
            {(people ?? []).map((p) => (
              <Button
                key={p.rel}
                onClick={() =>
                  void api
                    .openUrl(
                      `obsidian://open?path=${encodeURIComponent(`${vaultDir.replace(/[/\\]+$/, "")}/${p.rel}`)}`
                    )
                    .catch(() => notify.error("Couldn't open Obsidian"))
                }
                title="Open this person's page — open action items and past meetings"
              >
                <User className="h-4 w-4" /> {p.name}
              </Button>
            ))}
            {vaultDir && (
              <Button variant="subtle" onClick={() => void runPrep()} disabled={prepBusy}>
                {prepBusy ? <Spinner className="h-4 w-4" /> : <ListTree className="h-4 w-4" />}
                Prep brief
              </Button>
            )}
          </div>

          {prep && (
            <div className="mt-4 space-y-3 border-t border-outline pt-3">
              {prep.people.some((p) => p.actions.length > 0) && (
                <div>
                  <div className="mb-1 font-display text-[10.5px] font-bold uppercase tracking-[1px] text-muted">
                    Open action items
                  </div>
                  {prep.people
                    .filter((p) => p.actions.length > 0)
                    .map((p) => (
                      <div key={p.rel} className="mb-1.5">
                        <div className="font-body text-xs font-semibold text-text">{p.name}</div>
                        <ul className="ml-4 list-disc font-body text-[12.5px] leading-relaxed text-muted">
                          {p.actions.map((a, i) => (
                            <li key={i}>{a.replace(/\s*—\s*\[\[[^\]]*\]\].*$/, "")}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              )}
              {prep.lastMeeting && (
                <div>
                  <div className="mb-1 font-display text-[10.5px] font-bold uppercase tracking-[1px] text-muted">
                    Last time —{" "}
                    <button className="text-cyan hover:underline" onClick={() => openNote(prep.lastMeeting!.rel)}>
                      {prep.lastMeeting.title}
                    </button>
                    {prep.lastMeeting.date ? ` (${new Date(prep.lastMeeting.date).toLocaleDateString()})` : ""}
                  </div>
                  <div className="selectable whitespace-pre-wrap font-body text-[12.5px] leading-relaxed text-muted">
                    {prep.lastMeeting.summary || "No summary recorded."}
                  </div>
                </div>
              )}
              {prep.related.length > 0 && (
                <div>
                  <div className="mb-1 font-display text-[10.5px] font-bold uppercase tracking-[1px] text-muted">
                    Related notes
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {prep.related.map((r) => (
                      <button
                        key={r.rel}
                        onClick={() => openNote(r.rel)}
                        className="rounded-full border border-outline bg-surface-1 px-2.5 py-1 font-body text-[11.5px] text-muted transition-colors hover:border-outline-2 hover:text-cyan"
                        title={r.snippet}
                      >
                        {r.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!prep.people.some((p) => p.actions.length > 0) && !prep.lastMeeting && prep.related.length === 0 && (
                <div className="font-body text-xs text-faint">
                  Nothing on file yet — prep briefs fill in once meetings with these people are recorded.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskDetailModal({
  task,
  now,
  onClose,
}: {
  task: deck.ParsedTask;
  now: Date;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const { hiddenFields } = useSettings();
  const isHidden = (name: string) => hiddenFields.some((h) => h.toLowerCase() === name.toLowerCase());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getTaskDetail(keyRef("asana-token", getSettings().asanaToken), task.id)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [task.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[16px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-outline px-5 py-3.5">
          <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-cyan" />
          <div className="min-w-0 flex-1">
            <div className="font-body text-sm font-semibold text-text">{task.name}</div>
            <div className="mt-0.5 font-mono text-[11px] text-faint">
              {task.proj} · {deck.dueLabel(task.due, now)}
            </div>
          </div>
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(task.name)
                .then(() => notify.success("Title copied"))
                .catch(() => notify.error("Couldn't copy"))
            }
            title="Copy task title"
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
          >
            <Copy className="h-4 w-4" />
          </button>
          {task.url && (
            <button
              onClick={() => openTask(task.url)}
              title="Open in Asana"
              className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {/* Meta chips */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {task.assignee && (
              <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted">
                <User className="h-3.5 w-3.5" /> {task.assignee}
              </span>
            )}
            {task.section && <Chip>{task.section}</Chip>}
            {task.fields.map((f) => {
              const hidden = isHidden(f.name);
              const color = fieldChipColor(f.name, f.value);
              return (
                <button
                  key={f.name}
                  onClick={() => toggleHiddenField(f.name)}
                  title={hidden ? `Show "${f.name}" on task cards` : `Hide "${f.name}" from task cards`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide transition-colors hover:opacity-80",
                    hidden && "opacity-40"
                  )}
                  style={
                    color
                      ? { color, background: `${color}1e` }
                      : { color: "var(--color-muted)", background: "var(--color-surface-1)" }
                  }
                >
                  {f.name}: {f.value} <EyeOff className="h-2.5 w-2.5" />
                </button>
              );
            })}
            {task.tags.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  toggleHiddenTag(tag);
                  notify.info(`Hiding tasks tagged #${tag} — manage in Settings`);
                  onClose();
                }}
                title={`Hide tasks tagged #${tag}`}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide transition-colors hover:opacity-80"
                style={{ color: "#c000ff", background: "#c000ff1e" }}
              >
                #{tag} <EyeOff className="h-2.5 w-2.5" />
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-8">
              <Loading label="Loading task…" />
            </div>
          ) : (
            <div className="space-y-5">
              {detail?.notes?.trim() && (
                <div>
                  <SectionTitle>Description</SectionTitle>
                  <p className="selectable whitespace-pre-wrap break-words font-body text-[13px] leading-relaxed text-text">
                    {detail.notes}
                  </p>
                </div>
              )}

              {detail && detail.subtasks.length > 0 && (
                <div>
                  <SectionTitle right={<span className="text-xs text-faint">{detail.subtasks.length}</span>}>
                    <span className="inline-flex items-center gap-1.5">
                      <ListTree className="h-3.5 w-3.5" /> Subtasks
                    </span>
                  </SectionTitle>
                  <div className="space-y-1.5">
                    {detail.subtasks.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 font-body text-[13px]">
                        {s.completed ? (
                          <CheckSquare className="h-3.5 w-3.5 shrink-0 text-cyan" />
                        ) : (
                          <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                        )}
                        <span className={cn("min-w-0 flex-1", s.completed ? "text-faint line-through" : "text-text")}>
                          {s.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail && detail.comments.length > 0 && (
                <div>
                  <SectionTitle right={<span className="text-xs text-faint">{detail.comments.length}</span>}>
                    <span className="inline-flex items-center gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" /> Comments
                    </span>
                  </SectionTitle>
                  <div className="space-y-3">
                    {detail.comments.map((c, i) => (
                      <div key={i}>
                        <div className="font-mono text-[11px] text-cyan">{c.author}</div>
                        <p className="selectable whitespace-pre-wrap break-words font-body text-[13px] leading-relaxed text-muted">
                          {c.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail && detail.attachments.length > 0 && (
                <div>
                  <SectionTitle>
                    <span className="inline-flex items-center gap-1.5">
                      <Paperclip className="h-3.5 w-3.5" /> Attachments
                    </span>
                  </SectionTitle>
                  <div className="space-y-1.5">
                    {detail.attachments.map((a, i) => (
                      <button
                        key={i}
                        onClick={() => a.url && api.openUrl(a.url)}
                        className="block w-full truncate text-left font-body text-[13px] text-cyan hover:underline"
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {detail &&
                !detail.notes?.trim() &&
                detail.subtasks.length === 0 &&
                detail.comments.length === 0 &&
                detail.attachments.length === 0 && (
                  <p className="font-body text-sm text-muted">No description, comments, or subtasks.</p>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof LayoutList;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-body text-xs font-semibold transition-colors",
        active ? "bg-surface-3 text-cyan" : "text-muted hover:text-text"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

const HOUR_PX = 46;

function CalendarWeek({
  week,
  now,
}: {
  week: { day: Date; events: deck.ParsedEvent[] }[];
  now: Date;
}) {
  // Hour range: cover all events, but always show at least 8:00–18:00.
  let earliest = 8;
  let latest = 18;
  for (const d of week) {
    for (const e of d.events) {
      earliest = Math.min(earliest, e.start.getHours());
      latest = Math.max(latest, e.end.getHours() + (e.end.getMinutes() > 0 ? 1 : 0));
    }
  }
  earliest = Math.max(0, earliest);
  latest = Math.min(24, latest);
  const hours = Math.max(1, latest - earliest);
  const gridH = hours * HOUR_PX;

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex min-w-[640px]">
        {/* Hour gutter */}
        <div className="w-12 shrink-0 border-r border-outline">
          <div className="border-b border-outline px-2 py-2 text-center">
            <div className="font-display text-xs font-bold">&nbsp;</div>
            <div className="font-mono text-[10px]">&nbsp;</div>
          </div>
          <div className="relative" style={{ height: gridH }}>
            {Array.from({ length: hours }, (_, i) => (
              <div
                key={i}
                className="absolute right-1.5 -translate-y-1/2 font-mono text-[10px] text-faint"
                style={{ top: i * HOUR_PX }}
              >
                {formatHour(earliest + i)}
              </div>
            ))}
          </div>
        </div>
        {/* Day columns */}
        <div className="flex flex-1">
          {week.map((d, di) => {
            const isToday = deck.sameDay(d.day, now);
            const placed = packLanes(d.events);
            return (
              <div key={di} className="flex-1 border-r border-outline last:border-0">
                <div className="sticky top-0 border-b border-outline bg-surface-2 px-2 py-2 text-center">
                  <div
                    className={cn(
                      "font-display text-xs font-bold uppercase tracking-wide",
                      isToday ? "text-cyan" : "text-muted"
                    )}
                  >
                    {di === 0 ? "Today" : d.day.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div className="font-mono text-[10px] text-faint">
                    {d.day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </div>
                </div>
                <div className="relative" style={{ height: gridH }}>
                  {/* hour lines */}
                  {Array.from({ length: hours }, (_, i) => (
                    <div
                      key={i}
                      className="absolute inset-x-0 border-t border-outline/50"
                      style={{ top: i * HOUR_PX }}
                    />
                  ))}
                  {/* now line */}
                  {isToday &&
                    now.getHours() + now.getMinutes() / 60 >= earliest &&
                    now.getHours() + now.getMinutes() / 60 <= latest && (
                      <div
                        className="absolute inset-x-0 z-10 h-px bg-cyan"
                        style={{
                          top: (now.getHours() + now.getMinutes() / 60 - earliest) * HOUR_PX,
                          boxShadow: "0 0 6px #00f5ff",
                        }}
                      />
                    )}
                  {placed.map(({ e, lane, lanes }, ei) => {
                    const startF = e.start.getHours() + e.start.getMinutes() / 60;
                    const endF = e.end.getHours() + e.end.getMinutes() / 60;
                    const top = (startF - earliest) * HOUR_PX;
                    const height = Math.max(16, (endF - startF) * HOUR_PX - 2);
                    const accent = KIND_COLOR[e.kind];
                    return (
                      <button
                        key={ei}
                        onClick={() => e.url && openMeeting(e.url)}
                        title={`${e.title} · ${deck.fmtTime(e.start)}–${deck.fmtTime(e.end)}`}
                        className="absolute overflow-hidden rounded-md border px-1.5 py-1 text-left"
                        style={{
                          top,
                          height,
                          left: `${(lane / lanes) * 100}%`,
                          width: `calc(${(1 / lanes) * 100}% - 3px)`,
                          background: `${accent}22`,
                          borderColor: `${accent}55`,
                        }}
                      >
                        <div className="truncate font-body text-[11px] font-semibold text-text">
                          {e.title}
                        </div>
                        <div className="truncate font-mono text-[9.5px] text-muted">
                          {deck.fmtTime(e.start)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/** Assign overlapping events to side-by-side lanes. */
function packLanes(
  events: deck.ParsedEvent[]
): Array<{ e: deck.ParsedEvent; lane: number; lanes: number }> {
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  const laneEnds: number[] = [];
  const out = sorted.map((e) => {
    let lane = laneEnds.findIndex((end) => end <= e.start.getTime());
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e.end.getTime());
    } else {
      laneEnds[lane] = e.end.getTime();
    }
    return { e, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  return out.map((o) => ({ ...o, lanes }));
}

function formatHour(h: number): string {
  const hh = ((h + 11) % 12) + 1;
  return `${hh}${h < 12 ? "a" : "p"}`;
}

function TodoList({
  today,
  buckets,
  now,
}: {
  today: deck.ParsedEvent[];
  buckets: Record<deck.Bucket, deck.ParsedTask[]>;
  now: Date;
}) {
  const todos = useTodos();
  const settings = useSettings();
  const ready = isProviderReady(settings);
  const [text, setText] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const doneCount = todos.filter((t) => t.done).length;

  function add() {
    if (!text.trim()) return;
    addTodo(text);
    setText("");
  }

  async function suggest() {
    setSuggesting(true);
    try {
      const existing = todos.map((t) => t.text.toLowerCase());
      const items = await suggestTodos({
        dateLabel: now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
        agenda: today.map((e) => `${deck.fmtTime(e.start)} ${e.title}`),
        tasks: [...buckets.Overdue, ...buckets.Today, ...buckets.Upcoming]
          .slice(0, 15)
          .map((t) => `${t.name} (${t.proj})`),
        existing: todos.filter((t) => !t.done).map((t) => t.text),
      });
      const fresh = items.filter((it) => !existing.includes(it.toLowerCase()));
      fresh.forEach(addTodo);
      notify[fresh.length ? "success" : "info"](
        fresh.length ? `Added ${fresh.length} to-do${fresh.length === 1 ? "" : "s"}` : "No new suggestions"
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b border-outline px-4 py-3">
        <ListTodo className="h-4 w-4 text-cyan" />
        <span className="font-display text-sm font-bold text-text">My list</span>
        <button
          onClick={suggest}
          disabled={suggesting || !ready}
          title={ready ? "Suggest to-dos from your day" : "Add an AI provider in Settings"}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-outline px-2 py-1 font-body text-[11px] font-semibold text-muted transition-colors hover:border-violet/50 hover:text-violet disabled:opacity-40"
        >
          {suggesting ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          Suggest
        </button>
        <span className="font-mono text-xs text-faint">{todos.length - doneCount} open</span>
      </div>
      <div className="flex items-center gap-2 border-b border-outline px-3 py-2.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a to-do…"
          className="min-w-0 flex-1 bg-transparent px-1 font-body text-sm text-fg outline-none placeholder:text-faint"
        />
        <button
          onClick={add}
          disabled={!text.trim()}
          className="shrink-0 rounded-lg border border-outline p-1.5 text-muted transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40"
          title="Add"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {todos.length === 0 ? (
        <div className="px-4 py-6 text-center font-body text-xs text-muted">
          Nothing yet — add your own to-dos here.
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          {todos.map((t) => (
            <div key={t.id} className="group flex items-center gap-2.5 border-b border-outline px-4 py-2 last:border-0">
              <button
                onClick={() => toggleTodo(t.id)}
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  t.done ? "border-cyan bg-cyan/20 text-cyan" : "border-outline hover:border-cyan"
                )}
                title={t.done ? "Mark not done" : "Mark done"}
              >
                {t.done && <CheckSquare className="h-3 w-3" />}
              </button>
              <span
                className={cn(
                  "min-w-0 flex-1 font-body text-sm",
                  t.done ? "text-faint line-through" : "text-text"
                )}
              >
                {t.text}
              </span>
              <button
                onClick={() => removeTodo(t.id)}
                className="shrink-0 rounded p-1 text-faint opacity-0 transition-all hover:text-error group-hover:opacity-100"
                title="Remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {doneCount > 0 && (
        <button
          onClick={clearDoneTodos}
          className="flex w-full items-center justify-center gap-1.5 border-t border-outline py-2 font-body text-[11px] text-faint transition-colors hover:text-error"
        >
          <Trash2 className="h-3 w-3" /> Clear {doneCount} done
        </button>
      )}
    </Card>
  );
}

/** Recent meeting notes (recorder output in the vault): summary at a glance,
 * action items promotable straight into the Deck to-do list. */
/** Buttons for the user's .bat/.ps1 scripts — anything that executes is gated
 * on acting mode, like the rest of the agentic surface. */
/** Home Assistant glance/control card — entities picked in Settings. */
function HomeCard() {
  const s = useSettings();
  const url = s.haUrl.trim();
  const ids = s.haEntities;
  const key = `ha:${url}:${ids.join(",")}`;
  const { data, error, refresh } = useCachedAsync<HaEntity[]>(key, () =>
    api.haStates(url, keyRef("ha-token", s.haToken), ids)
  );
  const [busy, setBusy] = useState<string | null>(null);

  // 30s poll while the Deck is open; silent — stale data stays on failure.
  useEffect(() => {
    if (!url || ids.length === 0) return;
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!url || ids.length === 0) return null;

  const SERVICE: Record<string, [string, string]> = {
    light: ["homeassistant", "toggle"],
    switch: ["homeassistant", "toggle"],
    scene: ["scene", "turn_on"],
    script: ["script", "turn_on"],
  };

  async function act(e: HaEntity) {
    const svc = SERVICE[e.domain];
    if (!svc || busy) return;
    setBusy(e.id);
    try {
      await api.haCallService(url, keyRef("ha-token", s.haToken), svc[0], svc[1], e.id);
      await refresh();
    } catch (err) {
      notify.error(String((err as { message?: string })?.message ?? err));
    } finally {
      setBusy(null);
    }
  }

  const toggles = (data ?? []).filter((e) => e.domain === "light" || e.domain === "switch");
  const runs = (data ?? []).filter((e) => e.domain === "scene" || e.domain === "script");
  const sensors = (data ?? []).filter((e) => e.domain === "sensor" || e.domain === "binary_sensor");

  return (
    <div className="mt-6">
      <SectionTitle>Home</SectionTitle>
      <Card className="p-3">
        {error && !data && (
          <div className="px-1 py-1 font-body text-xs text-muted">Home Assistant unreachable</div>
        )}
        {(toggles.length > 0 || runs.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {toggles.map((e) => (
              <button
                key={e.id}
                onClick={() => void act(e)}
                disabled={busy !== null}
                className={cn(
                  "rounded-full border px-3 py-1.5 font-body text-xs transition-colors",
                  e.state === "on"
                    ? "border-cyan/60 bg-cyan/10 text-cyan"
                    : "border-outline text-muted hover:text-text"
                )}
              >
                {busy === e.id ? <Spinner className="h-3 w-3" /> : e.name}
              </button>
            ))}
            {runs.map((e) => (
              <button
                key={e.id}
                onClick={() => void act(e)}
                disabled={busy !== null}
                className="rounded-full border border-violet/40 px-3 py-1.5 font-body text-xs text-violet transition-colors hover:bg-violet/10"
              >
                {busy === e.id ? <Spinner className="h-3 w-3" /> : `▶ ${e.name}`}
              </button>
            ))}
          </div>
        )}
        {sensors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1">
            {sensors.map((e) => (
              <span key={e.id} className="font-mono text-[11px] text-muted">
                {e.name} · <span className="text-text">{e.state}</span>
                {e.unit ? ` ${e.unit}` : ""}
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function QuickScripts() {
  const acting = useSettings().actingMode;
  const { data } = useAsync<string[]>(
    () => (acting ? api.listUserScripts().catch(() => []) : Promise.resolve([])),
    [acting]
  );
  const [busy, setBusy] = useState<string | null>(null);
  if (!acting || !data?.length) return null;

  async function run(name: string) {
    if (busy) return;
    setBusy(name);
    try {
      const out = await api.runUserScript(name);
      notify.success(`${name}: ${out.split(/\r?\n/).filter(Boolean).pop() ?? "done"}`);
    } catch (e) {
      notify.error(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6">
      <SectionTitle>Quick scripts</SectionTitle>
      <Card className="flex flex-wrap items-center gap-2 p-3">
        {data.map((s) => (
          <Button key={s} variant="subtle" disabled={busy !== null} onClick={() => void run(s)}>
            {busy === s ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {s.replace(/\.(bat|cmd|ps1)$/i, "")}
          </Button>
        ))}
      </Card>
    </div>
  );
}

function MeetingNotes() {
  const vaultDir = useSettings().vaultDir.trim();
  // Calendar events for the rescue rows' match-to-meeting picker (the ICS
  // window reaches back to the 14-day rescue cutoff).
  const deckData = useDeckData().data;
  const { data, reload } = useAsync<DocFile[]>(
    () => (vaultDir || isSnapshot() ? api.listVault(vaultDir) : Promise.resolve([])),
    [vaultDir]
  );
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // path of the expanded note
  const [note, setNote] = useState<(MeetingNoteParts & { raw?: string; loading?: boolean }) | null>(null);
  const [aiBusy, setAiBusy] = useState<"summary" | "tasks" | "names" | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [showAllTasks, setShowAllTasks] = useState(false);

  const allMeetingNotes = (data ?? []).filter((d) =>
    d.name.toLowerCase().replace(/\\/g, "/").includes("output/meetings/")
  );
  const notes = [...allMeetingNotes]
    .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
    .slice(0, 6);

  // Recordings from the last two weeks whose pipeline never produced a note
  // (docker down, STT error…) — matched by the notes' `audio:` frontmatter.
  const recPhase = useMeetingRec().phase;
  const [retryFor, setRetryFor] = useState<string | null>(null);
  const [retryTitle, setRetryTitle] = useState("");
  const { data: orphans, reload: reloadOrphans } = useAsync<RecordingFile[]>(async () => {
    if (!vaultDir || !data) return [];
    const recs = await api.listRecordings().catch(() => [] as RecordingFile[]);
    const cutoff = Date.now() - 14 * 86_400_000;
    const recent = recs.filter((r) => r.modified && new Date(r.modified).getTime() >= cutoff);
    if (recent.length === 0) return [];
    // Only notes dated on/after the oldest candidate can reference one.
    const minDate = recent.map((r) => r.modified!.slice(0, 10)).sort()[0];
    const used = new Set<string>();
    await Promise.all(
      allMeetingNotes
        .filter((d) => (d.name.split(/[\\/]/).pop() ?? "").slice(0, 10) >= minDate)
        .map(async (d) => {
          const md = await api.readVaultFile(vaultDir, d.path).catch(() => "");
          const audio = md.match(/^audio: (.+)$/m)?.[1];
          if (audio) used.add(audio.trim().split("/").pop()!.toLowerCase());
        })
    );
    return recent.filter((r) => !used.has(r.name.toLowerCase()));
  }, [vaultDir, data]);

  if (!vaultDir) return null;

  async function runRetry(r: RecordingFile) {
    await retryRecordingNote(r, retryTitle); // errors surface as toasts inside
    setRetryFor(null);
    setRetryTitle("");
    reload();
    reloadOrphans();
  }

  /** Meetings on the recording's day, for naming a rescued note. */
  function meetingsForDay(r: RecordingFile) {
    if (!deckData || !r.modified) return [];
    const day = new Date(r.modified);
    return deck
      .parseEvents(deckData)
      .filter((e) => deck.sameDay(e.start, day) && e.kind !== "Block")
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async function runImport() {
    const p = importPath.trim();
    if (!p || importing) return;
    setImporting(true);
    try {
      await importAudioNote(p, importTitle);
      setImportOpen(false);
      setImportPath("");
      setImportTitle("");
      reload();
    } finally {
      setImporting(false);
    }
  }

  function toggle(d: DocFile) {
    if (open === d.path) {
      setOpen(null);
      return;
    }
    setOpen(d.path);
    setSpeakerNames({});
    setShowAllTasks(false);
    setNote({ title: "", date: null, duration: null, summary: "", actions: [], loading: true });
    api
      .readVaultFile(vaultDir, d.path)
      .then((md) => setNote({ ...parseMeetingNote(md), raw: md }))
      .catch((e) => {
        notify.error(String(e));
        setOpen(null);
      });
  }

  /** Persist a rewritten note (write_vault needs the RELATIVE path = d.name). */
  async function saveNote(d: DocFile, next: string) {
    await api.writeVaultFile(vaultDir, d.name, next);
    rebuildPeoplePages(vaultDir)
      .catch(() => 0)
      .finally(() => api.syncVaultGit(vaultDir).catch(() => {}));
    setNote({ ...parseMeetingNote(next), raw: next });
  }

  /** Run an AI pass over the open note, write the result back, re-parse. */
  async function runAi(kind: "summary" | "tasks", d: DocFile) {
    if (!note?.raw || aiBusy) return;
    if (!isProviderReady(getSettings())) {
      notify.error("Configure an AI provider in Settings first.");
      return;
    }
    setAiBusy(kind);
    try {
      const next =
        kind === "summary"
          ? withSummary(note.raw, await aiSummarize(note.raw))
          : withTasks(note.raw, await aiExtractTasks(note.raw));
      if (next !== note.raw) await saveNote(d, next);
      else setNote({ ...parseMeetingNote(next), raw: next });
      notify.success(kind === "summary" ? "Summary updated." : "Tasks extracted.");
    } catch (e) {
      notify.error(String((e as { message?: string })?.message ?? e));
    } finally {
      setAiBusy(null);
    }
  }

  const baseName = (d: DocFile) => d.name.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? d.name;

  return (
    <div className="mt-6">
      <SectionTitle
        right={
          <button
            onClick={() => setImportOpen((o) => !o)}
            className="font-body text-xs text-muted transition-colors hover:text-cyan"
          >
            Import audio…
          </button>
        }
      >
        Meeting notes
      </SectionTitle>
      {importOpen && (
        <Card className="mb-3 flex flex-wrap items-center gap-2 p-3">
          <input
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            placeholder="C:\path\to\recording.mp3 (any audio/video ffmpeg can read)"
            className="min-w-64 flex-1 rounded-lg border border-outline bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-cyan"
          />
          {isTauri() && (
            <Button
              variant="subtle"
              onClick={() => void api.pickAudioFile().then((p) => p && setImportPath(p))}
            >
              Browse…
            </Button>
          )}
          <input
            value={importTitle}
            onChange={(e) => setImportTitle(e.target.value)}
            placeholder="title (optional)"
            className="w-44 rounded-lg border border-outline bg-bg px-3 py-2 font-body text-xs text-text outline-none focus:border-cyan"
          />
          <Button onClick={() => void runImport()} disabled={!importPath.trim() || importing}>
            {importing ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            Transcribe & summarize
          </Button>
        </Card>
      )}
      {(orphans?.length ?? 0) > 0 && (
        <Card className="mb-3 overflow-hidden p-0">
          <div className="px-4 pb-1 pt-3 font-body text-xs font-semibold text-warn">
            Unprocessed recordings — captured but never transcribed
          </div>
          {orphans!.map((r) => (
            <div
              key={r.path}
              className="flex flex-wrap items-center gap-2 border-t border-outline px-4 py-2.5 first:border-t-0"
            >
              <Mic className="h-4 w-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={r.path}>
                {r.name}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">
                {r.modified ? new Date(r.modified).toLocaleString() : ""} ·{" "}
                {Math.max(1, Math.round(r.seconds / 60))}m
              </span>
              {retryFor === r.path ? (
                <>
                  {meetingsForDay(r).length > 0 && (
                    <select
                      value=""
                      onChange={(e) => e.target.value && setRetryTitle(e.target.value)}
                      className="w-44 rounded-lg border border-outline bg-bg px-2 py-1.5 font-body text-xs text-text outline-none focus:border-cyan"
                    >
                      <option value="">match a meeting…</option>
                      {meetingsForDay(r).map((ev, i) => (
                        <option key={i} value={ev.title}>
                          {deck.fmtTime(ev.start)} · {ev.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    autoFocus
                    value={retryTitle}
                    onChange={(e) => setRetryTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void runRetry(r)}
                    placeholder="meeting title (optional)"
                    className="w-52 rounded-lg border border-outline bg-bg px-3 py-1.5 font-body text-xs text-text outline-none focus:border-cyan"
                  />
                  <Button onClick={() => void runRetry(r)} disabled={recPhase !== "idle"}>
                    {recPhase !== "idle" ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                    Go
                  </Button>
                </>
              ) : (
                <Button
                  variant="subtle"
                  onClick={() => {
                    setRetryFor(r.path);
                    setRetryTitle("");
                  }}
                  disabled={recPhase !== "idle"}
                >
                  Transcribe now
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
      {notes.length === 0 ? (
        importOpen ? null : (
          <Card className="px-4 py-3 font-body text-xs text-muted">
            No meeting notes yet — record a meeting or import an audio file.
          </Card>
        )
      ) : (
      <Card className="overflow-hidden p-0">
        {notes.map((d) => (
          <div key={d.path} className="border-b border-outline last:border-b-0">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <MessageSquare className="h-4 w-4 shrink-0 text-cyan" />
              <button
                onClick={() => toggle(d)}
                className="min-w-0 flex-1 truncate text-left font-body text-sm text-text hover:text-cyan"
                title={open === d.path ? "Collapse" : "Show summary + tasks"}
              >
                {baseName(d)}
              </button>
              {d.modified && (
                <span className="shrink-0 font-mono text-[10.5px] text-faint">
                  {new Date(d.modified).toLocaleDateString()}
                </span>
              )}
              <button
                onClick={() =>
                  void api
                    .openUrl(`obsidian://open?path=${encodeURIComponent(`${vaultDir.replace(/[/\\]+$/, "")}/${d.path}`)}`)
                    .catch(() => notify.error("Couldn't open Obsidian"))
                }
                className="shrink-0 text-faint transition-colors hover:text-cyan"
                title="Open in Obsidian"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
            {open === d.path && note && (
              <div className="border-t border-outline bg-bg/40 px-4 py-3">
                {note.loading ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <>
                    {(note.duration || note.date) && (
                      <div className="mb-2 font-mono text-[10.5px] text-faint">
                        {note.date ? new Date(note.date).toLocaleString() : ""}
                        {note.duration ? ` · ${note.duration}` : ""}
                      </div>
                    )}
                    {note.summary ? (
                      <>
                        <SpeakButton
                          id={`meeting-note-${d.path}`}
                          text={note.summary.replace(/[*#_`]/g, "")}
                          label="Read summary"
                          className="mb-1.5"
                        />
                        <div className="whitespace-pre-wrap font-body text-[13px] leading-relaxed text-muted">
                          {note.summary}
                        </div>
                      </>
                    ) : (
                      <div className="font-body text-xs text-faint">
                        No summary yet — generate one below, or open the note for the transcript.
                      </div>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => void runAi("summary", d)}
                        disabled={aiBusy !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-outline px-2.5 py-1.5 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
                      >
                        {aiBusy === "summary" ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                        {note.summary ? "Redo summary" : "Make summary"}
                      </button>
                      <button
                        onClick={() => void runAi("tasks", d)}
                        disabled={aiBusy !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-outline px-2.5 py-1.5 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
                      >
                        {aiBusy === "tasks" ? <Spinner className="h-3.5 w-3.5" /> : <ListTodo className="h-3.5 w-3.5" />}
                        Find tasks
                      </button>
                    </div>
                    {note.raw && transcriptSpeakers(note.raw).length > 0 && (
                      <div className="mt-3">
                        <div className="mb-1.5 font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
                          Who is who
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {transcriptSpeakers(note.raw).map((sp) => (
                            <label key={sp} className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
                              {sp} →
                              <input
                                value={speakerNames[sp] ?? ""}
                                onChange={(e) =>
                                  setSpeakerNames((m) => ({ ...m, [sp]: e.target.value }))
                                }
                                placeholder="name"
                                className="w-24 rounded-lg border border-outline bg-bg px-2 py-1 font-body text-xs text-text outline-none focus:border-cyan"
                              />
                            </label>
                          ))}
                          <button
                            onClick={() => {
                              setAiBusy("names");
                              aiNameSpeakers(note.raw!)
                                .then((names) => {
                                  if (Object.keys(names).length === 0) {
                                    notify.info("Couldn't work out any names from the transcript.");
                                  }
                                  // Fill the inputs (hand-typed values win) — review, then Apply.
                                  setSpeakerNames((m) => ({ ...names, ...m }));
                                })
                                .catch((e) => notify.error(String(e)))
                                .finally(() => setAiBusy(null));
                            }}
                            disabled={aiBusy !== null}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-outline px-2.5 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
                          >
                            {aiBusy === "names" ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                            Guess names
                          </button>
                          <button
                            onClick={() => {
                              const next = renameSpeakers(note.raw!, speakerNames);
                              if (next === note.raw) return;
                              saveNote(d, next)
                                .then(() => {
                                  setSpeakerNames({});
                                  notify.success("Speakers renamed.");
                                })
                                .catch((e) => notify.error(String(e)));
                            }}
                            disabled={!Object.values(speakerNames).some((v) => v.trim())}
                            className="rounded-lg border border-outline px-2.5 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    )}
                    {note.actions.length > 0 &&
                      (() => {
                        const mine = myActions(note.actions);
                        const shown = showAllTasks ? note.actions : mine;
                        const hidden = note.actions.length - mine.length;
                        return (
                          <div className="mt-3">
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
                                {showAllTasks ? "All tasks" : "Tasks for me"}
                              </span>
                              <span className="flex items-center gap-3">
                                {hidden > 0 && (
                                  <button
                                    onClick={() => setShowAllTasks((v) => !v)}
                                    className="font-body text-xs text-faint hover:text-text"
                                  >
                                    {showAllTasks ? "just mine" : `+${hidden} for others`}
                                  </button>
                                )}
                                {shown.length > 0 && (
                                  <button
                                    onClick={() => {
                                      shown.forEach(addTodo);
                                      notify.success(`${shown.length} added to the to-do list`);
                                    }}
                                    className="font-body text-xs text-cyan hover:underline"
                                  >
                                    Add all to to-do
                                  </button>
                                )}
                              </span>
                            </div>
                            {shown.length === 0 && (
                              <div className="font-body text-xs text-faint">
                                Nothing assigned to you in this meeting.
                              </div>
                            )}
                            {shown.map((a, i) => (
                              <div key={i} className="flex items-center gap-2 py-1">
                                <button
                                  onClick={() => {
                                    addTodo(a);
                                    notify.success("Added to to-do");
                                  }}
                                  title="Add to to-do"
                                  className="shrink-0 text-faint transition-colors hover:text-cyan"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                                <span className="font-body text-[13px] text-text">{a}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </Card>
      )}
    </div>
  );
}
