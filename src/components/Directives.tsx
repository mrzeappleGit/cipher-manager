import { CornerDownRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { isProviderReady, suggestFocus } from "../lib/ai";
import { openRundown } from "../lib/rundown";
import { useSettings } from "../lib/settings";
import { useCachedAsync } from "../lib/useAsync";
import { formatRelative } from "../lib/format";
import { notify } from "../lib/toast";
import { Card, SectionTitle, Spinner } from "./ui";

/** "Pick up where you left off": recent sessions + optional AI focus. */
export function Directives() {
  const { data } = useCachedAsync("recentSessions:6", () => api.getRecentSessions(6));
  const settings = useSettings();
  const navigate = useNavigate();
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAI = isProviderReady(settings);

  async function suggest() {
    if (!data) return;
    setBusy(true);
    try {
      const text = await suggestFocus(
        data.map((s) => ({ projectName: s.projectName, title: s.title, firstPrompt: s.firstPrompt }))
      );
      setFocus(text);
    } catch (e) {
      notify.error(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={openRundown}
              className="inline-flex items-center gap-1.5 rounded-full border border-outline bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:border-cyan/50 hover:text-cyan"
            >
              <Sparkles className="h-3 w-3" /> Rundown
            </button>
            {canAI && data && data.length > 0 && (
              <button
                onClick={suggest}
                disabled={busy}
                style={{ background: "linear-gradient(135deg,#c000ff,#ff0055)", boxShadow: "var(--glow-violet)" }}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold text-[#05060a] transition-all hover:brightness-110 disabled:opacity-60"
              >
                {busy ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                Suggest focus
              </button>
            )}
          </div>
        }
      >
        Pick up where you left off
      </SectionTitle>

      {focus && (
        <div
          className="mb-3 flex gap-2 rounded-[10px] border px-3 py-2.5 text-sm leading-relaxed text-text"
          style={{ borderColor: "rgba(192,0,255,0.22)", background: "rgba(192,0,255,0.06)" }}
        >
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet" />
          <div className="selectable whitespace-pre-wrap">{focus}</div>
        </div>
      )}

      {!data ? (
        <div className="py-8 text-center text-sm text-muted">Loading recent sessions…</div>
      ) : data.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted">No recent sessions.</div>
      ) : (
        <div className="space-y-1">
          {data.map((s) => (
            <button
              key={`${s.projectId}/${s.sessionId}`}
              onClick={() => navigate(`/projects/${s.projectId}/sessions/${s.sessionId}`)}
              className="group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-surface-3"
            >
              <CornerDownRight className="h-4 w-4 shrink-0 text-faint transition-colors group-hover:text-cyan" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-body text-[13.5px] text-text">
                  {s.title || s.firstPrompt || "Untitled session"}
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-faint">
                  <span className="text-cyan">{s.projectName}</span>
                  <span>·</span>
                  <span>{formatRelative(s.endTime)}</span>
                  <span>·</span>
                  <span>{s.messageCount} msgs</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
