import {
  Archive,
  ChevronRight,
  HardDrive,
  Info,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Page } from "../components/Layout";
import {
  Badge,
  Bar,
  Button,
  Card,
  ErrorState,
  IconButton,
  Loading,
  Modal,
} from "../components/ui";
import { api } from "../api";
import { notify } from "../lib/toast";
import { useAsync } from "../lib/useAsync";
import { formatBytes, formatRelative } from "../lib/format";

interface PendingAction {
  type: "delete" | "archive";
  projectId: string;
  sessionId: string;
  title: string;
}

export default function Cleanup() {
  const { data, error, loading, reload } = useAsync(() => api.getDiskStats(), []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.type === "delete") {
        await api.deleteSession(pending.projectId, pending.sessionId);
        notify.success(`Deleted “${pending.title}”`);
      } else {
        await api.archiveSession(pending.projectId, pending.sessionId);
        notify.success(`Archived “${pending.title}”`);
      }
      setPending(null);
      reload();
    } catch (e) {
      notify.error(
        `Failed to ${pending.type}: ${String((e as { message?: string })?.message ?? e)}`
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="Measuring disk usage…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const maxSize = data.projects[0]?.sizeBytes ?? 1;

  return (
    <Page
      title="Cleanup"
      subtitle="Reclaim disk space from old Claude Code transcripts"
    >
      <Card className="mb-4 flex items-center gap-4 p-5">
        <div className="rounded-xl bg-accent-soft p-3 text-accent">
          <HardDrive className="h-6 w-6" />
        </div>
        <div>
          <div className="text-2xl font-semibold text-fg">{formatBytes(data.totalBytes)}</div>
          <div className="text-sm text-muted">
            across {data.projects.length} project folders in ~/.claude/projects
          </div>
        </div>
      </Card>

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 text-xs text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
        <span>
          This only affects Claude Code <strong>transcripts and logs</strong> — your actual
          project code is never touched. <strong>Archive</strong> moves a session to{" "}
          <span className="font-mono">~/.claude/cipher-archive</span>; <strong>Delete</strong>{" "}
          removes it permanently.
        </span>
      </div>

      <div className="space-y-2">
        {data.projects.map((p) => {
          const open = expanded === p.id;
          return (
            <Card key={p.id} className="overflow-hidden">
              <button
                onClick={() => setExpanded(open ? null : p.id)}
                className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-panel-2"
              >
                <ChevronRight
                  className={
                    "h-4 w-4 shrink-0 text-faint transition-transform " +
                    (open ? "rotate-90" : "")
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-fg">{p.name}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted">
                      {formatBytes(p.sizeBytes)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <Bar value={p.sizeBytes} max={maxSize} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
                    <span>{p.sessionCount} sessions</span>
                    <span>·</span>
                    <span>active {formatRelative(p.lastActivity)}</span>
                  </div>
                </div>
              </button>

              {open && (
                <div className="border-t border-line bg-ink-2 px-4 py-2">
                  {p.sessions.length === 0 ? (
                    <div className="py-3 text-center text-xs text-faint">
                      No session files.
                    </div>
                  ) : (
                    p.sessions.map((s) => (
                      <div
                        key={s.id}
                        className="group flex items-center gap-3 border-b border-line/50 py-2 last:border-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-fg">
                            {s.title || <span className="font-mono text-xs">{s.id}</span>}
                          </div>
                          <div className="text-[11px] text-faint">
                            {formatRelative(s.lastActivity)}
                          </div>
                        </div>
                        <Badge>{formatBytes(s.sizeBytes)}</Badge>
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <IconButton
                            title="Archive session"
                            onClick={() =>
                              setPending({
                                type: "archive",
                                projectId: p.id,
                                sessionId: s.id,
                                title: s.title || s.id,
                              })
                            }
                          >
                            <Archive className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            title="Delete session"
                            className="hover:bg-bad/15 hover:text-bad"
                            onClick={() =>
                              setPending({
                                type: "delete",
                                projectId: p.id,
                                sessionId: s.id,
                                title: s.title || s.id,
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Modal
        open={!!pending}
        danger={pending?.type === "delete"}
        title={pending?.type === "delete" ? "Delete session?" : "Archive session?"}
        onClose={() => !busy && setPending(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={pending?.type === "delete" ? "danger" : "primary"}
              onClick={confirm}
              disabled={busy}
            >
              {busy ? "Working…" : pending?.type === "delete" ? "Delete permanently" : "Archive"}
            </Button>
          </>
        }
      >
        {pending?.type === "delete" ? (
          <>
            Permanently delete the transcript for{" "}
            <span className="font-medium text-fg">“{pending?.title}”</span> and any subagent
            logs? This cannot be undone.
          </>
        ) : (
          <>
            Move the transcript for{" "}
            <span className="font-medium text-fg">“{pending?.title}”</span> to the archive
            folder? You can restore it later from{" "}
            <span className="font-mono text-xs">~/.claude/cipher-archive</span>.
          </>
        )}
      </Modal>
    </Page>
  );
}
