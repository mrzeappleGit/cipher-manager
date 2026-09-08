// The CipherScribe status nib — a small always-on-top pen-light that docks to
// the focused field. Its own Tauri window (label "nib"), non-activating, so
// clicking it never steals focus from whatever's being edited. States ported
// from cipherScribe's nib.js/theme.css, re-expressed in CipherCore tokens.

import { PenLine } from "lucide-react";
import { api, isTauri } from "../api";
import { cn } from "../components/ui";
import { type NibStatus, useNibState, useTransparentBody } from "../lib/scribe";

const TITLE: Record<NibStatus, string> = {
  idle: "CipherScribe",
  checking: "CipherScribe — checking…",
  clean: "CipherScribe — no issues",
  issues: "CipherScribe — suggestions",
  error: "CipherScribe — backend unreachable",
};

// idle/clean: dim cyan. checking: brighter cyan, spinning icon. issues:
// magenta, pulsing. error: muted gray, no pulse.
const STYLE: Record<NibStatus, string> = {
  idle: "border-cyan/30 text-cyan/70",
  clean: "border-cyan/30 text-cyan/70",
  checking: "border-cyan/60 text-cyan",
  issues: "border-magenta text-magenta animate-pulse",
  error: "border-outline-2 text-muted",
};

export default function ScribeNib() {
  useTransparentBody();
  const { status, count } = useNibState();

  const badge = status === "issues" && count > 0;

  return (
    // The button IS the window (h/w-screen), not a pill centred inside a
    // roomier one. The nib window is transparent but NOT click-through, so
    // every pixel of it eats clicks from whatever it's docked over — and it
    // docks to the field's bottom-right corner, which is where an app's
    // send/submit button tends to live. So this stays exactly ONE glyph wide
    // in every state: the count replaces the pen rather than sitting beside
    // it, which is what used to force the window wide enough to cover that
    // button. Exact count is in the tooltip. Keep NIB_SIZE
    // (src-tauri/src/scribe/mod.rs) matched to one glyph plus its border.
    <button
      type="button"
      onClick={() => void api.scribeTogglePanel().catch((e) => { if (isTauri()) console.error(e); })}
      title={badge ? `${TITLE.issues} (${count})` : TITLE[status]}
      className={cn(
        "flex h-screen w-screen items-center justify-center overflow-hidden rounded-[7px] border bg-surface-1 font-mono text-[11px] leading-none transition-colors hover:brightness-125",
        STYLE[status]
      )}
    >
      {badge ? (
        <span>{count > 9 ? "9+" : count}</span>
      ) : (
        <PenLine className={cn("h-3.5 w-3.5", status === "checking" && "animate-spin")} strokeWidth={1.8} />
      )}
    </button>
  );
}
