// The standalone universal-search window — Finder's search anatomy (toolbar,
// scope bar, criteria row, column list, path bar) rendered in CipherCore.
// Runs in its own Tauri window labelled "search", so it deliberately does not
// use Layout: no sidebar, no status bar, no router.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Blocks,
  Camera,
  CornerDownLeft,
  File,
  FileText,
  FolderGit2,
  FolderOpen,
  MessageSquare,
  Search,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { isTauri } from "../api";
import { cn, Spinner } from "../components/ui";
import { formatBytes } from "../lib/format";
import {
  applyView,
  DATE_FILTERS,
  hideSearchPanel,
  KIND_LABEL,
  matchActions,
  openHit,
  revealHit,
  runSources,
  SCOPES,
  type DateFilterId,
  type HitKind,
  type ScopeId,
  type SortColumn,
  type UniversalHit,
} from "../lib/universal";

const KIND_ICON: Record<HitKind, LucideIcon> = {
  action: Zap,
  session: MessageSquare,
  note: FileText,
  project: FolderGit2,
  document: FileText,
  skill: Blocks,
  file: File,
  app: AppWindow,
  screenshot: Camera,
};

const COLUMNS: { id: SortColumn; label: string; className: string }[] = [
  { id: "name", label: "Name", className: "" },
  { id: "kind", label: "Kind", className: "" },
  { id: "where", label: "Where", className: "" },
  { id: "date", label: "Date Modified", className: "" },
  { id: "size", label: "Size", className: "text-right" },
];

const GRID = "grid grid-cols-[minmax(0,2.4fr)_104px_minmax(0,1.7fr)_136px_88px] gap-3";

const hideWindow = () => void hideSearchPanel();

/** Enter / click. Actions hide the panel themselves before doing their work
 *  (a capture must not photograph us), so the trailing hide is a no-op there. */
const runHit = (hit: UniversalHit) =>
  void openHit(hit)
    .then(hideWindow)
    .catch(() => hideWindow());

/** Finder shows a relative date for recent items and an absolute one beyond. */
function dateCell(t: number | null, now: number): string {
  if (t === null) return "—";
  const diff = now - t;
  if (diff < 60_000) return "Just now";
  if (diff < 86_400_000) {
    return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (diff < 7 * 86_400_000) {
    return new Date(t).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function FinderSearch() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeId>("all");
  const [dateFilter, setDateFilter] = useState<DateFilterId>("any");
  const [sort, setSort] = useState<SortColumn>("relevance");
  const [desc, setDesc] = useState(true);
  const [raw, setRaw] = useState<UniversalHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Bumped per search; a response whose token is stale gets dropped.
  const token = useRef(0);
  const now = Date.now();

  // Re-arm every time the window is shown by the hotkey.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("search-window-shown", () => {
        setQuery("");
        setRaw([]);
        setActive(0);
        inputRef.current?.focus();
        inputRef.current?.select();
      }).then((u) => (un = u))
    );
    return () => un?.();
  }, []);

  // Debounced fan-out across every source in scope.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRaw([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mine = ++token.current;
    const t = setTimeout(() => {
      runSources(q, scope)
        .then((hits) => {
          if (token.current !== mine) return;
          setRaw(hits);
          setLoading(false);
          setActive(0);
        })
        .catch(() => {
          if (token.current !== mine) return;
          setRaw([]);
          setLoading(false);
        });
    }, 180);
    return () => clearTimeout(t);
  }, [query, scope]);

  // Synchronous, so a shortcut is on screen before the debounced content
  // search has even fired.
  const actions = useMemo(() => matchActions(query), [query]);

  const results = useMemo(
    () => applyView([...actions, ...raw], { query, scope, date: dateFilter, sort, desc, now }),
    // `now` is deliberately excluded: it changes every render and would rebuild
    // the list constantly. The date buckets are far coarser than a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, raw, query, scope, dateFilter, sort, desc]
  );

  const selected = results[active];

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cycleScope = useCallback(
    (step: number) => {
      const i = SCOPES.findIndex((s) => s.id === scope);
      setScope(SCOPES[(i + step + SCOPES.length) % SCOPES.length].id);
    },
    [scope]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hideWindow();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) void revealHit(selected);
      else runHit(selected);
    }
  };

  function toggleSort(col: SortColumn) {
    if (sort === col) setDesc((d) => !d);
    else {
      setSort(col);
      setDesc(col === "date" || col === "size");
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-1 font-body text-text">
      {/* Toolbar — the whole strip drags the window, the controls inside don't. */}
      <div
        data-tauri-drag-region
        className="flex h-14 shrink-0 items-center gap-3 border-b border-outline bg-surface-2 px-4"
      >
        <Search className="pointer-events-none h-[18px] w-[18px] shrink-0 text-cyan" strokeWidth={1.9} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search sessions, notes, projects, files, apps…"
          spellCheck={false}
          className="h-9 flex-1 rounded-[10px] border border-outline bg-bg px-3 font-body text-[14px] text-text outline-none transition-colors placeholder:text-faint focus:border-cyan/50"
        />
        {loading && <Spinner className="h-4 w-4 shrink-0" />}
        <button
          onClick={hideWindow}
          title="Close (Esc)"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scope bar */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-outline bg-surface-1 px-4 py-2">
        <span className="mr-1 shrink-0 font-display text-[10.5px] font-bold uppercase tracking-[1px] text-muted">
          Search
        </span>
        {SCOPES.map((s) => (
          <button
            key={s.id}
            onClick={() => setScope(s.id)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 font-body text-[12px] font-semibold transition-colors",
              scope === s.id
                ? "bg-cyan/15 text-cyan shadow-[inset_0_0_0_1px_rgba(0,245,255,0.4)]"
                : "text-muted hover:bg-surface-2 hover:text-text"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Criteria row */}
      <div className="flex shrink-0 items-center gap-2 border-b border-outline bg-surface-1 px-4 py-2 font-mono text-[11px] text-muted">
        <span>Modified</span>
        <select
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value as DateFilterId)}
          className="rounded-md border border-outline bg-surface-2 px-2 py-1 font-mono text-[11px] text-text outline-none focus:border-cyan/50"
        >
          {DATE_FILTERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        {sort !== "relevance" && (
          <button onClick={() => setSort("relevance")} className="transition-colors hover:text-cyan">
            sorted by {sort} · back to relevance
          </button>
        )}
        <div className="flex-1" />
        <span>
          {results.length}
          {results.length === 1 ? " item" : " items"}
        </span>
      </div>

      {/* Column headers */}
      <div
        className={cn(
          GRID,
          "shrink-0 border-b border-outline bg-surface-2 px-4 py-1.5 font-display text-[10.5px] font-bold uppercase tracking-[0.8px] text-muted"
        )}
      >
        {COLUMNS.map((c) => (
          <button
            key={c.id}
            onClick={() => toggleSort(c.id)}
            className={cn("flex items-center gap-1 truncate transition-colors hover:text-cyan", c.className)}
          >
            <span className="truncate">{c.label}</span>
            {sort === c.id && <span className="text-cyan">{desc ? "▾" : "▴"}</span>}
          </button>
        ))}
      </div>

      {/* Results */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {query.trim().length < 2 ? (
          <Hint icon={Search} title="Search everything" text="Sessions, vault notes, projects, documents, skills, local files, installed apps and screenshots — all at once." />
        ) : results.length === 0 && !loading ? (
          <Hint icon={Search} title="No matches" text={`Nothing found for "${query.trim()}" in this scope.`} />
        ) : (
          results.map((hit, i) => {
            const Icon = hit.icon ?? KIND_ICON[hit.kind];
            const on = i === active;
            return (
              <button
                key={hit.id}
                data-row={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => runHit(hit)}
                className={cn(
                  GRID,
                  "w-full items-center px-4 py-1.5 text-left transition-colors",
                  on ? "bg-cyan/12" : i % 2 === 1 ? "bg-surface-2/40" : "",
                  !on && "hover:bg-surface-2"
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon
                    className={cn("h-[15px] w-[15px] shrink-0", on ? "text-cyan" : "text-muted")}
                    strokeWidth={1.9}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-body text-[13px] text-text">{hit.name}</span>
                    {hit.snippet && (
                      <span className="block truncate font-mono text-[10.5px] text-faint">{hit.snippet}</span>
                    )}
                  </span>
                </span>
                <span className="truncate font-mono text-[11px] text-muted">{KIND_LABEL[hit.kind]}</span>
                <span className="truncate font-mono text-[11px] text-faint">{hit.where}</span>
                <span className="truncate font-mono text-[11px] text-muted">{dateCell(hit.date, now)}</span>
                <span className="truncate text-right font-mono text-[11px] text-muted">
                  {hit.size === null ? "—" : formatBytes(hit.size)}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Path bar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-outline bg-surface-2 px-4 font-mono text-[10.5px] text-muted">
        {selected ? (
          <>
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="truncate">{selected.via === "os" ? selected.target : selected.where}</span>
            <div className="flex-1" />
            <span className="flex shrink-0 items-center gap-1.5">
              <CornerDownLeft className="h-3 w-3 text-text" /> open
              {selected.via === "os" && <span className="ml-2 text-text">ctrl+⏎</span>}
              {selected.via === "os" && " reveal"}
            </span>
          </>
        ) : (
          <span className="text-faint">↑↓ navigate · tab switches scope · esc closes</span>
        )}
      </div>
    </div>
  );
}

function Hint({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-10 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-[13px] border border-outline bg-surface-2 text-muted">
        <Icon className="h-5 w-5" />
      </div>
      <div className="font-display text-[15px] font-semibold text-text">{title}</div>
      <div className="max-w-sm font-body text-[13px] text-muted">{text}</div>
    </div>
  );
}
