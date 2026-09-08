import {
  ArrowLeft,
  Code2,
  FolderOpen,
  GitBranch,
  Github,
  MessageSquare,
  MessageSquarePlus,
  Network,
  Play,
  Terminal,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page } from "../components/Layout";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
} from "../components/ui";
import { api } from "../api";
import { withToast } from "../lib/toast";
import { getSettings, useSettings } from "../lib/settings";
import { useAsync } from "../lib/useAsync";
import { formatBytes, formatCompact, formatRelative, modelColor, prettyModel } from "../lib/format";
import { tokenTotal } from "../types";

export default function ProjectDetail() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const actingMode = useSettings().actingMode;

  // Spawn an in-app agent session (hosted by serve) and jump to its terminal.
  async function spawnAndAttach(params: Parameters<typeof api.agentSpawn>[0]) {
    const r = await withToast(api.agentSpawn(params), {
      error: "Couldn't start agent session",
    });
    if (r) navigate(`/agents?attach=${r.id}`);
  }
  const { data, error, loading, reload } = useAsync(async () => {
    const [projects, sessions] = await Promise.all([
      api.listProjects(),
      api.listSessions(projectId),
    ]);
    return { project: projects.find((p) => p.id === projectId) ?? null, sessions };
  }, [projectId]);

  if (loading) return <Loading label="Loading project…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const { project, sessions } = data;
  const name = project?.name ?? "Unknown project";
  const path = project?.path ?? projectId;

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link
            to="/projects"
            className="text-faint transition-colors hover:text-fg"
            title="Back to projects"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          {name}
        </span>
      }
      subtitle={<span className="font-mono text-xs">{path}</span>}
      actions={
        <>
          <Button
            variant="subtle"
            onClick={() => withToast(api.openPath(path), { error: "Couldn't open folder" })}
            disabled={!project?.pathExists}
          >
            <FolderOpen className="h-4 w-4" /> Folder
          </Button>
          <Button
            variant="subtle"
            onClick={() => withToast(api.openInEditor(path), { error: "Couldn't open editor" })}
            disabled={!project?.pathExists}
          >
            <Code2 className="h-4 w-4" /> Editor
          </Button>
          {actingMode ? (
            <Button
              variant="subtle"
              onClick={() =>
                spawnAndAttach({
                  bin: getSettings().claudeBin || "claude",
                  args: ["--continue"],
                  cwd: path,
                  title: name,
                })
              }
              disabled={!project?.pathExists}
              title="Resume the latest Claude Code conversation here, in-app"
            >
              <Terminal className="h-4 w-4" /> Resume
            </Button>
          ) : (
            <Button
              variant="subtle"
              onClick={() =>
                withToast(
                  api.openTerminal(path, `${getSettings().claudeBin || "claude"} --continue`),
                  { error: "Couldn't open terminal" }
                )
              }
              disabled={!project?.pathExists}
              title="Open a terminal here and resume the latest Claude Code session"
            >
              <Terminal className="h-4 w-4" /> Resume in terminal
            </Button>
          )}
          {actingMode && (
            <Button
              variant="subtle"
              onClick={() =>
                spawnAndAttach({
                  bin: getSettings().claudeBin || "claude",
                  cwd: path,
                  title: name,
                })
              }
              disabled={!project?.pathExists}
              title="Start a fresh Claude Code conversation here, in-app"
            >
              <MessageSquarePlus className="h-4 w-4" /> New chat
            </Button>
          )}
          {project?.gitUrl && (
            <Button
              variant="subtle"
              onClick={() =>
                withToast(api.openUrl(project.gitUrl!), { error: "Couldn't open URL" })
              }
              title={project.gitUrl}
            >
              <Github className="h-4 w-4" /> GitHub
            </Button>
          )}
        </>
      }
    >
      {!project && (
        <div className="mb-6 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
          Couldn't find project metadata for this id — it may have been removed or never recorded a
          session. Any transcripts found on disk are listed below.
        </div>
      )}

      {project && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Sessions" value={`${project.sessionCount}`} />
          <Stat label="Messages" value={formatCompact(project.messageCount)} />
          <Stat label="Tokens" value={formatCompact(tokenTotal(project.tokens))} accent />
          <Stat label="Size" value={formatBytes(project.sizeBytes)} />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Sessions
      </h2>

      {sessions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No sessions recorded"
          hint="This project folder has no transcript files yet."
        />
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Card
              key={s.id}
              hover
              onClick={() => navigate(`/projects/${projectId}/sessions/${s.id}`)}
              className="p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">
                    {s.title || s.firstPrompt || "Untitled session"}
                  </div>
                  {s.title && s.firstPrompt && (
                    <div className="mt-0.5 truncate text-xs text-faint">{s.firstPrompt}</div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                    <span>{formatRelative(s.startTime)}</span>
                    <span>·</span>
                    <span>{s.messageCount} messages</span>
                    {s.gitBranch && (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="h-3 w-3" />
                          {s.gitBranch}
                        </span>
                      </>
                    )}
                    {s.hasSubagents && (
                      <Badge color="#38bdf8">
                        <Network className="h-3 w-3" /> subagents
                      </Badge>
                    )}
                    {s.tool === "codex" && <Badge color="#10a37f">Codex</Badge>}
                    {s.tool === "antigravity" && <Badge color="#4285f4">Antigravity</Badge>}
                    {s.models.slice(0, 2).map((m) => (
                      <Badge key={m} color={modelColor(m)}>
                        {prettyModel(m)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-6 text-right">
                  {actingMode && (
                    <Button
                      variant="subtle"
                      onClick={(e) => {
                        e.stopPropagation();
                        spawnAndAttach({
                          bin: getSettings().claudeBin || "claude",
                          resume: { projectId, sessionId: s.id },
                          // Codepoint-safe: a split surrogate breaks the JSON spawn body.
                          title: Array.from(s.title || name).slice(0, 48).join(""),
                        });
                      }}
                      title="Resume this conversation in an in-app agent session"
                    >
                      <Play className="h-4 w-4" /> Resume
                    </Button>
                  )}
                  <div>
                    <div className="text-sm font-semibold text-accent-2">
                      {formatCompact(tokenTotal(s.tokens))}
                    </div>
                    <div className="text-[11px] text-faint">tokens</div>
                  </div>
                  <div className="w-16">
                    <div className="text-sm text-fg">{formatBytes(s.sizeBytes)}</div>
                    <div className="text-[11px] text-faint">size</div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={"mt-1 text-lg font-semibold " + (accent ? "text-accent-2" : "text-fg")}>
        {value}
      </div>
    </Card>
  );
}
