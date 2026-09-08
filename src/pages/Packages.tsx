// Packages — what's on its way, read off order and shipping mail. Every row
// links out to the carrier's own page; we deliberately don't mirror their
// timeline (see lib/packages.ts for why there's no tracking API here).
//
// The scan is a rolling 90-day window, so the page can't be purely derived
// from it: lib/packageStore.ts holds what you've marked delivered or ignored,
// plus a snapshot of still-open items so a months-long pre-order doesn't
// vanish the day its confirmation email ages out.

import {
  Ban,
  Check,
  ExternalLink,
  PackageCheck,
  PackageSearch,
  Receipt,
  RotateCcw,
  Truck,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Page } from "../components/Layout";
import { Button, Card, EmptyState, ErrorState, Loading, SectionTitle } from "../components/ui";
import { formatRelative } from "../lib/format";
import {
  loadPackages,
  packagesConfigured,
  type PackageStatus,
  type TrackedPackage,
} from "../lib/packages";
import {
  archivedPackages,
  forget,
  rememberOpen,
  setVerdict,
  usePackageMemory,
  type ArchivedPackage,
} from "../lib/packageStore";
import { withToast } from "../lib/toast";
import { useCachedAsync } from "../lib/useAsync";

const LOOK: Record<PackageStatus, { label: string; icon: typeof Truck; cls: string }> = {
  "out-for-delivery": { label: "Out for delivery", icon: Truck, cls: "border-cyan/50 text-cyan" },
  shipped: { label: "In transit", icon: PackageSearch, cls: "border-outline-2 text-muted" },
  ordered: { label: "Awaiting shipment", icon: Receipt, cls: "border-violet/40 text-violet" },
  // Done, so it recedes — the palette has no green to "succeed" with.
  delivered: { label: "Delivered", icon: PackageCheck, cls: "border-outline text-faint" },
};

function Row({
  p,
  showAccount,
  actions,
}: {
  p: TrackedPackage;
  showAccount: boolean;
  actions: React.ReactNode;
}) {
  const look = LOOK[p.status] ?? LOOK.shipped;
  const Icon = look.icon;
  return (
    <Card className="flex items-center gap-4 p-4">
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border bg-surface-2 ${look.cls}`}
      >
        {p.image ? (
          // Lifted from marketing HTML, so the URL can 404 or be hotlink-blocked
          // — swap back to the icon rather than leaving a broken-image glyph.
          <img
            src={p.image}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
              e.currentTarget.nextElementSibling?.classList.remove("hidden");
            }}
          />
        ) : null}
        <Icon className={`h-5 w-5 ${p.image ? "hidden" : ""}`} strokeWidth={1.9} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-body text-sm font-semibold text-text">{p.subject}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted">
          <span className="text-cyan">{p.carrier}</span>
          {/* Only present when a shipment absorbed its order confirmation. */}
          {p.merchant && (
            <>
              <span className="text-outline">/</span>
              <span className="text-violet">{p.merchant}</span>
            </>
          )}
          {p.orderNumber && <span className="text-faint">#{p.orderNumber}</span>}
          <span className="text-outline">/</span>
          <span>{look.label}</span>
          <span className="text-outline">/</span>
          <span>{formatRelative(p.date)}</span>
          {showAccount && p.account && (
            <>
              <span className="text-outline">/</span>
              <span className="truncate text-faint">{p.account}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </Card>
  );
}

function IconAction({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-outline bg-surface-2 text-muted transition-colors hover:border-cyan/60 hover:text-text"
    >
      {children}
    </button>
  );
}

export default function Packages() {
  const { data, error, loading, reload } = useCachedAsync("packages", loadPackages);
  const mem = usePackageMemory();

  const scanned = useMemo(() => data?.items ?? [], [data]);

  // Snapshot open items so they outlive their email. Runs after each scan;
  // rememberOpen no-ops when nothing changed, so this doesn't churn the disk.
  useEffect(() => {
    if (!scanned.length) return;
    rememberOpen(
      scanned
        .filter((p) => p.status !== "delivered")
        .map((p) => ({ ...p, seenAt: Date.now() }) as ArchivedPackage)
    );
  }, [scanned]);

  const { active, delivered, ignored, accounts } = useMemo(() => {
    const byId = new Map<string, TrackedPackage>();
    // Archive first so a fresh scan overwrites it with better data.
    for (const a of archivedPackages()) byId.set(a.id, a as unknown as TrackedPackage);
    for (const p of scanned) byId.set(p.id, p);

    const all = [...byId.values()];
    const rank: Record<string, number> = {
      "out-for-delivery": 0,
      shipped: 1,
      ordered: 2,
      delivered: 3,
    };
    const sorted = all.sort(
      (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.date.localeCompare(a.date)
    );
    return {
      accounts: data?.accounts ?? [],
      active: sorted.filter((p) => !mem.verdicts[p.id] && p.status !== "delivered"),
      delivered: sorted.filter(
        (p) => mem.verdicts[p.id] === "delivered" || (!mem.verdicts[p.id] && p.status === "delivered")
      ),
      ignored: sorted.filter((p) => mem.verdicts[p.id] === "ignored"),
    };
  }, [scanned, mem, data]);

  if (!packagesConfigured()) {
    return (
      <Page title="Packages" subtitle="Shipment tracking from your order and shipping mail">
        <EmptyState
          icon={PackageSearch}
          title="No mailbox connected"
          hint="Packages are read from the order and shipping mail already in your inbox — no tracking API, no carrier accounts. Connect Gmail (read-only) or Proton Bridge to switch this on."
        >
          <Link to="/settings">
            <Button variant="primary">Open Settings</Button>
          </Link>
        </EmptyState>
      </Page>
    );
  }

  if (loading && !scanned.length) return <Loading label="Reading order and shipping mail…" />;
  if (error && !scanned.length) return <ErrorState message={error} onRetry={reload} />;

  const waiting = active.filter((p) => p.status === "ordered").length;
  const mailbox = accounts.length ? ` · reading ${accounts.join(", ")}` : "";
  const open = (p: TrackedPackage) => withToast(api.openUrl(p.url), { error: "Couldn't open link" });

  return (
    <Page
      title="Packages"
      subtitle={`${active.length - waiting} in transit · ${waiting} awaiting shipment${mailbox}`}
      actions={
        <Button variant="subtle" onClick={reload}>
          Refresh
        </Button>
      }
    >
      {(data?.errors.length ?? 0) > 0 && (
        <Card className="mb-3 border-warn/40 p-4">
          <div className="mb-1 font-body text-sm font-semibold text-warn">
            Some mailboxes didn&apos;t answer
          </div>
          <ul className="space-y-1">
            {data?.errors.map((e) => (
              <li key={e} className="font-mono text-[11px] leading-relaxed text-muted">
                {e}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {active.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="Nothing on its way"
          hint="Nothing in the last 90 days of mail matched a carrier or an order confirmation."
        />
      ) : (
        <div className="space-y-2">
          {active.map((p) => (
            <Row
              key={p.id}
              p={p}
              showAccount={accounts.length > 1}
              actions={
                <>
                  <IconAction onClick={() => setVerdict(p.id, "delivered")} title="Mark delivered">
                    <Check className="h-4 w-4" />
                  </IconAction>
                  <IconAction
                    onClick={() => setVerdict(p.id, "ignored")}
                    title="Not a package — ignore this"
                  >
                    <Ban className="h-4 w-4" />
                  </IconAction>
                  <button
                    onClick={() => open(p)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-outline bg-surface-2 px-3 py-2 font-body text-xs font-semibold text-text transition-colors hover:border-cyan/60"
                  >
                    {p.status === "ordered" ? "Email" : "Track"}{" "}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}

      {delivered.length > 0 && (
        <div className="mt-6">
          <SectionTitle>Delivered</SectionTitle>
          <div className="space-y-2">
            {delivered.map((p) => (
              <Row
                key={p.id}
                p={{ ...p, status: "delivered" }}
                showAccount={accounts.length > 1}
                actions={
                  <IconAction onClick={() => setVerdict(p.id, undefined)} title="Put back in transit">
                    <RotateCcw className="h-4 w-4" />
                  </IconAction>
                }
              />
            ))}
          </div>
        </div>
      )}

      {ignored.length > 0 && (
        <div className="mt-6">
          <SectionTitle>Ignored</SectionTitle>
          <p className="mb-2 font-body text-xs text-muted">
            Not packages. They stay hidden from the list above; the matcher will keep finding them,
            so this is the record of what you&apos;ve told it to skip.
          </p>
          <div className="space-y-2">
            {ignored.map((p) => (
              <Row
                key={p.id}
                p={p}
                showAccount={accounts.length > 1}
                actions={
                  <IconAction onClick={() => forget(p.id)} title="Stop ignoring">
                    <RotateCcw className="h-4 w-4" />
                  </IconAction>
                }
              />
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
