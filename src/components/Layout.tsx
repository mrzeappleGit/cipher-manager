import {
  Blocks,
  Bookmark,
  CalendarClock,
  Camera,
  Clapperboard,
  Scissors,
  CalendarDays,
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
  WandSparkles,
} from "lucide-react";
import { Menu, X } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api, dataMode, snapshotGeneratedAt, type DataMode } from "../api";
import { openPalette } from "../lib/palette";
import { useAsync } from "../lib/useAsync";
import { formatCompact } from "../lib/format";
import { tokenTotal } from "../types";
import { cn, Spinner } from "./ui";
import { Toaster } from "./Toaster";
import { CommandPalette } from "./CommandPalette";
import { Rundown } from "./Rundown";
import { JobsPanel } from "./JobsPanel";
import { openJobs, useJobs } from "../lib/jobs";
import { TerminalSquare } from "lucide-react";

/** Footer badge suffix: how old the baked snapshot data is. */
function snapshotAge(): string | null {
  const t = snapshotGeneratedAt();
  if (!t) return null;
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface NavItemProps {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end: boolean;
}

/** The sidebar, grouped by what you came to do rather than by when each page
 *  shipped. Groups stay at 3 items: past ~7 in a row the eye stops scanning a
 *  list and starts hunting it, and the whole point is that you skip four
 *  groups to reach the one you want.
 *
 *  Search is deliberately absent — it is the ⌘K palette and the Ctrl+Alt+Space
 *  window, both already reachable from the two buttons above this nav. The
 *  `/search` page itself is unchanged and still listed in CommandPalette.tsx;
 *  a third entry point here only taught the slowest of the three. */
const NAV_GROUPS: Array<{ label: string; items: NavItemProps[] }> = [
  {
    label: "Today",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/deck", label: "Deck", icon: CalendarClock, end: false },
      { to: "/daily", label: "Daily recaps", icon: CalendarDays, end: false },
      // Fourth item, breaking the 3-per-group rule below on purpose: the Deck
      // strip only appears when something is in transit, so without a nav entry
      // the page is invisible exactly when there's nothing to see.
      { to: "/packages", label: "Packages", icon: PackageSearch, end: false },
    ],
  },
  {
    label: "Work",
    items: [
      { to: "/projects", label: "Projects", icon: FolderGit2, end: false },
      { to: "/documents", label: "Documents", icon: FileText, end: false },
      { to: "/bookmarks", label: "Bookmarks", icon: Bookmark, end: false },
    ],
  },
  {
    label: "Make",
    items: [
      { to: "/highlights", label: "Highlights", icon: Scissors, end: false },
      { to: "/schedule", label: "Schedule maker", icon: Clapperboard, end: false },
      { to: "/screenshots", label: "Screenshots", icon: Camera, end: false },
    ],
  },
  {
    label: "Automate",
    items: [
      { to: "/ask", label: "Ask", icon: WandSparkles, end: false },
      { to: "/agents", label: "Agents", icon: TerminalSquare, end: false },
      { to: "/skills", label: "Skills", icon: Blocks, end: false },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/cleanup", label: "Cleanup", icon: HardDrive, end: false },
      { to: "/roadmap", label: "Roadmap", icon: Milestone, end: false },
      { to: "/settings", label: "Settings", icon: Settings, end: false },
    ],
  },
];

function BrandMark() {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-outline px-4">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border border-outline bg-bg font-mono text-[15px] text-cyan"
        style={{ boxShadow: "inset 0 0 12px rgba(0,245,255,0.1)" }}
      >
        <span>&gt;</span>
        <span className="cm-caret -ml-[3px]">_</span>
      </div>
      <div className="min-w-0 leading-none">
        <div className="font-display text-[17px] font-semibold tracking-[0.3px] text-text">
          cipher<span className="grad-text">Manager</span>
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-muted">
          usage console
        </div>
      </div>
    </div>
  );
}

function NavItem({ to, label, icon: Icon, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 font-body text-sm font-semibold transition-colors",
          isActive ? "bg-surface-2 text-cyan" : "text-muted hover:bg-surface-2 hover:text-text"
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-[3px] bg-cyan transition-opacity"
            style={{ boxShadow: "0 0 10px #00f5ff", opacity: isActive ? 1 : 0 }}
          />
          <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.9} />
          <span className="flex-1">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-2 pt-1.5 font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
      {children}
    </div>
  );
}

function Sidebar({ className }: { className?: string }) {
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await api.refresh();
    } catch {
      /* ignore */
    }
    window.location.reload();
  }

  return (
    <aside
      className={cn(
        "relative z-[5] flex h-full w-[230px] shrink-0 flex-col border-r border-outline bg-surface-1",
        className
      )}
    >
      <BrandMark />
      <button
        onClick={openPalette}
        className="mx-3 mt-3 flex items-center gap-2.5 rounded-[10px] border border-outline bg-bg px-3 py-2 text-left font-body text-[13px] text-muted transition-colors hover:border-cyan/40 hover:text-text"
      >
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <span className="flex-1 truncate">Search or jump to…</span>
        <kbd className="rounded border border-outline px-1.5 py-0.5 font-mono text-[10px] text-faint">
          ⌘K
        </kbd>
      </button>
      <button
        onClick={() => api.openSearchWindow().catch(() => {})}
        title="Search sessions, notes, files and apps in a separate window"
        className="mx-3 mt-1.5 flex items-center gap-2.5 rounded-[10px] border border-outline bg-bg px-3 py-2 text-left font-body text-[13px] text-muted transition-colors hover:border-cyan/40 hover:text-text"
      >
        <ScanSearch className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <span className="flex-1 truncate">Universal search</span>
        <kbd className="rounded border border-outline px-1.5 py-0.5 font-mono text-[10px] text-faint">
          ⌃⌥Space
        </kbd>
      </button>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3.5">
        {NAV_GROUPS.map((group, i) => (
          <Fragment key={group.label}>
            {i > 0 && <div className="pt-3" />}
            <SectionLabel>{group.label}</SectionLabel>
            {group.items.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </Fragment>
        ))}
      </nav>

      <div className="flex flex-col gap-2.5 border-t border-outline p-3">
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-outline bg-surface-2 px-3 py-2.5 font-body text-xs font-semibold tracking-[0.3px] text-text transition-colors hover:border-cyan/50 disabled:opacity-60"
        >
          {refreshing ? (
            <Spinner className="h-[15px] w-[15px]" />
          ) : (
            <RefreshCw className="h-[15px] w-[15px]" strokeWidth={1.9} />
          )}
          <span className="flex-1 text-left">Refresh data</span>
        </button>
        <div className="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan"
            style={{ boxShadow: "0 0 7px #00f5ff" }}
          />
          <span className="truncate">reading ~/.claude</span>
        </div>
      </div>
    </aside>
  );
}

function StatusBar() {
  const { data } = useAsync(() => api.getUsageStats(), []);
  const [mode, setMode] = useState<DataMode | null>(null);
  const { jobs } = useJobs();
  const running = jobs.filter((j) => j.status === "running").length;
  useEffect(() => {
    dataMode().then(setMode);
  }, []);

  return (
    <footer className="relative z-[4] flex h-[30px] shrink-0 items-center gap-3 border-t border-outline bg-surface-1 px-4 font-mono text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full bg-cyan"
          style={{ boxShadow: "0 0 6px #00f5ff" }}
        />
        connected
      </span>
      <span className="text-outline">/</span>
      <span className="hidden sm:inline">reading ~/.claude</span>
      {jobs.length > 0 && (
        <>
          <span className="text-outline">/</span>
          <button
            onClick={() => openJobs()}
            className="flex items-center gap-1.5 transition-colors hover:text-cyan"
            title="Show jobs"
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            {running > 0 ? (
              <span className="text-cyan">{running} running</span>
            ) : (
              <span>jobs</span>
            )}
          </button>
        </>
      )}
      <div className="flex-1" />
      {data && (
        <>
          <span className="hidden md:inline">
            <span className="text-text">{data.projectCount}</span> projects
          </span>
          <span className="hidden md:inline">·</span>
          <span className="hidden md:inline">
            <span className="text-text">{formatCompact(data.sessionCount)}</span> sessions
          </span>
          <span className="hidden md:inline">·</span>
          <span>
            <span className="text-text">{formatCompact(tokenTotal(data.tokens))}</span> tokens
          </span>
        </>
      )}
      {mode === "mock" && (
        <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 uppercase tracking-[0.5px] text-warn">
          sample data
        </span>
      )}
      {mode === "snapshot" && (
        <span className="rounded-full border border-outline px-2 py-0.5 uppercase tracking-[0.5px]">
          snapshot{snapshotAge() ? ` · ${snapshotAge()}` : ""}
        </span>
      )}
    </footer>
  );
}

export function Page({
  title,
  subtitle,
  actions,
  children,
  wide,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("mx-auto px-4 py-5 sm:px-6 sm:py-6", wide ? "max-w-[1360px]" : "max-w-[1160px]")}>
      {(title || actions) && (
        <div className="mb-6 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h1 className="truncate font-display text-[22px] font-bold tracking-[0.2px] text-text">
                {title}
              </h1>
            )}
            {subtitle && <div className="mt-1.5 font-body text-sm text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Mobile-only top bar + slide-over drawer holding the same Sidebar. Hidden ≥md. */
function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // Any navigation closes the drawer.
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-outline bg-surface-1 px-2 md:hidden">
        <button
          onClick={() => setOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" strokeWidth={1.9} />
        </button>
        <div className="font-display text-[15px] font-semibold tracking-[0.3px] text-text">
          cipher<span className="grad-text">Manager</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={openPalette}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label="Search"
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.9} />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div
            className="absolute inset-0"
            style={{ background: "rgba(3,6,9,0.72)" }}
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-0 left-0 top-0">
            <Sidebar className="shadow-[var(--cm-shadow-3)]" />
          </div>
          <button
            onClick={() => setOpen(false)}
            className="absolute left-[238px] top-3 flex h-9 w-9 items-center justify-center rounded-[10px] border border-outline bg-surface-2 text-muted"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" strokeWidth={1.9} />
          </button>
        </div>
      )}
    </>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar className="hidden md:flex" />
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <MobileNav />
        <div className="flex-1 overflow-y-auto">{children}</div>
        <StatusBar />
      </main>
      <Toaster />
      <CommandPalette />
      <Rundown />
      <JobsPanel />
    </div>
  );
}
