// Rendering for the 576x288 canvas: ONE full-screen text container that we
// upgrade in place. ponytail: text-only (no native list container) keeps us
// inside the verified SDK surface; swap to list containers once their API is
// confirmed on hardware.

const MAX_PAGE_CHARS = 400;

export function clamp(s: string, max = 64): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "~";
}

/** Menu with the active row prefixed by `>` (the one reliable glyph set). */
export function menu(title: string, items: string[], sel: number): string {
  const rows = items.map((it, i) => `${i === sel ? ">" : " "} ${clamp(it, 60)}`);
  return `${title}\n\n${rows.join("\n")}`;
}

/** Split lines into pages that respect the char budget (content preserved). */
export function paginate(lines: string[], header: string): string[] {
  const pages: string[] = [];
  let cur: string[] = [];
  let len = header.length + 2;
  for (const raw of lines) {
    const line = clamp(raw, 64);
    if (len + line.length + 1 > MAX_PAGE_CHARS && cur.length > 0) {
      pages.push(`${header}\n\n${cur.join("\n")}`);
      cur = [];
      len = header.length + 2;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length > 0 || pages.length === 0) pages.push(`${header}\n\n${cur.join("\n") || "(nothing here)"}`);
  // Page footer, added after the split so it never overflows a page.
  return pages.map((p, i) => (pages.length > 1 ? `${p}\n\n[${i + 1}/${pages.length}] swipe` : p));
}

export function age(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
