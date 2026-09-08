// Global assistant ("Jarvis"): floating button → panel with text + voice input.
// Routing lives in lib/assistant.ts; voice queries speak their answers back.

import { ArrowRight, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { askAssistant, type AssistantReply } from "../lib/assistant";
import { runTextCommand } from "../lib/voice";
import { webSearch } from "../lib/ai";
import { api } from "../api";
import { speak } from "../lib/speech";
import { MicButton } from "./MicButton";
import { SpeakButton } from "./SpeakButton";
import { Spinner } from "./ui";

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"ask" | "web" | "do">("ask");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AssistantReply | null>(null);

  async function run(q: string, spoken: boolean) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setReply(null);
    try {
      if (mode === "do") {
        // Same router the wake word uses: record, scripts, to-dos, agenda,
        // Home Assistant, recall, or a Claude job for anything else.
        const out = await runTextCommand(text);
        setReply({ text: out || "Done." });
        setQuery("");
      } else if (mode === "web") {
        const { text: answer, sources } = await webSearch(text);
        setReply({ text: answer, sources });
        if (spoken) speak("assistant", answer);
      } else {
        const r = await askAssistant(text);
        setReply(r);
        if (spoken) speak("assistant", r.text);
      }
    } catch (e) {
      setReply({ text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Assistant"
        className="fixed bottom-4 right-4 z-[90] flex h-11 w-11 items-center justify-center rounded-full border border-cyan/40 bg-surface-2 text-cyan shadow-[var(--cm-shadow-3)] transition-transform hover:scale-105"
        style={{ boxShadow: "0 0 12px rgba(0,245,255,0.25)" }}
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[90] w-[min(22rem,calc(100vw-2rem))] rounded-[14px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-3)]">
      <div className="flex items-center gap-2 border-b border-outline px-4 py-2.5">
        <Sparkles className="h-4 w-4 text-cyan" />
        <span className="font-body text-sm font-semibold text-text">Assistant</span>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-outline bg-surface-1 p-0.5">
          {(["ask", "web", "do"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={
                "rounded-md px-2.5 py-1 font-body text-[11px] font-semibold capitalize transition-colors " +
                (mode === m ? "bg-cyan/20 text-cyan" : "text-muted hover:text-text")
              }
              title={
                m === "do"
                  ? "Run a task (same actions as the wake word)"
                  : m === "web"
                    ? "Search the web (cited answer)"
                    : "Ask a question about your work"
              }
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg p-1 text-muted transition-colors hover:text-cyan"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(query, false);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            placeholder={
              mode === "do"
                ? "Turn off the office lights… add a to-do… summarize yesterday"
                : mode === "web"
                  ? "Search the web… latest on X… what's the price of Y?"
                  : "Give me the rundown… what's my day look like?"
            }
            className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 font-body text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
          />
          <MicButton
            onText={(t) => {
              setQuery(t);
              run(t, true);
            }}
          />
          <button
            type="submit"
            disabled={busy || !query.trim()}
            title="Ask"
            className="shrink-0 rounded-lg border border-outline p-2 text-muted transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40"
          >
            {busy ? <Spinner className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
          </button>
        </form>
        {reply && (
          <div className="mt-3 rounded-lg border border-outline bg-surface-1 px-3 py-2.5">
            <p className="selectable whitespace-pre-wrap font-body text-[13px] leading-relaxed text-text">
              {reply.text}
            </p>
            {reply.sources && reply.sources.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-outline pt-2">
                {reply.sources.slice(0, 5).map((src, i) => (
                  <button
                    key={i}
                    onClick={() => void api.openUrl(src.url).catch(() => {})}
                    className="block w-full truncate text-left text-[11px] text-cyan/80 transition-colors hover:text-cyan"
                    title={src.url}
                  >
                    {i + 1}. {src.title}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-3">
              <SpeakButton id="assistant" text={reply.text} />
              {reply.link && (
                <button
                  onClick={() => {
                    window.location.hash = reply.link!.hash;
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-cyan"
                >
                  <ArrowRight className="h-3 w-3" /> {reply.link.label}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
