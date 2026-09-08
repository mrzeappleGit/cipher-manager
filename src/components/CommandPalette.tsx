import {
  AppWindow,
  Blocks,
  CalendarClock,
  CalendarDays,
  Camera,
  CornerDownLeft,
  Equal,
  File,
  FileText,
  FolderGit2,
  HardDrive,
  LayoutDashboard,
  Milestone,
  PackageSearch,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Sparkles,
  TerminalSquare,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { calc } from "../lib/calc";
import { closePalette, togglePalette, usePaletteOpen } from "../lib/palette";
import { openRundown } from "../lib/rundown";
import { openJobs } from "../lib/jobs";
import { notify } from "../lib/toast";
import type { AppEntry, FileHit, ProjectSummary } from "../types";

interface Item {
  key: string;
  group: string;
  label: string;
  sub?: string;
  icon: LucideIcon;
  run: () => void;
}

const SCREENS: { label: string; to: string; icon: LucideIcon }[] = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard },
  { label: "Deck", to: "/deck", icon: CalendarClock },
  { label: "Packages", to: "/packages", icon: PackageSearch },
  { label: "Projects", to: "/projects", icon: FolderGit2 },
  { label: "Daily recaps", to: "/daily", icon: CalendarDays },
  { label: "Documents", to: "/documents", icon: FileText },
  { label: "Skills", to: "/skills", icon: Blocks },
  { label: "Roadmap", to: "/roadmap", icon: Milestone },
  { label: "Ask", to: "/ask", icon: WandSparkles },
  { label: "Search", to: "/search", icon: Search },
  { label: "Screenshots", to: "/screenshots", icon: Camera },
  { label: "Cleanup", to: "/cleanup", icon: HardDrive },
  { label: "Settings", to: "/settings", icon: Settings },
];

/** Below this, a file-index query matches half the disk. */
const FILE_MIN = 3;

export function CommandPalette() {
  const open = usePaletteOpen();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [files, setFiles] = useState<FileHit[]>([]);

  // Global ⌘K / Ctrl+K toggle + Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        togglePalette();
      } else if (e.key === "Escape") {
        closePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load projects and the installed-app list once, when first opened.
  useEffect(() => {
    if (open && projects === null) {
      api.listProjects().then(setProjects).catch(() => setProjects([]));
    }
    if (open && apps === null) {
      api.listApps().then(setApps).catch(() => setApps([]));
    }
    if (open) {
      setQuery("");
      setActive(0);
      setFiles([]);
    }
  }, [open, projects, apps]);

  // File search hits the Windows index, so it's debounced and only runs once
  // the query is specific enough to be worth a round trip.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < FILE_MIN) {
      setFiles([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .searchFiles(q, 8)
        .then((hits) => alive && setFiles(hits))
        .catch(() => alive && setFiles([]));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, open]);

  const flat = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(q);

    const screens: Item[] = SCREENS.filter((s) => !q || match(s.label)).map((s) => ({
      key: `nav:${s.to}`,
      group: "Go to",
      label: s.label,
      icon: s.icon,
      run: () => navigate(s.to),
    }));

    const projItems: Item[] = (projects ?? [])
      .filter((p) => !q || match(p.name) || match(p.path))
      .slice(0, 8)
      .map((p) => ({
        key: `proj:${p.id}`,
        group: "Projects",
        label: p.name,
        sub: p.path,
        icon: FolderGit2,
        run: () => navigate(`/projects/${p.id}`),
      }));

    const actions: Item[] = [
      {
        key: "act:rundown",
        group: "Actions",
        label: "Give me the rundown",
        icon: Sparkles,
        run: () => openRundown(),
      },
      {
        key: "act:universal",
        group: "Actions",
        label: "Universal search…",
        sub: "⌃⌥Space",
        icon: ScanSearch,
        run: () => {
          api.openSearchWindow().catch((e) => notify.error(`Couldn't open search: ${e}`));
        },
      },
      {
        key: "act:jobs",
        group: "Actions",
        label: "Show jobs",
        icon: TerminalSquare,
        run: () => openJobs(),
      },
      {
        key: "act:refresh",
        group: "Actions",
        label: "Refresh data",
        icon: RefreshCw,
        run: async () => {
          try {
            await api.refresh();
          } catch {
            /* ignore */
          }
          window.location.reload();
        },
      },
    ].filter((a) => !q || match(a.label));

    // An arithmetic or unit answer, when the query happens to be one. Enter
    // copies it — that's the only thing you ever want to do with a result.
    const answer = calc(query);
    const answerItems: Item[] = answer
      ? [
          {
            key: "calc",
            group: "Answer",
            label: answer.text,
            sub: answer.expr,
            icon: Equal,
            run: () => {
              navigator.clipboard
                .writeText(answer.text)
                .then(() => notify.success(`Copied ${answer.text}`))
                .catch(() => notify.error("Couldn't copy to the clipboard"));
            },
          },
        ]
      : [];

    const appItems: Item[] = (apps ?? [])
      .filter((a) => (q ? match(a.name) : false))
      .slice(0, 6)
      .map((a) => ({
        key: `app:${a.path}`,
        group: "Apps",
        label: a.name,
        icon: AppWindow,
        run: () => {
          api.openPath(a.path).catch((e) => notify.error(`Couldn't launch ${a.name}: ${e}`));
        },
      }));

    const fileItems: Item[] = files.map((f) => ({
      key: `file:${f.path}`,
      group: "Files",
      label: f.name,
      sub: f.path,
      icon: File,
      run: () => {
        api.openPath(f.path).catch((e) => notify.error(`Couldn't open ${f.name}: ${e}`));
      },
    }));

    return [...answerItems, ...screens, ...projItems, ...actions, ...appItems, ...fileItems];
  }, [query, projects, apps, files, navigate]);

  if (!open) return null;

  const run = (item?: Item) => {
    if (!item) return;
    item.run();
    closePalette();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[active]);
    } else if (e.key === "Escape") {
      closePalette();
    }
  };

  // Group the flat list for rendering while keeping global indices.
  const groups: { label: string; items: { item: Item; index: number }[] }[] = [];
  flat.forEach((item, index) => {
    let g = groups.find((x) => x.label === item.group);
    if (!g) {
      g = { label: item.group, items: [] };
      groups.push(g);
    }
    g.items.push({ item, index });
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={closePalette}
    >
      <div
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-[20px] border border-outline bg-surface-3 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-outline px-4 py-3.5">
          <Search className="h-[18px] w-[18px] shrink-0 text-cyan" strokeWidth={1.9} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search apps, files, projects — or type a sum…"
            className="flex-1 bg-transparent font-body text-[15px] text-text outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-outline bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted">
            ESC
          </kbd>
        </div>

        <div className="max-h-[342px] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="px-3 py-8 text-center font-body text-sm text-muted">
              No matches for “{query}”
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="px-2.5 pb-1 pt-2.5 font-display text-[10.5px] font-bold uppercase tracking-[1px] text-muted">
                  {g.label}
                </div>
                {g.items.map(({ item, index }) => (
                  <button
                    key={item.key}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(item)}
                    className={
                      "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors " +
                      (index === active ? "bg-surface-2" : "hover:bg-surface-2/60")
                    }
                  >
                    <item.icon
                      className={
                        "h-[17px] w-[17px] shrink-0 " +
                        (index === active ? "text-cyan" : "text-muted")
                      }
                      strokeWidth={1.9}
                    />
                    <span className="flex-1 truncate font-body text-[13.5px] text-text">
                      {item.label}
                    </span>
                    {item.sub && (
                      <span className="truncate font-mono text-[11px] text-faint">{item.sub}</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-outline bg-bg px-4 py-2.5 font-mono text-[10.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <CornerDownLeft className="h-3 w-3 text-text" /> open
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-text">↑↓</span> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-text">esc</span> dismiss
          </span>
          <div className="flex-1" />
          <span className="hidden items-center gap-1.5 sm:flex">
            <span className="text-text">ctrl+alt+space</span> universal search
          </span>
        </div>
      </div>
    </div>
  );
}
