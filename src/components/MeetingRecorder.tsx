// Meeting recorder UI: a Record button for the Deck header and a global
// floating pill (visible on every page) with the live timer + stop control.

import { Loader2, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CaptureWindow } from "../types";
import {
  chooseCaptureWindow,
  hydrateMeetingRec,
  startMeetingRecording,
  stopMeetingRecording,
  useMeetingRec,
} from "../lib/meetingRec";

function useElapsed(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt === null) return "0:00";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Header button for the Deck — pass the current/next meeting title so the
 * note is named after it. */
export function RecordMeetingButton({ title }: { title?: string }) {
  const rec = useMeetingRec();
  if (rec.phase !== "idle") return null; // the global pill owns the live state
  return (
    <button
      onClick={() => startMeetingRecording(title)}
      title="Record this meeting (mic + system audio) and file a transcript note"
      className="inline-flex items-center gap-1.5 rounded-full border border-outline px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-magenta/60 hover:text-text"
    >
      <Mic className="h-3 w-3" /> record
    </button>
  );
}

/** Floating pill while a recording/transcription is in flight. Global —
 * mounted in App so stop is reachable from any page. */
export function RecordingPill() {
  const rec = useMeetingRec();
  const elapsed = useElapsed(rec.startedAt);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    hydrateMeetingRec();
  }, []);

  if (rec.phase === "idle") return null;
  return (
    <>
      <div className="fixed bottom-4 left-4 z-[90] flex items-center gap-2.5 rounded-full border border-outline bg-surface-2 py-2 pl-3.5 pr-2 shadow-[var(--cm-shadow-3)]">
        {rec.phase === "recording" ? (
          <>
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="font-mono text-xs tabular-nums text-text">{elapsed}</span>
            <span className="hidden font-mono text-[10px] text-faint sm:inline">{rec.sources}</span>
            <button
              onClick={stopMeetingRecording}
              title="Stop and transcribe"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500/15 text-red-400 transition-colors hover:bg-red-500/25"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          </>
        ) : (
          <button
            onClick={() => setShowLog(true)}
            title="Show pipeline log"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan" />
            <span className="pr-1.5 font-body text-xs text-muted">
              {rec.phase === "transcribing" ? "Transcribing…" : "Filing note…"}
            </span>
          </button>
        )}
      </div>
      {showLog && rec.phase !== "recording" && (
        <PipelineLog log={rec.log} onClose={() => setShowLog(false)} />
      )}
      {rec.windows && (
        <WindowPicker
          windows={rec.windows}
          cancelLabel="Skip — audio only"
          onPick={(t) => void chooseCaptureWindow(t)}
        />
      )}
    </>
  );
}

/** Live step log for the transcribe→note pipeline; opened from the pill. */
function PipelineLog({ log, onClose }: { log: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [log.length]);
  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-outline bg-surface-2 p-4 shadow-[var(--cm-shadow-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 font-mono text-xs text-muted">Note pipeline</div>
        <div
          ref={ref}
          className="max-h-[22rem] overflow-y-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-text"
        >
          {log.length ? (
            log.map((l, i) => <div key={i}>{l}</div>)
          ) : (
            <div className="text-faint">nothing yet…</div>
          )}
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg border border-outline px-3 py-2 text-xs text-muted hover:text-text"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** Thumbnail window-picker modal, shared with the Settings test-capture
 * button. onPick(null) = the cancel/skip action. */
export function WindowPicker({
  windows,
  cancelLabel,
  onPick,
}: {
  windows: CaptureWindow[];
  cancelLabel: string;
  onPick: (title: string | null) => void;
}) {
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-outline bg-surface-2 p-4 shadow-[var(--cm-shadow-3)]">
        <div className="mb-2 font-mono text-xs text-muted">Record which window?</div>
        <div className="grid max-h-[26rem] grid-cols-2 gap-2 overflow-y-auto">
          {windows.map((w) => (
            <button
              key={`${w.app}:${w.title}`}
              onClick={() => onPick(w.title)}
              className="overflow-hidden rounded-lg border border-outline text-left transition-colors hover:border-cyan/60"
              title={w.title}
            >
              {w.thumb ? (
                <img
                  src={`data:image/jpeg;base64,${w.thumb}`}
                  alt=""
                  className="aspect-video w-full object-cover object-top"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center bg-black/20 font-mono text-[10px] text-faint">
                  no preview
                </div>
              )}
              <div className="truncate px-2.5 py-1.5 text-xs text-text">
                <span className="text-faint">{w.app}</span> — {w.title}
              </div>
            </button>
          ))}
        </div>
        <button
          onClick={() => onPick(null)}
          className="mt-3 w-full rounded-lg border border-outline px-3 py-2 text-xs text-muted hover:text-text"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
