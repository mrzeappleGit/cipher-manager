import { CalendarDays, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page } from "../components/Layout";
import { Card, EmptyState, ErrorState, Loading, SectionTitle, Spinner } from "../components/ui";
import { api } from "../api";
import { isProviderReady, summarizeDay } from "../lib/ai";
import { getCachedSummary, getSettings, setCachedSummary, useSettings } from "../lib/settings";
import { notifyDesktop } from "../lib/notify";
import { SpeakButton } from "../components/SpeakButton";
import { useAsync } from "../lib/useAsync";
import { formatCompact, formatDay, formatRelative } from "../lib/format";
import { notify } from "../lib/toast";
import { tokenTotal, type DayRecap } from "../types";

interface BatchState {
  running: boolean;
  done: number;
  total: number;
}

export default function Daily() {
  const { data, error, loading, reload } = useAsync(() => api.getDailyRecaps(), []);
  const settings = useSettings();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [batch, setBatch] = useState<BatchState>({ running: false, done: 0, total: 0 });

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const r of data) {
      const cached = getCachedSummary(r.day);
      if (cached) next[r.day] = cached;
    }
    // Merge so an in-memory summary that failed to persist isn't dropped.
    setSummaries((s) => ({ ...s, ...next }));
  }, [data]);

  const canSummarize = isProviderReady(settings);

  async function generate(recap: DayRecap) {
    const text = await summarizeDay(recap);
    setCachedSummary(recap.day, text);
    setSummaries((s) => ({ ...s, [recap.day]: text }));
  }

  async function summarizeOne(recap: DayRecap) {
    setBusy((b) => ({ ...b, [recap.day]: true }));
    try {
      await generate(recap);
    } catch (e) {
      notify.error(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy((b) => ({ ...b, [recap.day]: false }));
    }
  }

  async function summarizeAll() {
    if (!data) return;
    const pending = data.filter((r) => !summaries[r.day]);
    if (!pending.length) return;
    setBatch({ running: true, done: 0, total: pending.length });
    let failures = 0;
    for (let i = 0; i < pending.length; i++) {
      try {
        await generate(pending[i]);
      } catch {
        failures++;
      }
      setBatch((b) => ({ ...b, done: i + 1 }));
    }
    setBatch({ running: false, done: 0, total: 0 });
    if (failures) {
      notify.error(`${failures} of ${pending.length} day summaries failed`);
    } else {
      notify.success(`Summarized ${pending.length} day${pending.length === 1 ? "" : "s"}`);
    }
    if (getSettings().notifications && document.hidden) {
      notifyDesktop("cipherManager", `Summarized ${pending.length - failures} of ${pending.length} days.`);
    }
  }

  if (loading) return <Loading label="Building recaps…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const pendingCount = data.filter((r) => !summaries[r.day]).length;

  return (
    <Page
      title="Daily recaps"
      subtitle="What you worked on each day, across every project"
      actions={
        canSummarize && data.length > 0 ? (
          <button
            onClick={summarizeAll}
            disabled={batch.running || pendingCount === 0}
            style={{ background: "linear-gradient(135deg,#c000ff,#ff0055)", boxShadow: "var(--glow-violet)" }}
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-bold text-[#05060a] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {batch.running ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            {batch.running
              ? `Summarizing ${batch.done}/${batch.total}…`
              : pendingCount
                ? `Summarize all (${pendingCount})`
                : "All summarized"}
          </button>
        ) : undefined
      }
    >
      {data.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No activity yet"
          hint="Once you use Claude Code, your daily recaps will appear here."
        />
      ) : (
        <div className="space-y-4">
          {data.map((recap) => (
            <Card key={recap.day} className="p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-accent-2" />
                  <h2 className="text-base font-semibold text-fg">{formatDay(recap.day)}</h2>
                  <span className="text-xs text-faint">
                    {formatRelative(`${recap.day}T12:00:00Z`)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted">
                  <span>{recap.projects.length} projects</span>
                  <span>{recap.sessionCount} sessions</span>
                  <span>{recap.messageCount} messages</span>
                  <span className="text-accent-2">
                    {formatCompact(tokenTotal(recap.tokens))} tokens
                  </span>
                </div>
              </div>

              {/* AI summary */}
              <div className="mt-3">
                {summaries[recap.day] ? (
                  <div
                    className="flex gap-2 rounded-[10px] border px-3.5 py-2.5 text-sm leading-relaxed text-text"
                    style={{ borderColor: "rgba(192,0,255,0.22)", background: "rgba(192,0,255,0.06)" }}
                  >
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet" />
                    <div className="min-w-0 flex-1">
                      <p className="selectable">{summaries[recap.day]}</p>
                      <div className="mt-1.5 flex items-center gap-4">
                        <SpeakButton id={`day-${recap.day}`} text={summaries[recap.day]} />
                        {canSummarize && (
                        <button
                          onClick={() => summarizeOne(recap)}
                          disabled={busy[recap.day] || batch.running}
                          className="inline-flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-violet disabled:opacity-50"
                        >
                          {busy[recap.day] ? (
                            <Spinner className="h-3 w-3" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          Regenerate
                        </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : canSummarize ? (
                  <button
                    onClick={() => summarizeOne(recap)}
                    disabled={busy[recap.day] || batch.running}
                    style={{ background: "linear-gradient(135deg,#c000ff,#ff0055)", boxShadow: "var(--glow-violet)" }}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-[#05060a] transition-all hover:brightness-110 disabled:opacity-60"
                  >
                    {busy[recap.day] ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {busy[recap.day] ? "Summarizing…" : "Summarize this day with AI"}
                  </button>
                ) : (
                  <div className="text-xs text-faint">
                    <Link to="/settings" className="text-violet hover:underline">
                      Set up an AI provider
                    </Link>{" "}
                    in Settings to generate summaries.
                  </div>
                )}
              </div>

              {/* Per-project breakdown */}
              <div className="mt-4 space-y-3">
                {recap.projects.map((p) => (
                  <div key={p.id}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-medium text-fg">{p.name}</span>
                      <span className="text-[11px] text-faint">
                        {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"} ·{" "}
                        {formatCompact(tokenTotal(p.tokens))} tokens
                      </span>
                    </div>
                    <div className="space-y-1 border-l border-line pl-3">
                      {p.sessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => navigate(`/projects/${p.id}/sessions/${s.id}`)}
                          className="group flex w-full items-center gap-1.5 text-left text-sm text-muted transition-colors hover:text-accent-2"
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                          <span className="truncate">
                            {s.title || s.firstPrompt || "Untitled session"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}

          {!canSummarize && (
            <Card className="p-4">
              <SectionTitle>Tip</SectionTitle>
              <p className="text-sm text-muted">
                Want written summaries of each day? Choose an AI provider (Anthropic, OpenAI, Gemini,
                or any OpenAI-compatible / local endpoint) in{" "}
                <Link to="/settings" className="text-violet hover:underline">
                  Settings
                </Link>
                . Keys are stored locally and only used when you summarize.
              </p>
            </Card>
          )}
        </div>
      )}
    </Page>
  );
}
