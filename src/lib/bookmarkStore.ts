// Custom bookmarks (webpages + local file-explorer folders) and the grid/list
// view preference. Same pattern as deckStore: module state + localStorage,
// mirrored to ~/.claude/cipher-manager so the phone shares the list.

import { useSyncExternalStore } from "react";
import { mirrorAppState } from "./appState";
import type { CustomBookmark } from "../types";

export type BookmarkView = "grid" | "list";

interface BookmarkState {
  items: CustomBookmark[];
  view: BookmarkView;
  /** Collapsed group names ("" = the ungrouped section). */
  collapsed: string[];
}

const KEY = "cipher-manager.bookmarks";

let state: BookmarkState = load();
let listeners: Array<() => void> = [];
let seq = 0;

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

function sanitize(v: unknown): BookmarkState {
  const o = (v ?? {}) as Partial<BookmarkState>;
  return {
    items: Array.isArray(o.items) ? o.items : [],
    view: o.view === "list" ? "list" : "grid",
    collapsed: Array.isArray(o.collapsed) ? o.collapsed.filter((g) => typeof g === "string") : [],
  };
}

function load(): BookmarkState {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return { items: [], view: "grid", collapsed: [] };
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  disk.onPersist();
  emit();
}

const disk = mirrorAppState(
  "bookmarks",
  (raw) => {
    try {
      state = sanitize(JSON.parse(raw));
      try {
        localStorage.setItem(KEY, raw);
      } catch {
        /* ignore */
      }
      emit();
    } catch {
      /* bad file — keep local */
    }
  },
  () => JSON.stringify(state)
);

export function addBookmark(
  name: string,
  kind: CustomBookmark["kind"],
  target: string,
  group = ""
): void {
  const t = target.trim();
  if (!t) return;
  if (state.items.some((b) => b.target === t)) return; // already bookmarked
  const item: CustomBookmark = {
    id: `bm${Date.now()}_${seq++}`,
    name: name.trim() || t,
    kind,
    target: t,
    group: group.trim() || undefined,
    addedMs: Date.now(),
  };
  state = { ...state, items: [item, ...state.items] };
  persist();
}

export function renameBookmark(id: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  state = {
    ...state,
    items: state.items.map((b) => (b.id === id ? { ...b, name: n } : b)),
  };
  persist();
}

export function toggleGroupCollapsed(group: string): void {
  state = {
    ...state,
    collapsed: state.collapsed.includes(group)
      ? state.collapsed.filter((g) => g !== group)
      : [...state.collapsed, group],
  };
  persist();
}

export function setBookmarkGroup(id: string, group: string): void {
  const g = group.trim() || undefined;
  state = {
    ...state,
    items: state.items.map((b) => (b.id === id ? { ...b, group: g } : b)),
  };
  persist();
}

/** Distinct group names in use, alphabetical. */
export function bookmarkGroups(items: CustomBookmark[]): string[] {
  return [...new Set(items.map((b) => b.group ?? "").filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function removeBookmark(id: string): void {
  state = { ...state, items: state.items.filter((b) => b.id !== id) };
  persist();
}

export function setBookmarkView(view: BookmarkView): void {
  state = { ...state, view };
  persist();
}

const get = () => state;
export function useBookmarkStore(): BookmarkState {
  return useSyncExternalStore(subscribe, get, get);
}
