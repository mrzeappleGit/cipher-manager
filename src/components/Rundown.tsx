import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { isProviderReady, rundown as aiRundown } from "../lib/ai";
import { buildInsights } from "../lib/insights";
import { notifyDesktop } from "../lib/notify";
import {
  buildContext,
  closeRundown,
  deterministicRundown,
  useRundownOpen,
} from "../lib/rundown";
import { getSettings } from "../lib/settings";
import { speak, stopSpeaking } from "../lib/speech";
import { Loading } from "./ui";
import { SpeakButton } from "./SpeakButton";

interface State {
  loading: boolean;
  text: string;
  error: string | null;
}

export function Rundown() {
  const open = useRundownOpen();
  const [state, setState] = useState<State>({ loading: false, text: "", error: null });

  useEffect(() => {
    if (!open) {
      stopSpeaking();
      setState({ loading: false, text: "", error: null });
      return;
    }
    let alive = true;
    setState({ loading: true, text: "", error: null });
    (async () => {
      try {
        const [usage, recent, projects] = await Promise.all([
          api.getUsageStats(),
          api.getRecentSessions(8),
          api.listProjects(),
        ]);
        const insights = buildInsights(usage, projects);
        let text: string;
        if (isProviderReady(getSettings())) {
          try {
            text = await aiRundown(buildContext(usage, recent, insights));
          } catch {
            text = deterministicRundown(usage, recent, insights);
          }
        } else {
          text = deterministicRundown(usage, recent, insights);
        }
        if (!alive) return;
        setState({ loading: false, text, error: null });
        speak("rundown", text);
        if (getSettings().notifications && document.hidden) {
          notifyDesktop("Rundown ready", text.slice(0, 140));
        }
      } catch (e) {
        if (alive) {
          setState({ loading: false, text: "", error: String((e as { message?: string })?.message ?? e) });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    stopSpeaking();
    closeRundown();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-[16px] border border-outline bg-surface-3 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-outline px-5 py-3.5">
          <Sparkles className="h-4 w-4 text-cyan" />
          <span className="flex-1 font-display text-base font-bold text-text">The rundown</span>
          {state.text && <SpeakButton id="rundown" text={state.text} />}
          <button onClick={close} className="text-muted transition-colors hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-5">
          {state.loading ? (
            <Loading label="Compiling your rundown…" />
          ) : state.error ? (
            <div className="text-sm text-error">{state.error}</div>
          ) : (
            <p className="selectable font-body text-[15px] leading-relaxed text-text">{state.text}</p>
          )}
        </div>
      </div>
    </div>
  );
}
