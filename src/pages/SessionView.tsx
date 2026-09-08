import {
  ArrowLeft,
  Brain,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Play,
  Terminal,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Page } from "../components/Layout";
import { Badge, Button, Card, cn, EmptyState, ErrorState, Loading } from "../components/ui";
import { api, isSnapshot } from "../api";
import { withToast } from "../lib/toast";
import { getSettings, useSettings } from "../lib/settings";
import { useAsync } from "../lib/useAsync";
import { formatCompact, formatDateTime, modelColor, prettyModel } from "../lib/format";
import { tokenTotal, type Message, type ToolCall } from "../types";

export default function SessionView() {
  const { projectId = "", sessionId = "" } = useParams();
  const navigate = useNavigate();
  const actingMode = useSettings().actingMode;
  const [showThinking, setShowThinking] = useState(true);
  const { data, error, loading, reload } = useAsync(
    () => api.getSession(projectId, sessionId),
    [projectId, sessionId]
  );

  const [params] = useSearchParams();
  const anchor = params.get("msg");

  useEffect(() => {
    if (!anchor || !data) return;
    // Rendered rows carry id={`msg-${uuid}`}; scroll once the list exists.
    const el = document.getElementById(`msg-${anchor}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-cyan");
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-cyan"), 2400);
    return () => {
      clearTimeout(t);
      el.classList.remove("ring-2", "ring-cyan");
    };
  }, [anchor, data]);

  if (loading) return <Loading label="Loading transcript…" />;
  if (error) return <ErrorState message={error} onRetry={isSnapshot() ? undefined : reload} />;
  if (!data) return null;

  const { summary, messages } = data;

  return (
    <Page
      wide
      title={
        <span className="flex items-center gap-2">
          <Link
            to={`/projects/${projectId}`}
            className="text-faint transition-colors hover:text-fg"
            title="Back to project"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          {summary.title || summary.firstPrompt || "Session"}
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>{formatDateTime(summary.startTime)}</span>
          <span>·</span>
          <span>{summary.messageCount} messages</span>
          <span>·</span>
          <span>{formatCompact(tokenTotal(summary.tokens))} tokens</span>
          {summary.tool === "codex" && <Badge color="#10a37f">Codex</Badge>}
          {summary.tool === "antigravity" && <Badge color="#4285f4">Antigravity</Badge>}
          {summary.models.map((m) => (
            <Badge key={m} color={modelColor(m)}>
              {prettyModel(m)}
            </Badge>
          ))}
        </span>
      }
      actions={
        <>
          {actingMode && (
            <Button
              variant="subtle"
              onClick={async () => {
                const r = await withToast(
                  api.agentSpawn({
                    bin: getSettings().claudeBin || "claude",
                    resume: { projectId, sessionId },
                    // Codepoint-safe: a split surrogate breaks the JSON spawn body.
                    title: Array.from(summary.title || summary.firstPrompt || "Session")
                      .slice(0, 48)
                      .join(""),
                  }),
                  { error: "Couldn't start agent session" }
                );
                if (r) navigate(`/agents?attach=${r.id}`);
              }}
              title="Resume this conversation in an in-app agent session"
            >
              <Play className="h-4 w-4" /> Resume
            </Button>
          )}
          <Button
            variant="subtle"
            onClick={() =>
              withToast(api.revealSession(projectId, sessionId), {
                error: "Couldn't reveal file",
              })
            }
          >
            <FolderOpen className="h-4 w-4" /> Reveal file
          </Button>
          <button
            onClick={() => setShowThinking((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
              (showThinking
                ? "border-cyan/40 bg-accent-soft text-cyan"
                : "border-outline bg-surface-2 text-muted hover:text-text")
            }
          >
            <Brain className="h-4 w-4" /> Thinking
          </button>
        </>
      }
    >
      <div className="mx-auto max-w-3xl space-y-3">
        {messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No messages to show"
            hint="This transcript has no displayable messages."
          />
        ) : (
          messages.map((m, i) => (
            <div key={m.uuid ?? i} id={m.uuid ? `msg-${m.uuid}` : undefined}>
              <MessageRow message={m} showThinking={showThinking} />
            </div>
          ))
        )}
      </div>
    </Page>
  );
}

function MessageRow({ message, showThinking }: { message: Message; showThinking: boolean }) {
  const role = message.role;
  const isUser = role === "user";
  const isSystem = role === "system";

  if (isSystem) {
    return (
      <div className="py-1 text-center text-xs text-faint selectable">{message.text}</div>
    );
  }

  return (
    <Card className={cn("animate-fade p-0", isUser && "border-l-2 border-l-cyan")}>
      <div className="flex items-center justify-between border-b border-outline px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-[10px] border border-outline"
            style={{
              backgroundColor: isUser ? "rgba(0,245,255,0.14)" : "#1a1a24",
              color: isUser ? "#00f5ff" : "#ececf4",
            }}
          >
            {isUser ? <User className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
          </span>
          <span
            className="font-display text-xs font-semibold uppercase tracking-[0.5px]"
            style={{ color: isUser ? "#00f5ff" : "#ececf4" }}
          >
            {isUser ? "You" : "Claude"}
          </span>
          {message.model && (
            <Badge color={modelColor(message.model)}>{prettyModel(message.model)}</Badge>
          )}
          {message.isSidechain && <Badge color="#00f5ff">subagent</Badge>}
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] text-faint">
          {message.tokens && <span>{formatCompact(tokenTotal(message.tokens))} tok</span>}
          <span>{message.timestamp ? formatDateTime(message.timestamp) : ""}</span>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        {showThinking && message.thinking && (
          <details
            className="group rounded-[10px] border"
            style={{ borderColor: "rgba(192,0,255,0.28)", background: "rgba(192,0,255,0.06)" }}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11.5px] font-semibold tracking-[0.3px] text-violet">
              <Brain className="h-3.5 w-3.5" />
              Thinking
              <span className="flex-1" />
              <ChevronRight className="h-3.5 w-3.5 opacity-80 transition-transform group-open:rotate-90" />
            </summary>
            <div className="selectable whitespace-pre-wrap break-words px-3 pb-3 pl-9 text-[13px] italic leading-relaxed text-muted">
              {message.thinking}
            </div>
          </details>
        )}

        {message.text && (
          <div className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
            {message.text}
          </div>
        )}

        {message.toolCalls.map((t, i) => (
          <ToolChip key={i} tool={t} />
        ))}
      </div>
    </Card>
  );
}

function ToolChip({ tool }: { tool: ToolCall }) {
  return (
    <details className="group rounded-[10px] border border-outline bg-bg">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-xs hover:bg-surface-2">
        <ChevronRight className="h-3.5 w-3.5 text-faint transition-transform group-open:rotate-90" />
        <Terminal className="h-3.5 w-3.5 text-muted" />
        <span className="text-cyan">{tool.name}</span>
      </summary>
      <pre className="selectable overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] leading-relaxed text-muted">
        {tool.inputPreview}
      </pre>
    </details>
  );
}
