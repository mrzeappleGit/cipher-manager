// One place to take a screenshot from, so the page buttons and the global
// Ctrl+Alt+S hotkey behave identically. The backend never reads settings, so
// the screenshot folder is resolved here and passed down as an argument.

import { useEffect, useState } from "react";
import { api } from "../api";
import { getSettings } from "./settings";
import { notify } from "./toast";
import type { Shot } from "../types";

export type ShotMode = "screen" | "window" | "region";

let listeners: Array<() => void> = [];

/** Re-run whenever a shot is taken or deleted (the gallery subscribes). */
export function onShotsChanged(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

export function shotsChanged(): void {
  for (const l of listeners) l();
}

/** Rerender counter — bumped on every capture/delete. */
export function useShotsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onShotsChanged(() => setV((n) => n + 1)), []);
  return v;
}

/**
 * Capture, save, and copy to the clipboard. Returns null when a region drag
 * was cancelled — that's a no-op, not an error, so it stays quiet.
 */
export async function captureShot(mode: ShotMode, title?: string): Promise<Shot | null> {
  try {
    const shot = await api.captureScreenshot(mode, getSettings().screenshotDir, title);
    if (!shot) return null;
    notify.success(`Copied to clipboard · ${shot.name}`);
    shotsChanged();
    return shot;
  } catch (e) {
    notify.error(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
