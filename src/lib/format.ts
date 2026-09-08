import { formatDistanceToNow, format, parseISO } from "date-fns";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact number: 1234 -> 1.2K, 3_400_000 -> 3.4M */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return `${n}`;
  const units = [
    { v: 1e12, s: "T" },
    { v: 1e9, s: "B" },
    { v: 1e6, s: "M" },
    { v: 1e3, s: "K" },
  ];
  for (const u of units) {
    if (Math.abs(n) >= u.v) {
      const val = n / u.v;
      return `${val >= 100 ? Math.round(val) : val.toFixed(1)}${u.s}`;
    }
  }
  return `${n}`;
}

export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${formatCompact(n)}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy · h:mm a");
  } catch {
    return "—";
  }
}

export function formatDay(day: string): string {
  if (!day || day === "unknown") return "Undated";
  try {
    return format(parseISO(day), "EEEE, MMM d, yyyy");
  } catch {
    return day;
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

/** "claude-opus-4-8" -> "Opus 4.8" */
export function prettyModel(model: string): string {
  if (!model) return "Unknown";
  const idx = model.lastIndexOf("claude-");
  const tail = idx >= 0 ? model.slice(idx + "claude-".length) : model;
  const parts = tail.split("-");
  const nums = parts.filter((p) => /^\d{1,2}$/.test(p));
  // Find the family name wherever it sits so legacy ids like
  // "claude-3-5-sonnet-20241022" render as "Sonnet 3.5", not "3 5".
  const fam = modelFamily(model);
  const family = fam !== "other" ? fam : parts.find((p) => /[a-z]/i.test(p)) ?? tail;
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  return nums.length ? `${label} ${nums.join(".")}` : label;
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "other";

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

export function modelColor(model: string): string {
  switch (modelFamily(model)) {
    case "opus":
      return "#c000ff"; // violet
    case "sonnet":
      return "#00f5ff"; // cyan
    case "haiku":
      return "#ff0055"; // magenta
    default:
      return "#b8b8c8";
  }
}

/** Deterministic color for an arbitrary key (project names, etc.) */
export function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 65% 62%)`;
}
