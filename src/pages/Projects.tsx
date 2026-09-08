import {
  FolderOpen,
  FolderPlus,
  Code2,
  Github,
  LayoutGrid,
  LayoutList,
  MessageSquarePlus,
  Search as SearchIcon,
  AlertCircle,
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Page } from "../components/Layout";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  Loading,
  Modal,
} from "../components/ui";
import { api } from "../api";
import { withToast } from "../lib/toast";
import { getSettings, setSettings, useSettings } from "../lib/settings";
import { useAsync } from "../lib/useAsync";
import { formatBytes, formatCompact, formatRelative, modelColor, prettyModel } from "../lib/format";
import { tokenTotal } from "../types";
import type { ProjectSummary } from "../types";

type SortKey = "recent" | "tokens" | "size" | "sessions" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "tokens", label: "Tokens" },
  { key: "size", label: "Size" },
  { key: "sessions", label: "Sessions" },
  { key: "name", label: "Name" },
];

function sortProjects(list: ProjectSummary[], key: SortKey): ProjectSummary[] {
  const arr = [...list];
  switch (key) {
    case "tokens":
      return arr.sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
    case "size":
      return arr.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case "sessions":
      return arr.sort((a, b) => b.sessionCount - a.sessionCount);
    case "name":
      return arr.sort((a, b) => a.name.localeCompare(b.name));
    case "recent":
    default:
      return arr.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  }
}

const LAST_PARENT_KEY = "cipher-manager.lastProjectParent";

export default function Projects() {
  const { data, error, loading, reload } = useAsync(() => api.listProjects(), []);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const { projectsLayout: layout, actingMode } = useSettings();
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? data.filter(
          (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
        )
      : data;
    return sortProjects(matched, sort);
  }, [data, query, sort]);

  if (loading) return <Loading label="Loading projects…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <Page
      title="Projects"
      subtitle={`${data?.length ?? 0} project folders in ~/.claude/projects`}
      actions={
        <div className="flex items-center gap-2">
          {actingMode && (
            <Button
              variant="subtle"
              onClick={() => setNewProjectOpen(true)}
              title="Create a folder and open a Claude Code conversation in it"
            >
              <FolderPlus className="h-4 w-4" /> New project
            </Button>
          )}
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-1">
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                  (sort === s.key
                    ? "bg-accent text-white"
                    : "text-muted hover:text-fg")
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-1">
            {(
              [
                { key: "list", Icon: LayoutList, label: "List" },
                { key: "grid", Icon: LayoutGrid, label: "Grid" },
              ] as const
            ).map(({ key, Icon, label }) => (
              <button
                key={key}
                title={label}
                onClick={() => setSettings({ projectsLayout: key })}
                className={
                  "rounded-md p-1.5 transition-colors " +
                  (layout === key ? "bg-accent text-white" : "text-muted hover:text-fg")
                }
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="relative mb-4">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects by name or path…"
          className="w-full rounded-lg border border-line bg-panel py-2.5 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title="No matching projects"
          hint="Try a different filter."
        />
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <ProjectGridCard key={p.id} p={p} onOpen={() => navigate(`/projects/${p.id}`)} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <ProjectRow key={p.id} p={p} onOpen={() => navigate(`/projects/${p.id}`)} />
          ))}
        </div>
      )}

      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </Page>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(() => localStorage.getItem(LAST_PARENT_KEY) ?? "");
  const [busy, setBusy] = useState(false);

  const nameOk =
    name.trim().length > 0 && !/[\\/:]/.test(name.trim()) && !/^\.+$/.test(name.trim());
  // ponytail: plain text path + drive-letter check, no folder picker — native
  // dialog via Tauri is the upgrade path but breaks on phone anyway.
  const parentOk = /^[A-Za-z]:[\\/]/.test(parent.trim());

  async function create() {
    const cwd = parent.trim().replace(/[\\/]+$/, "") + "\\" + name.trim();
    setBusy(true);
    try {
      const r = await withToast(
        api.agentSpawn({
          bin: getSettings().claudeBin || "claude",
          cwd,
          createCwd: true,
          title: name.trim(),
        }),
        { error: "Couldn't create project" }
      );
      if (r) {
        localStorage.setItem(LAST_PARENT_KEY, parent.trim());
        onClose();
        navigate(`/agents?attach=${r.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-line bg-panel py-2 px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";

  return (
    <Modal
      open={open}
      title="New project"
      onClose={onClose}
      actions={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={!nameOk || !parentOk || busy}>
            <MessageSquarePlus className="h-4 w-4" /> {busy ? "Starting…" : "Create & open chat"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">Project name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-new-thing"
            className={inputCls}
            autoFocus
          />
          {name.trim() && !nameOk && (
            <div className="mt-1 text-xs text-warn">
              Name can't contain \ / or : characters.
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">
            Parent directory
          </div>
          <input
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            placeholder="C:\Projects"
            className={inputCls}
          />
          {parent.trim() && !parentOk && (
            <div className="mt-1 text-xs text-warn">
              Must be an absolute Windows path (e.g. C:\dev).
            </div>
          )}
        </div>
        <p className="text-xs text-faint">
          The folder is created and a Claude Code conversation opens inside it. The project
          appears in this list after the first conversation writes a transcript.
        </p>
      </div>
    </Modal>
  );
}

/** Folder / editor / Claude Code launchers shared by both layouts. */
function ProjectActions({ p, className }: { p: ProjectSummary; className?: string }) {
  const navigate = useNavigate();
  const actingMode = useSettings().actingMode;
  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <IconButton
        title="Open folder"
        onClick={() => withToast(api.openPath(p.path), { error: "Couldn't open folder" })}
        disabled={!p.pathExists}
      >
        <FolderOpen className="h-4 w-4" />
      </IconButton>
      <IconButton
        title="Open in editor (VS Code)"
        onClick={() => withToast(api.openInEditor(p.path), { error: "Couldn't open editor" })}
        disabled={!p.pathExists}
      >
        <Code2 className="h-4 w-4" />
      </IconButton>
      <IconButton
        title="Open Claude Code in this folder"
        onClick={() =>
          withToast(api.openTerminal(p.path, getSettings().claudeBin || "claude"), {
            error: "Couldn't open terminal",
          })
        }
        disabled={!p.pathExists}
      >
        <Terminal className="h-4 w-4" />
      </IconButton>
      {actingMode && (
        <IconButton
          title="New chat — fresh Claude Code conversation here, in-app"
          onClick={async () => {
            const r = await withToast(
              api.agentSpawn({
                bin: getSettings().claudeBin || "claude",
                cwd: p.path,
                title: p.name,
              }),
              { error: "Couldn't start agent session" }
            );
            if (r) navigate(`/agents?attach=${r.id}`);
          }}
          disabled={!p.pathExists}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </IconButton>
      )}
      {p.gitUrl && (
        <IconButton
          title={`Open on GitHub — ${p.gitUrl}`}
          onClick={() => withToast(api.openUrl(p.gitUrl!), { error: "Couldn't open URL" })}
        >
          <Github className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  );
}

function TitleLine({ p }: { p: ProjectSummary }) {
  return (
    <div className="flex items-center gap-2">
      <span className="truncate font-medium text-fg">{p.name}</span>
      {!p.pathExists && (
        <span title="Project folder no longer exists on disk">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warn" />
        </span>
      )}
      {p.models.slice(0, 2).map((m) => (
        <Badge key={m} color={modelColor(m)}>
          {prettyModel(m)}
        </Badge>
      ))}
    </div>
  );
}

function ProjectRow({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  return (
    <Card hover onClick={onOpen} className="group flex items-center gap-4 p-3.5">
      <div className="min-w-0 flex-1">
        <TitleLine p={p} />
        <div className="mt-0.5 truncate font-mono text-xs text-faint">{p.path}</div>
      </div>

      {/* Full metrics — shown when there's room (>= xl / 1280px) */}
      <div className="hidden shrink-0 items-center gap-5 text-right xl:flex">
        <Metric label="sessions" value={`${p.sessionCount}`} />
        <Metric label="messages" value={formatCompact(p.messageCount)} />
        <Metric label="tokens" value={formatCompact(tokenTotal(p.tokens))} strong />
        <Metric label="size" value={formatBytes(p.sizeBytes)} />
        <div className="w-24">
          <div className="text-sm text-muted">{formatRelative(p.lastActivity)}</div>
          <div className="text-[11px] text-faint">last active</div>
        </div>
      </div>

      {/* Compact metrics — medium widths down to the 940px minimum */}
      <div className="hidden shrink-0 items-center gap-4 text-right sm:flex xl:hidden">
        <Metric label="sessions" value={`${p.sessionCount}`} />
        <Metric label="tokens" value={formatCompact(tokenTotal(p.tokens))} strong />
        <div className="w-20">
          <div className="truncate text-sm text-muted">{formatRelative(p.lastActivity)}</div>
          <div className="text-[11px] text-faint">last active</div>
        </div>
      </div>

      <ProjectActions
        p={p}
        className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </Card>
  );
}

function ProjectGridCard({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  return (
    <Card hover onClick={onOpen} className="group flex flex-col gap-3 p-4">
      <div className="min-w-0">
        <TitleLine p={p} />
        <div className="mt-0.5 truncate font-mono text-[11px] text-faint">{p.path}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric label="sessions" value={`${p.sessionCount}`} />
        <Metric label="tokens" value={formatCompact(tokenTotal(p.tokens))} strong />
        <Metric label="size" value={formatBytes(p.sizeBytes)} />
      </div>
      <div className="flex items-center justify-between border-t border-outline pt-2.5">
        <span className="font-mono text-[11px] text-faint">{formatRelative(p.lastActivity)}</span>
        <ProjectActions
          p={p}
          className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        />
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="w-16">
      <div className={strong ? "text-sm font-semibold text-accent-2" : "text-sm text-fg"}>
        {value}
      </div>
      <div className="text-[11px] text-faint">{label}</div>
    </div>
  );
}
