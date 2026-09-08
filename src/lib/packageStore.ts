// Durable state for the Packages page.
//
// Everything on that page is otherwise derived from a rolling 90-day mail scan,
// which means it has no memory: a parcel you've already taken off the doormat
// keeps saying "in transit" until its emails age out, and a pre-order that's
// been pending for months disappears the day its confirmation leaves the
// window. This holds the three things the scan can't know:
//
//   verdicts — you said it's delivered, or that it isn't a package at all
//   archive  — a snapshot of still-open items, so they outlive their email
//
// Same shape as deckStore: module state, localStorage, mirrored to disk so the
// phone sees the same thing.

import { useSyncExternalStore } from "react";
import { mirrorAppState } from "./appState";

export type PackageVerdict = "delivered" | "ignored";

/** Enough of a package to render a row without the email it came from. */
export interface ArchivedPackage {
  id: string;
  carrier: string;
  url: string;
  status: string;
  subject: string;
  date: string;
  image?: string;
  account: string;
  merchant?: string;
  /** When we last saw this in a mail scan — drives the stale cleanup below. */
  seenAt: number;
}

interface Memory {
  verdicts: Record<string, PackageVerdict>;
  archive: Record<string, ArchivedPackage>;
}

const KEY = "cipher-manager.packages";
// Enough for years of ordinary shopping; the cap only exists so a runaway
// matcher can't grow this file without bound.
const MAX_ARCHIVE = 300;
// An open item nobody has confirmed and no email has mentioned for this long
// is almost certainly delivered and forgotten. Drop it rather than nag forever.
const STALE_MS = 180 * 86_400_000;

let mem: Memory = { verdicts: {}, archive: {} };
let listeners: Array<() => void> = [];

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

function load(): Memory {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") {
        return { verdicts: v.verdicts ?? {}, archive: v.archive ?? {} };
      }
    }
  } catch {
    /* corrupt or unavailable — start clean */
  }
  return { verdicts: {}, archive: {} };
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* quota — in-memory still correct for this session */
  }
  disk.onPersist();
  emit();
}

const disk = mirrorAppState(
  "packages",
  (raw) => {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") {
        mem = { verdicts: v.verdicts ?? {}, archive: v.archive ?? {} };
        try {
          localStorage.setItem(KEY, JSON.stringify(mem));
        } catch {
          /* ignore */
        }
        emit();
      }
    } catch {
      /* bad file — keep local */
    }
  },
  () => JSON.stringify(mem)
);

mem = load();

export function usePackageMemory(): Memory {
  return useSyncExternalStore(subscribe, () => mem);
}

export function verdictOf(id: string): PackageVerdict | undefined {
  return mem.verdicts[id];
}

/** Mark delivered / ignored, or pass undefined to put it back in transit. */
export function setVerdict(id: string, verdict: PackageVerdict | undefined): void {
  const next = { ...mem.verdicts };
  if (verdict) next[id] = verdict;
  else delete next[id];
  mem = { ...mem, verdicts: next };
  persist();
}

/**
 * Snapshot the still-open items from a scan so they survive their email
 * ageing out. Delivered and ignored items are deliberately NOT archived —
 * their verdict is the memory, and re-adding them would resurrect rows the
 * user has already dealt with.
 */
export function rememberOpen(items: ArchivedPackage[]): void {
  const now = Date.now();
  const archive: Record<string, ArchivedPackage> = { ...mem.archive };
  for (const it of items) {
    if (mem.verdicts[it.id]) continue;
    archive[it.id] = { ...it, seenAt: now };
  }
  // Drop anything stale, then cap by most-recently-seen.
  const kept = Object.values(archive)
    .filter((a) => now - a.seenAt < STALE_MS && !mem.verdicts[a.id])
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_ARCHIVE);
  const next: Record<string, ArchivedPackage> = {};
  for (const a of kept) next[a.id] = a;

  // Only write when something actually changed — this runs after every scan,
  // and a pointless write would sync to disk and wake the phone each time.
  if (JSON.stringify(next) === JSON.stringify(mem.archive)) return;
  mem = { ...mem, archive: next };
  persist();
}

/** Archived items, newest first. */
export function archivedPackages(): ArchivedPackage[] {
  return Object.values(mem.archive).sort((a, b) => b.date.localeCompare(a.date));
}

/** Forget an item entirely — verdict and archive. */
export function forget(id: string): void {
  const verdicts = { ...mem.verdicts };
  const archive = { ...mem.archive };
  delete verdicts[id];
  delete archive[id];
  mem = { verdicts, archive };
  persist();
}
