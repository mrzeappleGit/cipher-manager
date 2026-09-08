import { api } from "../api";
import { useCachedAsync } from "../lib/useAsync";
import { formatCompact } from "../lib/format";
import { tokenTotal } from "../types";
import { Card } from "./ui";

/** Live rolling-window token tracker (last 5h / 24h). */
export function RecentActivity() {
  const { data } = useCachedAsync("recentUsage", () => api.getRecentUsage());
  if (!data) return null;

  const t5 = tokenTotal(data.h5.tokens);
  const t24 = tokenTotal(data.h24.tokens);

  return (
    <Card className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className="cm-pulse h-2 w-2 rounded-full bg-cyan"
          style={{ boxShadow: "0 0 8px #00f5ff" }}
        />
        <span className="font-display text-[10.5px] font-bold uppercase tracking-[1.5px] text-muted">
          Live · last 5h
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xl text-cyan">{formatCompact(t5)}</span>
        <span className="font-body text-xs text-muted">tokens</span>
        <span className="font-mono text-xs text-faint">· {data.h5.messageCount} msgs</span>
      </div>

      <div className="ml-auto flex items-baseline gap-2 font-mono text-xs text-muted">
        <span className="font-display text-[10.5px] font-bold uppercase tracking-[1.5px] text-faint">
          Last 24h
        </span>
        <span className="text-text">{formatCompact(t24)}</span>
        <span>tokens</span>
        <span className="text-faint">· {data.h24.messageCount} msgs</span>
      </div>
    </Card>
  );
}
