// Push-to-talk mic button: click to record, click again to stop; the
// transcript is handed to the caller. Uses MediaRecorder + the STT proxy.

import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notify } from "../lib/toast";
import { sttProvider, transcribe } from "../lib/stt";
import { Spinner, cn } from "./ui";

export function MicButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<"idle" | "rec" | "busy">("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);

  useEffect(() => () => recRef.current?.stream.getTracks().forEach((t) => t.stop()), []);

  async function toggle() {
    if (state === "busy") return;
    if (state === "rec") {
      recRef.current?.stop();
      return;
    }
    if (!sttProvider()) {
      notify.info("Add an ElevenLabs or OpenAI API key in Settings to use voice input");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        // Whisper hallucinates text (often Korean) on silence — don't send
        // recordings too short or small to contain speech.
        if (Date.now() - startedRef.current < 600 || blob.size < 2000) {
          notify.info("Didn't catch anything — hold the mic a moment longer");
          setState("idle");
          return;
        }
        setState("busy");
        try {
          const text = await transcribe(blob);
          if (text.trim()) onText(text);
        } catch (e) {
          notify.error(e instanceof Error ? e.message : String(e));
        } finally {
          setState("idle");
        }
      };
      rec.start();
      recRef.current = rec;
      startedRef.current = Date.now();
      setState("rec");
    } catch {
      notify.error("Couldn't access the microphone");
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={state === "rec" ? "Stop recording" : "Speak your question"}
      className={cn(
        "shrink-0 rounded-lg border p-2 transition-colors",
        state === "rec"
          ? "border-[#ff0055]/60 text-[#ff0055]"
          : "border-outline text-muted hover:border-cyan/50 hover:text-cyan"
      )}
      style={state === "rec" ? { boxShadow: "0 0 8px rgba(255,0,85,0.5)" } : undefined}
    >
      {state === "busy" ? (
        <Spinner className="h-4 w-4" />
      ) : state === "rec" ? (
        <Square className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );
}
