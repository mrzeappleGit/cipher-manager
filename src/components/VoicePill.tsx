// Voice assistant status pill (bottom-left, above the status bar) + the effect
// that keeps the Rust ear in sync with settings and the meeting recorder.

import { useEffect } from "react";
import { Mic } from "lucide-react";
import { api } from "../api";
import { useMeetingRec } from "../lib/meetingRec";
import { useSettings } from "../lib/settings";
import { syncVoice, useVoice } from "../lib/voice";
import { useSecretPresence } from "../lib/secrets";

export function VoicePill() {
  const { phase, lastHeard } = useVoice();
  const rec = useMeetingRec().phase;
  const s = useSettings();
  const pico = useSecretPresence()["picovoice-key"] === true;

  useEffect(() => {
    void syncVoice(rec !== "idle");
  }, [s.voiceEnabled, s.picovoiceKey, pico, s.wakeKeywordPath, rec]);

  useEffect(() => {
    api.setPttHotkey(s.pttHotkey).catch(() => {});
  }, [s.pttHotkey]);

  if (phase === "off") return null;
  const color =
    phase === "awake"
      ? "#00f5ff"
      : phase === "thinking"
        ? "#c000ff"
        : phase === "speaking"
          ? "#f59e0b"
          : "#2dd4bf";
  const label =
    phase === "awake"
      ? "Listening…"
      : phase === "thinking"
        ? lastHeard
          ? `"${lastHeard}"`
          : "Thinking…"
        : phase === "speaking"
          ? "Speaking"
          : "Cipher";

  return (
    <div
      className="fixed bottom-14 left-4 z-[70] flex items-center gap-2 rounded-full border border-outline bg-surface-2 px-3 py-1.5 shadow-lg"
      title="Voice assistant — say the wake word, then speak"
    >
      <span className="relative flex h-2.5 w-2.5">
        {phase !== "listening" && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: color }}
          />
        )}
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      </span>
      <Mic className="h-3.5 w-3.5 text-muted" />
      <span className="max-w-56 truncate font-mono text-[11px] text-muted">{label}</span>
    </div>
  );
}
