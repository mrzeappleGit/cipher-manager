// Deck strip: what's arriving. Renders nothing at all unless Gmail is
// connected and something is actually in transit — the Deck is a "today"
// surface and an empty package card is noise on every other day.

import { ExternalLink, Receipt, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Card, SectionTitle } from "./ui";
import { loadPackages, packagesConfigured } from "../lib/packages";
import { usePackageMemory } from "../lib/packageStore";
import { useCachedAsync } from "../lib/useAsync";

export function PackagesCard() {
  // Same cache key as the Packages page, so opening one warms the other.
  const { data } = useCachedAsync("packages", loadPackages);
  if (!packagesConfigured()) return null;

  // Respect the same verdicts the page uses — something you've marked
  // delivered or ignored must not reappear on the Deck.
  const mem = usePackageMemory();
  const active = (data?.items ?? []).filter(
    (p) => p.status !== "delivered" && !mem.verdicts[p.id]
  );
  if (active.length === 0) return null;

  const today = active.filter((p) => p.status === "out-for-delivery").length;

  return (
    <div className="mt-6">
      <SectionTitle>
        Arriving{today > 0 ? ` — ${today} today` : ""}
      </SectionTitle>
      <Card className="overflow-hidden p-0">
        {active.slice(0, 4).map((p) => (
          <button
            key={p.id}
            onClick={() => void api.openUrl(p.url).catch(() => {})}
            className="flex w-full items-center gap-3 border-b border-outline px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-2"
          >
            {p.status === "ordered" ? (
              <Receipt className="h-4 w-4 shrink-0 text-violet" strokeWidth={1.9} />
            ) : (
              <Truck
                className={`h-4 w-4 shrink-0 ${
                  p.status === "out-for-delivery" ? "text-cyan" : "text-muted"
                }`}
                strokeWidth={1.9}
              />
            )}
            <span className="min-w-0 flex-1 truncate font-body text-sm text-text">{p.subject}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{p.carrier}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-faint" />
          </button>
        ))}
        {active.length > 4 && (
          <Link
            to="/packages"
            className="block px-4 py-2.5 text-center font-mono text-[11px] text-muted transition-colors hover:text-cyan"
          >
            {active.length - 4} more →
          </Link>
        )}
      </Card>
    </div>
  );
}
