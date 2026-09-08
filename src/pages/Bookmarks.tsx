// Bookmarks: custom bookmarks (webpages + file-explorer folders, grid or list
// with page snapshots) on top, plus a read-only view over Brave's own bookmark
// files (all profiles) below. Pages open in Brave on desktop; folders open in
// Explorer. Brave's tree is edited in Brave — only custom entries have CRUD.

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  ImagePlus,
  LayoutGrid,
  Pencil,
  List,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api } from "../api";
import { Page } from "../components/Layout";
import { Card, Loading, SectionTitle, Spinner, cn } from "../components/ui";
import { useCachedAsync } from "../lib/useAsync";
import {
  addBookmark,
  bookmarkGroups,
  removeBookmark,
  renameBookmark,
  setBookmarkGroup,
  setBookmarkView,
  toggleGroupCollapsed,
  useBookmarkStore,
} from "../lib/bookmarkStore";
import { notify } from "../lib/toast";
import type { BookmarkNode, CustomBookmark } from "../types";

function countLinks(nodes: BookmarkNode[]): number {
  return nodes.reduce((n, b) => n + (b.children ? countLinks(b.children) : 1), 0);
}

/** Keep pages matching `q` (name or url) and folders whose name matches
 * (kept whole) or that contain a match. */
function filterTree(nodes: BookmarkNode[], q: string): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const n of nodes) {
    if (n.children) {
      if (n.name.toLowerCase().includes(q)) {
        out.push(n);
        continue;
      }
      const kids = filterTree(n.children, q);
      if (kids.length) out.push({ ...n, children: kids });
    } else if (`${n.name} ${n.url ?? ""}`.toLowerCase().includes(q)) {
      out.push(n);
    }
  }
  return out;
}

function err(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

function openPage(url: string): void {
  void api.openInBrave(url).catch((e) => notify.error(err(e)));
}

function openBookmark(b: CustomBookmark): void {
  if (b.kind === "web") openPage(b.target);
  else void api.openPath(b.target).catch((e) => notify.error(err(e)));
}

// --- My bookmarks ------------------------------------------------------------

// Session-lifetime snapshot cache (base64 image per url); "" = failed/none.
const snapCache = new Map<string, string>();

/** User-picked images may be jpg/webp — sniff the base64 magic bytes. */
function snapMime(b64: string): string {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

/** `gen.n` bumps re-fetch; `gen.refresh` additionally retakes the screenshot
 * (false = just reload the cache, e.g. after a custom image was set). */
function Snapshot({ url, gen }: { url: string; gen: { n: number; refresh: boolean } }) {
  const [img, setImg] = useState<string | undefined>(snapCache.get(url));
  useEffect(() => {
    if (gen.n === 0 && snapCache.has(url)) return;
    let alive = true;
    setImg(undefined);
    api
      .snapshotUrl(url, gen.n > 0 && gen.refresh)
      .then((b64) => {
        snapCache.set(url, b64);
        if (alive) setImg(b64);
      })
      .catch(() => {
        snapCache.set(url, "");
        if (alive) setImg("");
      });
    return () => {
      alive = false;
    };
  }, [url, gen]);

  if (img === undefined)
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner className="h-4 w-4" />
      </div>
    );
  if (img === "")
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Globe className="h-8 w-8 text-faint" strokeWidth={1.2} />
      </div>
    );
  return (
    <img src={`data:${snapMime(img)};base64,${img}`} alt="" className="h-full w-full object-cover" />
  );
}

/** Inline rename editor — Enter/blur saves, Escape cancels. */
function NameInput({ b, done, className }: { b: CustomBookmark; done: () => void; className?: string }) {
  const [v, setV] = useState(b.name);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          renameBookmark(b.id, v);
          done();
        }
        if (e.key === "Escape") done();
      }}
      onBlur={() => {
        renameBookmark(b.id, v);
        done();
      }}
      autoFocus
      className={cn(
        "w-full rounded-md border border-cyan/50 bg-bg px-1.5 py-0.5 font-body text-sm text-text outline-none",
        className
      )}
    />
  );
}

/** Move a bookmark between groups: existing groups in a select, "New group…"
 * swaps to a text input. */
function GroupSelect({ b, groups }: { b: CustomBookmark; groups: string[] }) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  if (naming)
    return (
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setBookmarkGroup(b.id, draft);
            setNaming(false);
          }
          if (e.key === "Escape") setNaming(false);
        }}
        onBlur={() => setNaming(false)}
        placeholder="Group name"
        autoFocus
        className="w-28 rounded-md border border-cyan/50 bg-bg px-1.5 py-0.5 font-body text-[11px] text-text outline-none"
      />
    );
  return (
    <select
      value={b.group ?? ""}
      onChange={(e) => {
        if (e.target.value === "__new__") {
          setDraft("");
          setNaming(true);
        } else {
          setBookmarkGroup(b.id, e.target.value);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      title="Group"
      className="w-24 rounded-md border border-outline bg-bg/80 px-1 py-0.5 font-body text-[11px] text-muted outline-none hover:text-text"
    >
      <option value="">No group</option>
      {groups.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
      <option value="__new__">New group…</option>
    </select>
  );
}

function GridTile({ b, groups }: { b: CustomBookmark; groups: string[] }) {
  // Bumping n re-fetches; refresh=true retakes, false reloads the cache.
  const [gen, setGen] = useState({ n: 0, refresh: false });
  const [renaming, setRenaming] = useState(false);
  // Clicking the tile is how a rename gets committed (input blur) — the blur
  // flips `renaming` before the click lands, so remember it from mousedown.
  const skipOpen = useRef(false);
  const pickImage = () => {
    api
      .pickSnapshotImage(b.target)
      .then((set) => {
        if (!set) return;
        snapCache.delete(b.target);
        setGen((g) => ({ n: g.n + 1, refresh: false }));
      })
      .catch((e) => notify.error(err(e)));
  };
  return (
    <div className="group relative overflow-hidden rounded-xl border border-outline bg-surface-1 transition-colors hover:border-cyan/40">
      <button
        onMouseDown={() => {
          skipOpen.current = renaming;
        }}
        onClick={() => {
          if (!renaming && !skipOpen.current) openBookmark(b);
          skipOpen.current = false;
        }}
        className="block w-full text-left"
      >
        <div className="aspect-[8/5] w-full overflow-hidden bg-bg">
          {b.kind === "web" ? (
            <Snapshot url={b.target} gen={gen} />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Folder className="h-10 w-10 text-amber-300/70" strokeWidth={1.2} />
            </div>
          )}
        </div>
        <div className="border-t border-outline px-3 py-2">
          {renaming ? (
            <NameInput b={b} done={() => setRenaming(false)} className="font-semibold" />
          ) : (
            <div className="truncate font-body text-sm font-semibold text-text">{b.name}</div>
          )}
          <div className="truncate font-mono text-[10px] text-faint">
            {b.target.replace(/^https?:\/\/(www\.)?/, "")}
          </div>
        </div>
      </button>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <GroupSelect b={b} groups={groups} />
        <button
          onClick={() => setRenaming(true)}
          title="Rename"
          className="rounded-md border border-outline bg-bg/80 p-1 text-muted hover:text-text"
        >
          <Pencil className="h-3 w-3" />
        </button>
        {b.kind === "web" && (
          <>
            <button
              onClick={() => setGen((g) => ({ n: g.n + 1, refresh: true }))}
              title="Retake snapshot"
              className="rounded-md border border-outline bg-bg/80 p-1 text-muted hover:text-text"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
            <button
              onClick={pickImage}
              title="Use my own image (screenshot the page yourself, then pick the file)"
              className="rounded-md border border-outline bg-bg/80 p-1 text-muted hover:text-text"
            >
              <ImagePlus className="h-3 w-3" />
            </button>
          </>
        )}
        <button
          onClick={() => removeBookmark(b.id)}
          title="Remove bookmark"
          className="rounded-md border border-outline bg-bg/80 p-1 text-muted hover:text-red-400"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function ListRow({ b, groups }: { b: CustomBookmark; groups: string[] }) {
  const [renaming, setRenaming] = useState(false);
  // See GridTile: blur-commit flips `renaming` before the click lands.
  const skipOpen = useRef(false);
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-surface-2">
      <button
        onMouseDown={() => {
          skipOpen.current = renaming;
        }}
        onClick={() => {
          if (!renaming && !skipOpen.current) openBookmark(b);
          skipOpen.current = false;
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {b.kind === "web" ? (
          <Globe className="h-3.5 w-3.5 shrink-0 text-faint group-hover:text-cyan" strokeWidth={1.9} />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300/80" strokeWidth={1.9} />
        )}
        {renaming ? (
          <span className="min-w-0 flex-1">
            <NameInput b={b} done={() => setRenaming(false)} />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-body text-sm text-text">{b.name}</span>
        )}
        <span className="hidden max-w-[40%] truncate font-mono text-[10.5px] text-faint sm:block">
          {b.target.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
        </span>
      </button>
      <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <GroupSelect b={b} groups={groups} />
        <button
          onClick={() => setRenaming(true)}
          title="Rename"
          className="rounded-md p-1 text-faint hover:text-text"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => removeBookmark(b.id)}
          title="Remove bookmark"
          className="rounded-md p-1 text-faint hover:text-red-400"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

function MyBookmarks({ query }: { query: string }) {
  const { items, view, collapsed } = useBookmarkStore();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");

  const groups = bookmarkGroups(items);
  const visible = query
    ? items.filter((b) => `${b.name} ${b.target} ${b.group ?? ""}`.toLowerCase().includes(query))
    : items;
  // Ungrouped first, then each group alphabetically.
  const sections: Array<[string, CustomBookmark[]]> = ["", ...groups]
    .map((g): [string, CustomBookmark[]] => [g, visible.filter((b) => (b.group ?? "") === g)])
    .filter(([, list]) => list.length > 0);

  const addPage = () => {
    let u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    let fallback = u;
    try {
      fallback = new URL(u).hostname.replace(/^www\./, "");
    } catch {
      /* keep full url as name */
    }
    addBookmark(name.trim() || fallback, "web", u, group);
    setUrl("");
    setName("");
    setGroup("");
    setAdding(false);
  };

  const addFolder = () => {
    api
      .pickFolder()
      .then((path) => {
        if (!path) return;
        addBookmark(path.split(/[\\/]/).filter(Boolean).pop() ?? path, "folder", path, group);
      })
      .catch((e) => notify.error(err(e)));
  };

  return (
    <section>
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5">
            <button
              onClick={() => setAdding((v) => !v)}
              title="Bookmark a webpage"
              className="inline-flex items-center gap-1 rounded-lg border border-outline px-2 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text"
            >
              <Plus className="h-3.5 w-3.5" /> Page
            </button>
            <button
              onClick={addFolder}
              title="Bookmark a folder from file explorer"
              className="inline-flex items-center gap-1 rounded-lg border border-outline px-2 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text"
            >
              <FolderPlus className="h-3.5 w-3.5" /> Folder
            </button>
            <span className="mx-1 h-4 w-px bg-outline" />
            <button
              onClick={() => setBookmarkView("grid")}
              title="Grid"
              className={cn("rounded-md p-1", view === "grid" ? "text-cyan" : "text-faint hover:text-text")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setBookmarkView("list")}
              title="List"
              className={cn("rounded-md p-1", view === "list" ? "text-cyan" : "text-faint hover:text-text")}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </span>
        }
      >
        My bookmarks
      </SectionTitle>

      {adding && (
        <Card className="mb-3 flex flex-wrap items-center gap-2 p-3">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPage()}
            placeholder="https://…"
            autoFocus
            className="min-w-[200px] flex-1 rounded-lg border border-outline bg-bg px-3 py-1.5 font-body text-sm text-text outline-none focus:border-cyan"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPage()}
            placeholder="Name (optional)"
            className="w-40 rounded-lg border border-outline bg-bg px-3 py-1.5 font-body text-sm text-text outline-none focus:border-cyan"
          />
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPage()}
            placeholder="Group (optional)"
            list="bm-groups"
            className="w-36 rounded-lg border border-outline bg-bg px-3 py-1.5 font-body text-sm text-text outline-none focus:border-cyan"
          />
          <datalist id="bm-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <button
            onClick={addPage}
            disabled={!url.trim()}
            className="rounded-lg border border-cyan/50 bg-surface-2 px-3 py-1.5 font-body text-sm font-semibold text-text transition-colors hover:border-cyan disabled:opacity-50"
          >
            Add
          </button>
        </Card>
      )}

      {visible.length === 0 ? (
        <Card className="p-5 font-body text-sm text-muted">
          {items.length === 0
            ? "Nothing saved yet — add a webpage or a folder with the buttons above."
            : "No custom bookmarks match."}
        </Card>
      ) : (
        <div className="space-y-5">
          {sections.map(([g, list]) => {
            // A filter match always shows its content, collapsed or not.
            const shown = query.length > 0 || !collapsed.includes(g);
            return (
            <div key={g || "(ungrouped)"}>
              {(g || sections.length > 1) && (
                <button
                  onClick={() => toggleGroupCollapsed(g)}
                  className="mb-2 flex items-center gap-1 font-display text-[11px] font-bold uppercase tracking-[1px] text-muted transition-colors hover:text-text"
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", shown && "rotate-90")}
                    strokeWidth={2.2}
                  />
                  {g || "Ungrouped"}
                  <span className="ml-1 font-mono text-[10px] font-normal text-faint">{list.length}</span>
                </button>
              )}
              {!shown ? null : view === "grid" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {list.map((b) => (
                    <GridTile key={b.id} b={b} groups={groups} />
                  ))}
                </div>
              ) : (
                <Card className="p-2">
                  {list.map((b) => (
                    <ListRow key={b.id} b={b} groups={groups} />
                  ))}
                </Card>
              )}
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// --- Brave tree ----------------------------------------------------------------

function BookmarkRow({ node, depth }: { node: BookmarkNode; depth: number }) {
  return (
    <button
      onClick={() => openPage(node.url!)}
      title={node.url}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
      style={{ paddingLeft: `${10 + depth * 18}px` }}
    >
      <Globe className="h-3.5 w-3.5 shrink-0 text-faint group-hover:text-cyan" strokeWidth={1.9} />
      <span className="min-w-0 flex-1 truncate font-body text-sm text-text">
        {node.name || node.url}
      </span>
      <span className="hidden max-w-[40%] truncate font-mono text-[10.5px] text-faint sm:block">
        {node.url!.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
      </span>
    </button>
  );
}

function FolderRow({
  node,
  depth,
  forceOpen,
  defaultOpen = false,
}: {
  node: BookmarkNode;
  depth: number;
  forceOpen: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = forceOpen || open;
  const kids = node.children ?? [];
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
        style={{ paddingLeft: `${10 + depth * 18}px` }}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-faint transition-transform", shown && "rotate-90")}
          strokeWidth={2}
        />
        {shown ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-300/80" strokeWidth={1.9} />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300/80" strokeWidth={1.9} />
        )}
        <span className="min-w-0 flex-1 truncate font-body text-sm font-semibold text-text">
          {node.name || "(unnamed folder)"}
        </span>
        <span className="font-mono text-[10.5px] text-faint">{countLinks(kids)}</span>
      </button>
      {shown && <Tree nodes={kids} depth={depth + 1} forceOpen={forceOpen} />}
    </div>
  );
}

function Tree({ nodes, depth, forceOpen }: { nodes: BookmarkNode[]; depth: number; forceOpen: boolean }) {
  return (
    <div>
      {nodes.map((n, i) =>
        n.children ? (
          <FolderRow key={`${n.name}-${i}`} node={n} depth={depth} forceOpen={forceOpen} />
        ) : (
          <BookmarkRow key={`${n.url}-${i}`} node={n} depth={depth} />
        )
      )}
    </div>
  );
}

/** One Brave profile's tree — starts collapsed; a filter match opens it. */
function BraveProfile({
  profile,
  roots,
  query,
}: {
  profile: string;
  roots: BookmarkNode[];
  query: string;
}) {
  const [open, setOpen] = useState(false);
  const visible = query ? filterTree(roots, query) : roots;
  if (query && visible.length === 0) return null;
  const shown = open || query.length > 0;
  return (
    <section>
      <SectionTitle
        right={<span className="font-mono text-xs text-faint">{countLinks(roots)} pages</span>}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 transition-colors hover:text-text"
        >
          <ChevronRight
            className={cn("h-3.5 w-3.5 transition-transform", shown && "rotate-90")}
            strokeWidth={2.2}
          />
          Brave — {profile}
        </button>
      </SectionTitle>
      {shown && (
        <Card className="p-2">
          {visible.map((root, i) => (
            <FolderRow
              key={`${root.name}-${i}`}
              node={root}
              depth={0}
              forceOpen={query.length > 0}
              defaultOpen={i === 0}
            />
          ))}
        </Card>
      )}
    </section>
  );
}

export default function BookmarksPage() {
  const { data, error, loading, reload } = useCachedAsync("bookmarks", api.listBookmarks);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const profiles = data ?? [];

  return (
    <Page title="Bookmarks" subtitle="Your bookmarks — pages open in Brave, folders in Explorer">
      <div className="mb-5 flex items-center gap-2">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter bookmarks…"
            className="w-full rounded-lg border border-outline bg-bg py-2 pl-9 pr-3 font-body text-sm text-text outline-none focus:border-cyan"
          />
        </div>
        <button
          onClick={reload}
          title="Re-read from Brave"
          className="inline-flex items-center gap-1.5 rounded-lg border border-outline px-2.5 py-2 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-8">
        <MyBookmarks query={query} />

        {loading && <Loading label="Reading Brave bookmarks…" />}
        {error && (
          <Card className="p-5 font-body text-sm text-muted">
            Couldn't read Brave's bookmarks: {error}
          </Card>
        )}

        {profiles.map((p) => (
          <BraveProfile key={p.profile} profile={p.profile} roots={p.roots} query={query} />
        ))}
        {!loading && !error && profiles.length === 0 && (
          <Card className="p-5 font-body text-sm text-muted">
            No Brave bookmarks found on this PC.
          </Card>
        )}
      </div>
    </Page>
  );
}
