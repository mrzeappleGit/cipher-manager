// The data layer behind the Finder-style search window: fan out across every
// content source the app knows about, normalise the results into one shape,
// then rank / filter / sort them. Everything here is pure except `runSources`
// and `openHit`, so the interesting logic is testable without a webview.

import {
  Blocks,
  Bookmark,
  CalendarClock,
  CalendarDays,
  Camera,
  Crop,
  FileText,
  FolderGit2,
  HardDrive,
  Images,
  LayoutDashboard,
  Milestone,
  Scissors,
  Settings,
  TerminalSquare,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { api, isTauri } from "../api";
import { getSettings } from "./settings";

export type HitKind =
  | "action"
  | "session"
  | "note"
  | "project"
  | "document"
  | "skill"
  | "file"
  | "app"
  | "screenshot";

export interface UniversalHit {
  id: string;
  kind: HitKind;
  /** Finder's "Name" column. */
  name: string;
  /** Finder's "Where" column — project, vault-relative dir, or parent folder. */
  where: string;
  /** Matched text, shown under the name. */
  snippet?: string;
  /** Epoch ms, or null when the source has no timestamp. */
  date: number | null;
  /** Bytes, or null when the source has no size. */
  size: number | null;
  /** In-app route when `via` is "app", absolute path when "os". */
  target: string;
  via: "app" | "os";
  /** Extra match text (action keywords) — searched alongside the name. */
  terms?: string[];
  /** Actions carry their own icon and do their own work; `target`/`via` unused. */
  icon?: LucideIcon;
  run?: () => Promise<void> | void;
}

export type ScopeId = "all" | HitKind;

export const SCOPES: { id: ScopeId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "action", label: "Actions" },
  { id: "session", label: "Sessions" },
  { id: "note", label: "Notes" },
  { id: "project", label: "Projects" },
  { id: "document", label: "Docs" },
  { id: "file", label: "Files" },
  { id: "app", label: "Apps" },
  { id: "screenshot", label: "Shots" },
];

/** "Docs" covers skills too — they're markdown in ~/.claude like everything else. */
function inScope(hit: UniversalHit, scope: ScopeId): boolean {
  if (scope === "all") return true;
  if (scope === "document") return hit.kind === "document" || hit.kind === "skill";
  return hit.kind === scope;
}

export const KIND_LABEL: Record<HitKind, string> = {
  action: "Action",
  session: "Session",
  note: "Note",
  project: "Project",
  document: "Document",
  skill: "Skill",
  file: "File",
  app: "Application",
  screenshot: "Screenshot",
};

// ---------------------------------------------------------------------------
// Date filter
// ---------------------------------------------------------------------------

export type DateFilterId = "any" | "today" | "7d" | "30d" | "year";

export const DATE_FILTERS: { id: DateFilterId; label: string }[] = [
  { id: "any", label: "any date" },
  { id: "today", label: "today" },
  { id: "7d", label: "past week" },
  { id: "30d", label: "past month" },
  { id: "year", label: "past year" },
];

const DAY = 86_400_000;

/** Undated hits survive every filter except an explicit range — Finder hides
 *  them once you constrain the date, and so do we. */
export function withinRange(hit: UniversalHit, filter: DateFilterId, now: number): boolean {
  if (filter === "any") return true;
  if (hit.date === null) return false;
  const span = filter === "today" ? DAY : filter === "7d" ? 7 * DAY : filter === "30d" ? 30 * DAY : 365 * DAY;
  return now - hit.date <= span;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Exact beats prefix beats word-start beats substring; 5 = no match. */
function tier(hay: string, q: string): number {
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  if (hay.includes(` ${q}`) || hay.includes(`-${q}`) || hay.includes(`_${q}`)) return 2;
  if (hay.includes(q)) return 3;
  return 5;
}

/** Lower sorts first. Best of the name and any keyword; a body-only match
 *  ranks below all of them. */
export function rankOf(hit: UniversalHit, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 5;
  let best = tier(hit.name.toLowerCase(), q);
  for (const t of hit.terms ?? []) best = Math.min(best, tier(t.toLowerCase(), q));
  if (best === 5 && (hit.snippet ?? "").toLowerCase().includes(q)) return 4;
  return best;
}

/** Actions first (you asked for a thing to *do*, not a file about it), then
 *  rank, then newest, then name so the order never wobbles between renders. */
export function rankHits(hits: UniversalHit[], query: string): UniversalHit[] {
  return [...hits].sort((a, b) => {
    const act = (a.kind === "action" ? 0 : 1) - (b.kind === "action" ? 0 : 1);
    if (act !== 0) return act;
    const d = rankOf(a, query) - rankOf(b, query);
    if (d !== 0) return d;
    const at = a.date ?? 0;
    const bt = b.date ?? 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Column sorting
// ---------------------------------------------------------------------------

export type SortColumn = "relevance" | "name" | "kind" | "where" | "date" | "size";

export function sortHits(
  hits: UniversalHit[],
  column: SortColumn,
  desc: boolean,
  query: string
): UniversalHit[] {
  if (column === "relevance") return rankHits(hits, query);
  const dir = desc ? -1 : 1;
  return [...hits].sort((a, b) => {
    let d = 0;
    if (column === "name") d = a.name.localeCompare(b.name);
    else if (column === "kind") d = KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]);
    else if (column === "where") d = a.where.localeCompare(b.where);
    // Nulls sort last in both directions — an undated row is never "the newest".
    else if (column === "date") d = nullLast(a.date, b.date, desc);
    else d = nullLast(a.size, b.size, desc);
    return d * dir || a.name.localeCompare(b.name);
  });
}

function nullLast(a: number | null, b: number | null, desc: boolean): number {
  if (a === null && b === null) return 0;
  // Flip the sentinel with the direction so nulls stay at the bottom.
  if (a === null) return desc ? -1 : 1;
  if (b === null) return desc ? 1 : -1;
  return a - b;
}

/** Everything the window applies to a raw result set, in order. */
export function applyView(
  hits: UniversalHit[],
  opts: { query: string; scope: ScopeId; date: DateFilterId; sort: SortColumn; desc: boolean; now: number }
): UniversalHit[] {
  const kept = hits.filter((h) => inScope(h, opts.scope) && withinRange(h, opts.date, opts.now));
  return sortHits(kept, opts.sort, opts.desc, opts.query);
}

// ---------------------------------------------------------------------------
// Actions — things to *do*, matched on keywords and ranked above content
// ---------------------------------------------------------------------------

/** Hide the search panel. No-op in the main window or a browser. */
export async function hideSearchPanel(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (w.label === "search") await w.hide();
  } catch {
    /* not a Tauri window */
  }
}

interface ActionDef {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  keywords: string[];
  run: () => Promise<void> | void;
}

/** Capture has to happen with the panel already gone — awaiting the hide
 *  before invoking also stops Rust seeing it as "visible" and restoring it. */
async function captureFromPanel(mode: "region" | "screen") {
  await hideSearchPanel();
  const { captureShot } = await import("./shots");
  await captureShot(mode);
}

const ACTIONS: ActionDef[] = [
  {
    id: "capture-region",
    label: "Capture region",
    hint: "drag a box — lands on the clipboard",
    icon: Crop,
    keywords: ["screenshot", "screen", "capture", "region", "snip", "crop", "grab", "selector", "clip"],
    run: () => captureFromPanel("region"),
  },
  {
    id: "capture-screen",
    label: "Capture full screen",
    hint: "every monitor",
    icon: Camera,
    keywords: ["screenshot", "screen", "capture", "fullscreen", "monitor", "desktop", "grab"],
    run: () => captureFromPanel("screen"),
  },
];

/** Pages, reachable as actions so "settings" jumps instead of listing files. */
const PLACES: { label: string; route: string; icon: LucideIcon; keywords?: string[] }[] = [
  { label: "Dashboard", route: "/", icon: LayoutDashboard, keywords: ["home", "overview"] },
  { label: "Deck", route: "/deck", icon: CalendarClock, keywords: ["calendar", "tasks", "agenda", "meetings"] },
  { label: "Projects", route: "/projects", icon: FolderGit2 },
  { label: "Daily recaps", route: "/daily", icon: CalendarDays },
  { label: "Documents", route: "/documents", icon: FileText, keywords: ["notes", "vault"] },
  { label: "Bookmarks", route: "/bookmarks", icon: Bookmark },
  { label: "Skills", route: "/skills", icon: Blocks },
  { label: "Agents", route: "/agents", icon: TerminalSquare, keywords: ["terminal", "session"] },
  { label: "Screenshots", route: "/screenshots", icon: Images, keywords: ["screenshot", "gallery", "shots"] },
  { label: "Highlights", route: "/highlights", icon: Scissors, keywords: ["clips", "twitch"] },
  { label: "Roadmap", route: "/roadmap", icon: Milestone },
  { label: "Ask", route: "/ask", icon: WandSparkles },
  { label: "Cleanup", route: "/cleanup", icon: HardDrive, keywords: ["disk", "space"] },
  { label: "Settings", route: "/settings", icon: Settings, keywords: ["preferences", "config", "options"] },
];

function actionHit(a: ActionDef): UniversalHit {
  return {
    id: `action:${a.id}`,
    kind: "action",
    name: a.label,
    where: "cipherManager",
    snippet: a.hint,
    date: null,
    size: null,
    target: "",
    via: "app",
    terms: a.keywords,
    icon: a.icon,
    run: a.run,
  };
}

/**
 * Matching actions for `query`. Synchronous on purpose — the window merges
 * these in without waiting on the debounced content search, so a shortcut is
 * on screen the moment you have typed enough of it.
 */
export function matchActions(query: string): UniversalHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const places: ActionDef[] = PLACES.map((p) => ({
    id: `go-${p.route}`,
    label: p.label,
    hint: `open ${p.route}`,
    icon: p.icon,
    keywords: [...(p.keywords ?? []), "go", "open"],
    run: async () => {
      await api.openInMain(p.route);
    },
  }));
  return [...ACTIONS, ...places]
    .map(actionHit)
    .filter((h) => rankOf(h, q) < 5);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const parentOf = (p: string): string => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
};

const has = (hay: string, q: string) => hay.toLowerCase().includes(q.toLowerCase());

/**
 * Query every source the scope needs, in parallel. A source that fails or
 * isn't available (web mode, no vault configured) contributes nothing rather
 * than failing the whole search.
 */
export async function runSources(query: string, scope: ScopeId): Promise<UniversalHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const want = (kind: HitKind) =>
    scope === "all" || scope === kind || (scope === "document" && kind === "skill");

  const jobs: Promise<UniversalHit[]>[] = [];

  if (want("session")) {
    jobs.push(
      api.search(q, 60).then((rows) =>
        rows.map((r, i) => ({
          id: `session:${r.sessionId}:${i}`,
          kind: "session" as const,
          name: r.sessionTitle || r.projectName || "Untitled session",
          where: r.projectName,
          snippet: r.snippet,
          date: ms(r.timestamp),
          size: null,
          target: `/projects/${r.projectId}/sessions/${r.sessionId}`,
          via: "app" as const,
        }))
      )
    );
  }

  if (want("note")) {
    const vault = getSettings().vaultDir.trim();
    if (vault) {
      jobs.push(
        api.searchVault(vault, [q], 40).then((rows) =>
          rows.map((r) => ({
            id: `note:${r.rel}`,
            kind: "note" as const,
            name: r.name,
            where: parentOf(r.rel) || "vault",
            snippet: r.snippet,
            date: null,
            size: null,
            // ponytail: opens the markdown in the OS editor. Route it to the
            // in-app Documents viewer once that grows a per-note deep link.
            target: `${vault}\\${r.rel.replace(/\//g, "\\")}`,
            via: "os" as const,
          }))
        )
      );
    }
  }

  if (want("project")) {
    jobs.push(
      api.listProjects().then((rows) =>
        rows
          .filter((p) => has(p.name, q) || has(p.path, q))
          .map((p) => ({
            id: `project:${p.id}`,
            kind: "project" as const,
            name: p.name,
            where: p.path,
            snippet: `${p.sessionCount} sessions · ${p.messageCount} messages`,
            date: ms(p.lastActivity),
            size: p.sizeBytes,
            target: `/projects/${p.id}`,
            via: "app" as const,
          }))
      )
    );
  }

  if (want("document")) {
    jobs.push(
      api.getDocuments().then((docs) => {
        const files = [...docs.plans, ...docs.memory.flatMap((g) => g.docs)];
        return files
          .filter((f) => has(f.name, q) || has(f.path, q))
          .map((f) => ({
            id: `document:${f.path}`,
            kind: "document" as const,
            name: f.name,
            where: parentOf(f.path),
            snippet: f.kind,
            date: ms(f.modified),
            size: f.sizeBytes,
            target: f.path,
            via: "os" as const,
          }));
      })
    );
  }

  if (want("skill")) {
    jobs.push(
      api.getSkills().then((rows) =>
        rows
          .filter((s) => has(s.name, q) || has(s.description, q))
          .map((s) => ({
            id: `skill:${s.id}`,
            kind: "skill" as const,
            name: s.name,
            where: s.domain || "skills",
            snippet: s.description,
            date: ms(s.modified),
            size: s.sizeBytes,
            target: "/skills",
            via: "app" as const,
          }))
      )
    );
  }

  if (want("file")) {
    jobs.push(
      api.searchFiles(q, 40).then((rows) =>
        rows.map((f) => ({
          id: `file:${f.path}`,
          kind: "file" as const,
          name: f.name,
          where: parentOf(f.path),
          date: null,
          size: null,
          target: f.path,
          via: "os" as const,
        }))
      )
    );
  }

  if (want("app")) {
    jobs.push(
      api.listApps().then((rows) =>
        rows
          .filter((a) => has(a.name, q))
          .slice(0, 20)
          .map((a) => ({
            id: `app:${a.path}`,
            kind: "app" as const,
            name: a.name,
            where: parentOf(a.path),
            date: null,
            size: null,
            target: a.path,
            via: "os" as const,
          }))
      )
    );
  }

  if (want("screenshot")) {
    jobs.push(
      api.listScreenshots(getSettings().screenshotDir).then((rows) =>
        rows
          .filter((s) => has(s.name, q))
          .map((s) => ({
            id: `screenshot:${s.name}`,
            kind: "screenshot" as const,
            name: s.name,
            where: parentOf(s.path),
            snippet: `${s.width}×${s.height}`,
            date: s.takenAt,
            size: s.bytes,
            target: s.path,
            via: "os" as const,
          }))
      )
    );
  }

  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Enter: actions do their own work, in-app hits route the main window, OS
 *  hits go to the shell. */
export async function openHit(hit: UniversalHit): Promise<void> {
  if (hit.run) return hit.run();
  if (hit.via === "app") return api.openInMain(hit.target);
  return api.openPath(hit.target);
}

/** Ctrl+Enter: show the file in Explorer. No-op for actions and in-app targets. */
export async function revealHit(hit: UniversalHit): Promise<void> {
  if (!hit.run && hit.via === "os") return api.revealPath(hit.target);
}
