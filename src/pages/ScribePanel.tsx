// The CipherScribe suggestions panel — the Grammarly-style list of every
// issue in the focused field. Its own Tauri window (label "panel"),
// non-activating: clicking a suggestion applies it IN PLACE while the target
// app keeps focus. Rust owns the session; every action below round-trips
// `gen` so a click rendered against stale state is refused (Task 5).
//
// Ported from cipherScribe's panel.js/theme.css `.cs-panel-*` rules, in
// CipherCore tokens instead of that theme.css.

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { api, isTauri } from "../api";
import { Button, cn, IconButton, Panel } from "../components/ui";
import type { Issue } from "../types";
import {
  isUnambiguous,
  REWRITE_STYLES,
  turnOffForApp,
  useNibState,
  usePanelData,
  useTransparentBody,
} from "../lib/scribe";

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "Correctness · Spelling" / "Clarity · Style" — the same two-level tag the
 * browser extension's field panel uses. */
function IssueTag({ kind }: { kind: Issue["kind"] }) {
  const correctness = kind !== "style";
  const label = `${correctness ? "Correctness" : "Clarity"} · ${kind[0].toUpperCase()}${kind.slice(1)}`;
  return (
    <span className={cn("font-mono text-[9px] uppercase tracking-wide", correctness ? "text-cyan" : "text-magenta")}>
      {label}
    </span>
  );
}

export default function ScribePanel() {
  useTransparentBody();
  const { gen, exe, text, issues } = usePanelData();
  // The panel's own status line (finding 3): with `scribeNib` off there is no
  // nib window for `nib_state` to reach, so this window has to render it
  // itself too — otherwise a check in flight or a backend error is invisible
  // (the panel would show the empty-session "looks good" message instead).
  const { status } = useNibState();
  const [showStyles, setShowStyles] = useState(false);

  const fixableCount = issues.filter(isUnambiguous).length;

  // Fire-and-forget: outside the desktop app every one of these rejects with
  // "Only available in the desktop app" (there's no field to apply into), and
  // this window has no Toaster mounted (that's Layout's job, which the nib/
  // panel windows deliberately skip) to show a real failure either way. In
  // the real app, though, a rejection here means the blocking apply task
  // itself panicked (poisoned SESSION mutex, a UIA failure) — exactly the
  // state that leaves the panel silently dead, so surface it there.
  const fire = (p: Promise<void>) => void p.catch((e) => { if (isTauri()) console.error(e); });

  const apply = (index: number, replacementIndex: number) => {
    const replacement = issues[index]?.replacements[replacementIndex];
    if (replacement === undefined) return;
    fire(api.scribeApplyIssue(gen, index, replacement));
  };
  const dismiss = (index: number) => fire(api.scribeDismissIssue(gen, index));
  // Collapse after firing: the rewrite replaces the whole field, so the rows
  // behind the picker are about to be replaced anyway, and leaving it open
  // invites a second click onto text that no longer exists.
  const rewrite = (style: string) => {
    setShowStyles(false);
    fire(api.scribeRewrite(style));
  };
  const turnOff = () => {
    turnOffForApp(exe);
    fire(api.scribeHidePanel());
  };
  const close = () => fire(api.scribeHidePanel());

  const headerLabel =
    status === "checking"
      ? "Checking…"
      : status === "error"
      ? "Backend unreachable"
      : issues.length > 0
      ? `${issues.length} suggestion${issues.length === 1 ? "" : "s"}`
      : "No issues found";

  return (
    <div className="flex h-screen w-screen flex-col bg-transparent p-2">
      <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden border-t-2 border-t-cyan">
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-2.5">
          {/* min-w-0 + truncate so a long label ("BACKEND UNREACHABLE", or a
              double-digit count) gives way instead of shoving Rewrite/Fix all/✕
              out of a 320px window. Safe here where it wasn't on the issue rows:
              this span holds text directly, not flex children. */}
          <span
            className={cn(
              "min-w-0 truncate font-mono text-[10px] uppercase tracking-wide",
              status === "error" ? "text-magenta" : "text-cyan"
            )}
          >
            {headerLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {/* Rewrite acts on the whole field through UI Automation, not on
                the issue list, so it stays available even with nothing flagged
                — "clean" text is exactly when you want to restyle it. */}
            <Button
              variant="ghost"
              className="flex items-center gap-0.5 px-2 py-1 text-[11px]"
              onClick={() => setShowStyles((v) => !v)}
              title="Rewrite the whole field"
            >
              Rewrite
              {showStyles ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
            {fixableCount > 1 && (
              <Button
                variant="primary"
                className="px-2 py-1 text-[11px]"
                onClick={() => fire(api.scribeApplyAll(gen))}
              >
                Fix all ({fixableCount})
              </Button>
            )}
            {/* The only way to dismiss the panel that doesn't require the nib
                (Blocker 1) — the footer's "Turn off" also hides it, but that
                permanently disables checking for this app too. */}
            <IconButton title="Close" onClick={close}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>

        {showStyles && (
          <div className="shrink-0 border-t border-outline px-2 py-1.5">
            <div className="flex flex-wrap gap-1">
              {REWRITE_STYLES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => rewrite(s.value)}
                  className="rounded-md border border-outline px-2 py-1 font-mono text-[10px] text-text transition-colors hover:border-cyan hover:text-cyan"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-1.5">
          {issues.length === 0 ? (
            <div
              className={cn(
                "px-2 py-1 font-body text-[12.5px]",
                status === "checking" ? "text-cyan" : status === "error" ? "text-magenta" : "text-muted"
              )}
            >
              {status === "checking"
                ? "Checking…"
                : status === "error"
                ? "Couldn't reach the backend — check the endpoint and token in Settings."
                : "✓ Your writing looks good."}
            </div>
          ) : (
            issues.map((issue, i) => {
              const word = text.substring(issue.offset, issue.offset + issue.length);
              const primary = issue.replacements[0];
              return (
                <div key={`${issue.offset}-${issue.length}-${i}`}>
                  <div className="flex items-start gap-1">
                    {primary !== undefined ? (
                      <button
                        type="button"
                        title={issue.message}
                        onClick={() => apply(i, 0)}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <IssueTag kind={issue.kind} />
                        {/* clip() rather than `truncate`: this span is a flex
                            container, so ellipsis never fires on it — its
                            children are flex items, not inline content. Left
                            unclipped, the nowrap word overflows and the arrow
                            and replacement get hard-clipped out of view, which
                            is the one thing the row exists to show. */}
                        <span className="flex items-baseline gap-1.5 truncate font-mono text-[12.5px]">
                          <s className="text-faint">{clip(word, 24)}</s>
                          <span className="text-faint">→</span>
                          <span className="font-semibold text-cyan">{clip(primary, 24)}</span>
                        </span>
                      </button>
                    ) : (
                      <div title={issue.message} className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
                        <IssueTag kind={issue.kind} />
                        <span className="truncate font-mono text-[12.5px] text-muted">
                          {clip(word || issue.message, 32)}
                        </span>
                      </div>
                    )}
                    <IconButton title="Dismiss" onClick={() => dismiss(i)}>
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  {issue.replacements.length > 1 && (
                    <div className="flex flex-wrap gap-1 py-1 pl-3">
                      {issue.replacements.slice(1).map((r, ri) => (
                        <button
                          key={`${ri}-${r}`}
                          type="button"
                          onClick={() => apply(i, ri + 1)}
                          className="rounded-md border border-outline px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-cyan/60 hover:text-text"
                        >
                          {clip(r, 18)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="shrink-0 border-t border-outline px-3 py-2">
          <button
            type="button"
            onClick={turnOff}
            className="truncate font-mono text-[11px] text-muted transition-colors hover:text-text"
          >
            Turn off for {exe || "this app"}
          </button>
        </div>
      </Panel>
    </div>
  );
}
