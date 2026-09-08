import { RefreshCw, Twitch, Youtube } from "lucide-react";
import { Card, SectionTitle, Spinner } from "./ui";
import { useCachedAsync } from "../lib/useAsync";
import { useSettings } from "../lib/settings";
import { creatorConfigured, fetchCreatorStats } from "../lib/creator";
import { formatCompact } from "../lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-lg font-semibold tabular-nums text-text">{value}</div>
      <div className="text-[11px] uppercase tracking-[0.5px] text-faint">{label}</div>
    </div>
  );
}

/** Twitch/YouTube channel stats — shown only once credentials are set in Settings. */
export function CreatorCard() {
  useSettings(); // re-render when credentials get added/removed
  const configured = creatorConfigured();
  const { data, error, loading, reload } = useCachedAsync(
    "creatorStats",
    fetchCreatorStats
  );

  if (!configured) return null;

  return (
    <Card className="mt-4 p-5">
      <SectionTitle
        right={
          <button
            onClick={reload}
            className="text-faint transition-colors hover:text-text"
            title="Refresh stats"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        }
      >
        Channel stats
      </SectionTitle>

      {loading && <Spinner className="my-4 h-5 w-5" />}
      {error && <div className="py-2 text-sm text-muted">{error}</div>}

      {data && (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {data.twitch && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Twitch className="h-4 w-4 text-[#a970ff]" strokeWidth={1.9} />
                <span className="text-sm font-semibold text-text">{data.twitch.displayName}</span>
                {data.twitch.live ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.5px] text-red-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                    Live · {formatCompact(data.twitch.viewers ?? 0)} watching
                  </span>
                ) : (
                  <span className="rounded-full border border-outline px-2 py-0.5 text-[11px] uppercase tracking-[0.5px] text-faint">
                    Offline
                  </span>
                )}
              </div>
              {data.twitch.live && (
                <div className="mb-2 text-sm text-muted">
                  <span className="text-fg">{data.twitch.title}</span>
                  {data.twitch.game && <span className="text-faint"> — {data.twitch.game}</span>}
                </div>
              )}
              {(data.twitch.followers !== undefined || data.twitch.subs !== undefined) && (
                <div className="mb-3 flex gap-6">
                  {data.twitch.followers !== undefined && (
                    <Stat label="Followers" value={formatCompact(data.twitch.followers)} />
                  )}
                  {data.twitch.subs !== undefined && (
                    <Stat
                      label="Subscribers"
                      value={
                        formatCompact(data.twitch.subs) +
                        (data.twitch.subPoints ? ` · ${formatCompact(data.twitch.subPoints)} pts` : "")
                      }
                    />
                  )}
                </div>
              )}
              {data.twitch.vods.length > 0 && (
                <div className="space-y-1.5">
                  {!data.twitch.live && (
                    <div className="text-[11px] uppercase tracking-[0.5px] text-faint">
                      Recent broadcasts
                    </div>
                  )}
                  {data.twitch.vods.map((v) => (
                    <div key={v.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate text-muted">{v.title}</span>
                      <span className="shrink-0 tabular-nums text-faint">
                        {formatCompact(v.views)} views
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {data.youtube && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Youtube className="h-4 w-4 text-[#ff4d4d]" strokeWidth={1.9} />
                <span className="text-sm font-semibold text-text">YouTube</span>
              </div>
              <div className="flex gap-6">
                <Stat label="Subscribers" value={formatCompact(data.youtube.subs)} />
                <Stat label="Total views" value={formatCompact(data.youtube.views)} />
                <Stat label="Videos" value={formatCompact(data.youtube.videos)} />
              </div>
              {data.youtube.analytics && (
                <div className="mt-3 flex gap-6 border-t border-outline pt-3">
                  <Stat
                    label={`Views · ${data.youtube.analytics.days}d`}
                    value={formatCompact(data.youtube.analytics.views)}
                  />
                  <Stat
                    label={`Watch hours · ${data.youtube.analytics.days}d`}
                    value={formatCompact(Math.round(data.youtube.analytics.minutes / 60))}
                  />
                </div>
              )}
              {data.youtube.latest.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {data.youtube.latest.map((v) => (
                    <div key={v.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate text-muted">{v.title}</span>
                      <span className="shrink-0 tabular-nums text-faint">
                        {formatCompact(v.views)} views
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {data && data.errors.length > 0 && (
        <div className="mt-3 space-y-0.5 border-t border-outline pt-2">
          {data.errors.map((e) => (
            <div key={e} className="text-xs text-warn">
              {e}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
