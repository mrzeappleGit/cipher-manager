import { CheckCircle2, FolderOpen, Square, TerminalSquare, XCircle, X } from "lucide-react";
import { api } from "../api";
import { cancelJob, closeJobs, selectJob, useJobs } from "../lib/jobs";
import { withToast } from "../lib/toast";
import { useAsync } from "../lib/useAsync";
import { formatRelative } from "../lib/format";
import { cn, Spinner } from "./ui";
import type { AuditEntry, Job, JobStatus } from "../types";

/** A unified row for the list — live job or persisted audit entry. */
interface Row {
  id: string;
  label: string;
  status: JobStatus;
  startedAt: string;
  live: boolean;
}

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "running") return <Spinner className="h-3.5 w-3.5 text-cyan" />;
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-cyan" />;
  if (status === "canceled") return <Square className="h-3.5 w-3.5 text-muted" />;
  return <XCircle className="h-3.5 w-3.5 text-error" />;
}

function statusLabel(status: JobStatus, exitCode: number | null): string {
  if (status === "running") return "running…";
  if (status === "canceled") return "canceled";
  if (status === "failed") return `failed${exitCode != null ? ` (exit ${exitCode})` : ""}`;
  return "done";
}

export function JobsPanel() {
  const { jobs, history, open, selected } = useJobs();
  const { data: info } = useAsync(() => api.getAppInfo(), []);

  const liveIds = new Set(jobs.map((j) => j.id));
  const rows: Row[] = [
    ...jobs.map((j) => ({ id: j.id, label: j.label, status: j.status, startedAt: j.startedAt, live: true })),
    ...history
      .filter((h) => !liveIds.has(h.id))
      .map((h) => ({ id: h.id, label: h.label, status: h.status, startedAt: h.startedAt, live: false })),
  ];

  if (!open) return null;

  const liveJob: Job | undefined = jobs.find((j) => j.id === selected);
  const histEntry: AuditEntry | undefined = history.find((h) => h.id === selected);
  const active = liveJob ?? rows[0] ?? null;
  const activeLive = jobs.find((j) => j.id === (active?.id ?? ""));
  const activeStatus: JobStatus | null = activeLive?.status ?? histEntry?.status ?? active?.status ?? null;
  const activeExit = activeLive?.exitCode ?? histEntry?.exitCode ?? null;
  const activeCwd = activeLive?.cwd ?? histEntry?.cwd ?? null;
  const output =
    activeLive?.output ??
    (histEntry
      ? `$ ${histEntry.bin} -p …${histEntry.args ? ` ${histEntry.args}` : ""}\n\n${histEntry.outputExcerpt}`
      : "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={closeJobs}
    >
      <div
        className="flex h-[80vh] w-full max-w-4xl overflow-hidden rounded-[16px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Job list */}
        <div className="flex w-36 shrink-0 flex-col border-r border-outline sm:w-60">
          <div className="flex items-center gap-2 border-b border-outline px-4 py-3.5">
            <TerminalSquare className="h-4 w-4 text-cyan" />
            <span className="font-display text-sm font-bold text-text">Jobs</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {rows.length === 0 ? (
              <div className="px-2 py-4 font-body text-xs text-muted">No runs yet.</div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => selectJob(r.id)}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors",
                    active?.id === r.id ? "bg-surface-3" : "hover:bg-surface-3/60"
                  )}
                >
                  <StatusIcon status={r.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-body text-[13px] font-semibold text-text">
                      {r.label}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-faint">
                      {formatRelative(r.startedAt)}
                      {!r.live && " · logged"}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          {info?.auditPath && (
            <button
              onClick={() =>
                withToast(api.revealPath(info.auditPath!), { error: "Couldn't open the audit log" })
              }
              className="flex items-center gap-2 border-t border-outline px-4 py-2.5 font-mono text-[11px] text-muted transition-colors hover:text-cyan"
              title={info.auditPath}
            >
              <FolderOpen className="h-3.5 w-3.5" /> Audit log
            </button>
          )}
        </div>

        {/* Output */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-outline px-5 py-3.5">
            {activeStatus && <StatusIcon status={activeStatus} />}
            <span className="flex-1 truncate font-mono text-sm text-text">
              {active ? active.label : "—"}
            </span>
            {activeStatus && (
              <span
                className={cn(
                  "font-mono text-[11px]",
                  activeStatus === "running" && "text-cyan",
                  activeStatus === "failed" && "text-error",
                  (activeStatus === "done" || activeStatus === "canceled") && "text-muted"
                )}
              >
                {statusLabel(activeStatus, activeExit)}
              </span>
            )}
            {activeLive?.status === "running" && (
              <button
                onClick={() => cancelJob(activeLive.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-error/40 bg-error/10 px-2.5 py-1 font-body text-xs font-semibold text-error transition-colors hover:bg-error/20"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
            )}
            <button
              onClick={closeJobs}
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-1 hover:text-cyan"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="selectable flex-1 overflow-y-auto bg-bg px-5 py-4">
            {active ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-text">
                {output || (activeStatus === "running" ? "Starting…" : "(no output)")}
              </pre>
            ) : (
              <div className="font-body text-sm text-muted">Select a job to see its output.</div>
            )}
          </div>
          {activeCwd && (
            <div className="border-t border-outline px-5 py-2 font-mono text-[11px] text-faint">
              cwd: {activeCwd}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
