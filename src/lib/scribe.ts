// Shared state + helpers for CipherScribe's two overlay windows (nib, panel —
// see windowRole() in App.tsx). Both windows load index.html and are driven
// entirely by Rust: this module just listens for the events Rust pushes and
// routes the panel footer's one setting write to the window that can safely
// make it, so ScribeNib.tsx and ScribePanel.tsx stay pure rendering.
//
// Both events come from `scribe/live.rs`'s watcher loop, which only runs while
// `settings.scribeNib` is on; outside a real check these hooks return their
// idle defaults. Payload shapes mirror cipherScribe's own nib.js/panel.js
// contract (`nib_state: {status, count}`, `panel_data: {gen, exe, text,
// issues}`) — `text` is the checked snapshot and every issue offset is a
// UTF-16 offset into exactly that string.
//
// LOAD-BEARING, not a footnote: Rust MUST re-emit `panel_data` after every
// successful apply, apply-all, AND dismiss — not only after a check
// completes. `do_apply` and `dismiss_issue` (src-tauri/src/scribe/mod.rs)
// both bump the session's `gen` on success, and every action the panel sends
// carries the `gen` it was rendered against. If only the check loop emitted
// `panel_data`, the panel's cached `gen` would go stale the instant one
// action succeeds: every subsequent click round-trips a now-old `gen`, Rust
// silently refuses it as stale, and the panel looks frozen — no error, no
// visual change, no console trace. `live::emit_after_action` is what closes
// this; the three apply commands all end in it.

import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { isTauri } from "../api";
import type { Issue } from "../types";
import { getSettings, setSettings, type AppSettings } from "./settings";

/** Status the nib's pen-light renders. "clean" and "idle" look identical
 * (dim cyan, no count) — the reference nib.js gives them separate tooltip
 * text, which is the only reason both exist. */
/** The rewrite styles, in the order both the Settings dropdown and the panel's
 *  picker show them. `value` is the wire code the endpoint accepts — the
 *  labels are display only, so "L33t" must never reach the server. Mirrored by
 *  `REWRITE_STYLES` in src-tauri/src/scribe/mod.rs, which rejects anything
 *  outside this set. */
export const REWRITE_STYLES: Array<{ value: AppSettings["scribeRewriteStyle"]; label: string }> = [
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
  { value: "concise", label: "Concise" },
  { value: "expand", label: "Expand" },
  { value: "leet", label: "L33t" },
  // Turns the field into a better prompt for an AI assistant rather than
  // answering it. Shipped by the standalone app and the browser extension
  // (cipherScribe 40e7888); the fold-in's plan pinned only the first five, so
  // this was missing until it was put back.
  { value: "prompt", label: "Improve prompt" },
];

export type NibStatus = "idle" | "checking" | "clean" | "issues" | "error";

export interface NibState {
  status: NibStatus;
  count: number;
}

/** The focused field's live session, as Rust's live loop (Task 8) will push it. */
export interface PanelData {
  gen: number;
  exe: string;
  text: string;
  issues: Issue[];
}

const NIB_IDLE: NibState = { status: "idle", count: 0 };
const PANEL_EMPTY: PanelData = { gen: 0, exe: "", text: "", issues: [] };

/** Subscribe to one Tauri event, with an idle default for pure-browser dev
 * (`#/nib` / `#/panel`) where there's no backend to ever emit it. */
function useScribeEvent<T>(event: string, initial: T): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void listen<T>(event, (e) => setValue(e.payload)).then((u) => (un = u));
    return () => un?.();
  }, [event]);
  return value;
}

export const useNibState = (): NibState => useScribeEvent("nib_state", NIB_IDLE);
export const usePanelData = (): PanelData => useScribeEvent("panel_data", PANEL_EMPTY);

/** Issues eligible for one-click auto-fix — mirrors Rust's `Issue::unambiguous`
 * exactly (objectively wrong, not style advice, with a suggestion). */
export function isUnambiguous(issue: Issue): boolean {
  return issue.kind !== "style" && issue.replacements.length > 0;
}

/** How the panel window asks the main window to persist a disabled app. */
export const DISABLE_APP_EVENT = "scribe-disable-app";

/** Panel footer action: stop live checking `exe` from now on.
 *
 * The panel must NOT write the setting itself. Settings are a module-level
 * cache per webview (see CLAUDE.md): a write from this window never reaches
 * the main window, whose next write then clobbers it — the button would look
 * like it did nothing. So hand it over instead; ScribeRunner in the main
 * window owns the write and the push to Rust's watcher. */
export function turnOffForApp(exe: string): void {
  if (exe) void emit(DISABLE_APP_EVENT, exe);
}

/** The other half of `turnOffForApp` — main window only. */
export function disableAppInSettings(exe: string): void {
  const list = getSettings().scribeDisabledApps;
  if (exe && !list.includes(exe)) setSettings({ scribeDisabledApps: [...list, exe] });
}

/** Both overlay windows are built `transparent(true)` in Rust, but the shared
 * index.css paints an opaque gradient on `body` for the main window. Override
 * it for these two windows only. */
export function useTransparentBody(): void {
  useEffect(() => {
    document.body.style.background = "transparent";
  }, []);
}
