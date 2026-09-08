import { FileText, Sparkles, Terminal, User, WandSparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Page } from "../components/Layout";
import { Card, ErrorState, Loading } from "../components/ui";
import { SpeakButton } from "../components/SpeakButton";
import { MicButton } from "../components/MicButton";
import { api } from "../api";
import { answerWithContext, isProviderReady } from "../lib/ai";
import { useSettings } from "../lib/settings";
import { providerKeyRef } from "../lib/secrets";
import { formatRelative } from "../lib/format";
import type { SearchResult, VaultHit } from "../types";

const STOP = new Set(
  "the a an and or of to in on for with how did do i my me is was are what when where why that this it we you can get set up over about into from your".split(
    " "
  )
);

function keywords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(
    0,
    6
  );
}

export default function AskPage() {
  const settings = useSettings();
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<SearchResult[] | null>(null);
  const [vaultHits, setVaultHits] = useState<VaultHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canAI = isProviderReady(settings);

  async function ask() {
    const q = question.trim();
    if (q.length < 3 || running) return;
    setRunning(true);
    setError(null);
    setAnswer(null);
    setSources(null);
    setVaultHits(null);
    try {
      const terms = keywords(q);
      const vaultDir = settings.vaultDir.trim();
      // Vault recall runs beside the transcript search: semantic when an
      // embeddings endpoint is configured, keyword otherwise. Vault failures
      // (endpoint down, first index still building) don't sink the answer.
      const embUrl = settings.embeddingsUrl.trim();
      const embModel = settings.embeddingsModel.trim() || "nomic-embed-text";
      const embKey = providerKeyRef(settings.provider, settings.apiKeys[settings.provider] ?? "");
      const [keyword, semantic, vault] = await Promise.all([
        api.searchAny(terms.length ? terms : [q], 12),
        // Semantic pass over session digests — finds transcripts that never
        // use the question's literal words. Best-effort beside the keyword hits.
        embUrl
          ? api.semanticSearchSessions(embUrl, embKey, embModel, q, 6).catch(() => [])
          : Promise.resolve([] as SearchResult[]),
        !vaultDir
          ? Promise.resolve<VaultHit[]>([])
          : (embUrl
              ? api.semanticSearch(vaultDir, embUrl, embKey, embModel, q, 6)
              : api.searchVault(vaultDir, terms.length ? terms : [q], 6)
            ).catch((e) => {
              setError(`Vault recall failed: ${String((e as Error).message ?? e)}`);
              return [] as VaultHit[];
            }),
      ]);
      // Keyword hits first (exact matches), then semantic ones from sessions
      // not already covered.
      const seen = new Set(keyword.map((r) => r.sessionId));
      const results = [...keyword, ...semantic.filter((r) => !seen.has(r.sessionId))].slice(0, 14);
      setSources(results);
      setVaultHits(vault);
      if (canAI && (results.length || vault.length)) {
        const a = await answerWithContext(q, [
          ...vault.map((v) => ({
            projectName: "vault",
            sessionTitle: v.name,
            snippet: v.snippet,
          })),
          ...results.map((r) => ({
            projectName: r.projectName,
            sessionTitle: r.sessionTitle,
            snippet: r.snippet,
          })),
        ]);
        setAnswer(a);
      }
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Page
      title="Ask your history"
      subtitle="Ask a question and get an answer grounded in your own transcripts"
    >
      <div className="relative mb-5 flex items-center gap-2">
        <div className="relative flex-1">
          <WandSparkles className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-cyan" />
          <input
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="e.g. how did I set up the VPS deploy?"
            className="h-14 w-full rounded-[14px] border border-outline bg-bg pl-12 pr-28 font-body text-base text-text outline-none placeholder:text-faint focus:border-cyan"
          />
          <button
            onClick={ask}
            disabled={running || question.trim().length < 3}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full px-4 py-2 font-body text-sm font-bold text-[#05060a] transition-all hover:brightness-110 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg,#00f5ff,#c000ff)", boxShadow: "var(--glow-cyan)" }}
          >
            Ask
          </button>
        </div>
        <MicButton onText={(t) => setQuestion((q) => (q.trim() ? `${q.trim()} ${t}` : t))} />
      </div>

      {!canAI && (
        <div className="mb-4 rounded-[10px] border border-outline bg-surface-2 px-3.5 py-2.5 text-xs text-muted">
          No AI provider configured — you'll still see matching transcript excerpts below. Add a
          provider in Settings for synthesized answers.
        </div>
      )}

      {running && <Loading label="Searching your history…" />}
      {error && !(sources && sources.length) && <ErrorState message={error} />}
      {error && sources && sources.length > 0 && (
        <div className="mb-4 rounded-[10px] border border-error/30 bg-error/10 px-3.5 py-2.5 text-xs text-error">
          Couldn't generate an answer: {error}. Showing matching excerpts below.
        </div>
      )}

      {!running && answer && (
        <Card className="mb-5 p-5" >
          <div
            className="flex gap-2.5 rounded-[10px] border px-4 py-3.5"
            style={{ borderColor: "rgba(192,0,255,0.22)", background: "rgba(192,0,255,0.06)" }}
          >
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet" />
            <div className="min-w-0 flex-1">
              <p className="selectable whitespace-pre-wrap font-body text-sm leading-relaxed text-text">
                {answer}
              </p>
              <div className="mt-2">
                <SpeakButton id="ask-answer" text={answer} />
              </div>
            </div>
          </div>
        </Card>
      )}

      {!running && vaultHits && vaultHits.length > 0 && (
        <>
          <div className="mb-3 font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
            From your vault
          </div>
          <div className="mb-5 space-y-2">
            {vaultHits.map((v, i) => (
              <button
                key={v.rel}
                onClick={() =>
                  void api
                    .openUrl(
                      `obsidian://open?path=${encodeURIComponent(
                        `${settings.vaultDir.trim().replace(/[/\\]+$/, "")}/${v.rel}`
                      )}`
                    )
                    .catch(() => {})
                }
                className="block w-full rounded-[12px] border border-outline bg-surface-2 p-3.5 text-left transition-colors hover:border-outline-2 hover:bg-surface-3"
              >
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-faint">[{i + 1}]</span>
                  <FileText className="h-3.5 w-3.5 text-violet" />
                  <span className="text-violet">{v.name}</span>
                  <span className="ml-auto shrink-0 truncate text-faint">{v.rel}</span>
                </div>
                <div className="selectable font-body text-[13px] leading-relaxed text-muted">
                  {v.snippet}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {!running && sources && sources.length > 0 && (
        <>
          <div className="mb-3 font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
            {sources.length} transcript source{sources.length === 1 ? "" : "s"}
          </div>
          <div className="space-y-2">
            {sources.map((r, i) => (
              <button
                key={i}
                onClick={() =>
                  navigate(
                    `/projects/${r.projectId}/sessions/${r.sessionId}${
                      r.messageUuid ? `?msg=${r.messageUuid}` : ""
                    }`
                  )
                }
                className="block w-full rounded-[12px] border border-outline bg-surface-2 p-3.5 text-left transition-colors hover:border-outline-2 hover:bg-surface-3"
              >
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-faint">[{(vaultHits?.length ?? 0) + i + 1}]</span>
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{
                      background: r.role === "user" ? "rgba(0,245,255,0.14)" : "#1a1a24",
                      color: r.role === "user" ? "#00f5ff" : "#ececf4",
                    }}
                  >
                    {r.role === "user" ? <User className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
                  </span>
                  <span className="text-cyan">{r.projectName}</span>
                  {r.chunkKind && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{
                        background: r.chunkKind === "outcome" ? "rgba(0,245,255,0.12)" : "rgba(192,0,255,0.12)",
                        color: r.chunkKind === "outcome" ? "#00f5ff" : "#c000ff",
                      }}
                    >
                      {r.chunkKind}
                    </span>
                  )}
                  {r.sessionTitle && (
                    <>
                      <span className="text-faint">/</span>
                      <span className="truncate text-muted">{r.sessionTitle}</span>
                    </>
                  )}
                  <span className="ml-auto shrink-0 text-faint">{formatRelative(r.timestamp)}</span>
                </div>
                <div className="selectable font-body text-[13px] leading-relaxed text-muted">
                  {r.snippet}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {!running && sources && sources.length === 0 && (vaultHits?.length ?? 0) === 0 && (
        <div className="py-16 text-center">
          <div className="font-body text-sm text-text">No matching transcripts or vault notes.</div>
          <div className="mt-1 font-body text-xs text-muted">Try different keywords.</div>
        </div>
      )}
    </Page>
  );
}
