import { Square, Volume2 } from "lucide-react";
import { speak, speechSupported, stopSpeaking, useSpeakingId } from "../lib/speech";

/** A small play/stop toggle that reads `text` aloud via the Web Speech API. */
export function SpeakButton({
  id,
  text,
  label,
  className,
}: {
  id: string;
  text: string;
  label?: string;
  className?: string;
}) {
  const speakingId = useSpeakingId();
  if (!speechSupported()) return null;
  const active = speakingId === id;
  return (
    <button
      onClick={() => (active ? stopSpeaking() : speak(id, text))}
      className={
        "inline-flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-cyan " +
        (className ?? "")
      }
    >
      {active ? <Square className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
      {label ?? (active ? "Stop" : "Play")}
    </button>
  );
}
