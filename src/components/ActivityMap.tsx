import { useMemo } from "react";
import { tokenTotal, type DayUsage } from "../types";
import { formatCompact, formatDate } from "../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CELL = 12;
const GAP = 3;

// Cyan intensity buckets (index 0 = empty day).
const LEVEL_BG = [
  "var(--color-surface-2)",
  "rgba(0,245,255,0.18)",
  "rgba(0,245,255,0.36)",
  "rgba(0,245,255,0.60)",
  "rgba(0,245,255,0.92)",
];

interface Cell {
  key: string;
  date: Date;
  val: number;
  inRange: boolean;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function fmtKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDay(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function level(v: number, max: number): number {
  if (v <= 0) return 0;
  const r = v / max;
  if (r > 0.66) return 4;
  if (r > 0.4) return 3;
  if (r > 0.15) return 2;
  return 1;
}

/** GitHub-style calendar heatmap of daily token usage. */
export function ActivityMap({ data }: { data: DayUsage[] }) {
  const built = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of data) map.set(d.day, tokenTotal(d.tokens));
    const keys = data.map((d) => d.day).filter(Boolean).sort();
    if (keys.length === 0) return null;

    const first = parseDay(keys[0]);
    const last = parseDay(keys[keys.length - 1]);
    // Pad to whole weeks (Sun … Sat).
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(last);
    end.setDate(end.getDate() + (6 - end.getDay()));

    const weeks: Cell[][] = [];
    const cur = new Date(start);
    while (cur <= end) {
      const week: Cell[] = [];
      for (let i = 0; i < 7; i++) {
        const key = fmtKey(cur);
        week.push({
          key,
          date: new Date(cur),
          val: map.get(key) ?? 0,
          inRange: cur >= first && cur <= last,
        });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(week);
    }

    let max = 1;
    for (const v of map.values()) max = Math.max(max, v);

    // Month labels: mark the week where a new month first appears.
    const monthLabels = weeks.map((w, i) => {
      const m = w[0].date.getMonth();
      const prev = i > 0 ? weeks[i - 1][0].date.getMonth() : -1;
      return m !== prev ? MONTHS[m] : "";
    });

    const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
    const activeDays = Array.from(map.values()).filter((v) => v > 0).length;
    return { weeks, max, monthLabels, total, activeDays };
  }, [data]);

  if (!built) {
    return <div className="py-10 text-center text-sm text-muted">No dated activity yet.</div>;
  }

  const { weeks, max, monthLabels, total, activeDays } = built;
  const colW = CELL + GAP;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 font-mono text-[11px] text-muted">
        <span className="text-cyan">{formatCompact(total)}</span> tokens over
        <span className="text-text">{activeDays}</span> active days
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-block">
          {/* Month labels */}
          <div className="flex" style={{ paddingLeft: 26 }}>
            {monthLabels.map((m, i) => (
              <div
                key={i}
                className="font-mono text-[10px] text-muted"
                style={{ width: colW, minWidth: colW }}
              >
                {m}
              </div>
            ))}
          </div>

          <div className="flex">
            {/* Weekday labels */}
            <div
              className="mr-1.5 flex flex-col"
              style={{ gap: GAP, width: 20, paddingTop: 2 }}
            >
              {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
                <div
                  key={i}
                  className="font-mono text-[9px] leading-none text-faint"
                  style={{ height: CELL, lineHeight: `${CELL}px` }}
                >
                  {d}
                </div>
              ))}
            </div>

            {/* Cell grid (column per week) */}
            <div
              style={{
                display: "grid",
                gridAutoFlow: "column",
                gridTemplateRows: `repeat(7, ${CELL}px)`,
                gap: GAP,
              }}
            >
              {weeks.flatMap((w) =>
                w.map((cell) => {
                  const lv = level(cell.val, max);
                  return (
                    <div
                      key={cell.key}
                      title={
                        cell.inRange
                          ? `${formatDate(cell.key)} · ${cell.val > 0 ? formatCompact(cell.val) + " tokens" : "no activity"}`
                          : undefined
                      }
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 3,
                        background: cell.inRange ? LEVEL_BG[lv] : "transparent",
                        border: cell.inRange ? "1px solid var(--color-outline)" : "none",
                        boxShadow: lv >= 3 ? "0 0 6px rgba(0,245,255,0.35)" : undefined,
                      }}
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="mt-3 flex items-center justify-end gap-1.5 font-mono text-[10px] text-faint">
            <span>Less</span>
            {LEVEL_BG.map((bg, i) => (
              <span
                key={i}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 3,
                  background: bg,
                  border: "1px solid var(--color-outline)",
                }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </div>
  );
}
