import { describe, expect, it } from "vitest";
import {
  applyView,
  matchActions,
  rankHits,
  rankOf,
  sortHits,
  withinRange,
  type UniversalHit,
} from "./universal";

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0); // 2026-07-24T12:00:00Z
const DAY = 86_400_000;

function hit(p: Partial<UniversalHit> & { name: string }): UniversalHit {
  return {
    id: p.id ?? p.name,
    kind: p.kind ?? "file",
    name: p.name,
    where: p.where ?? "C:\\somewhere",
    snippet: p.snippet,
    date: p.date === undefined ? null : p.date,
    size: p.size === undefined ? null : p.size,
    target: p.target ?? "C:\\somewhere\\x",
    via: p.via ?? "os",
  };
}

describe("ranking", () => {
  it("scores name matches above body matches", () => {
    expect(rankOf(hit({ name: "deck" }), "deck")).toBe(0); // exact
    expect(rankOf(hit({ name: "deck-model.rs" }), "deck")).toBe(1); // prefix
    expect(rankOf(hit({ name: "cipher deck notes" }), "deck")).toBe(2); // word start
    expect(rankOf(hit({ name: "sidecktop" }), "deck")).toBe(3); // substring
    expect(rankOf(hit({ name: "notes", snippet: "the deck is late" }), "deck")).toBe(4);
    expect(rankOf(hit({ name: "unrelated" }), "deck")).toBe(5);
  });

  it("orders by rank, then newest, then name", () => {
    const out = rankHits(
      [
        hit({ name: "zzz", snippet: "deck" }),
        hit({ name: "deck-b", date: 100 }),
        hit({ name: "deck-a", date: 900 }),
        hit({ name: "deck" }),
      ],
      "deck"
    );
    expect(out.map((h) => h.name)).toEqual(["deck", "deck-a", "deck-b", "zzz"]);
  });

  it("is stable for an empty query", () => {
    const out = rankHits([hit({ name: "b" }), hit({ name: "a" })], "");
    expect(out.map((h) => h.name)).toEqual(["a", "b"]);
  });
});

describe("date filter", () => {
  const today = hit({ name: "today", date: NOW - 3600_000 });
  const lastWeek = hit({ name: "week", date: NOW - 5 * DAY });
  const ancient = hit({ name: "old", date: NOW - 400 * DAY });
  const undated = hit({ name: "undated", date: null });

  it("keeps only what falls inside the span", () => {
    expect(withinRange(today, "today", NOW)).toBe(true);
    expect(withinRange(lastWeek, "today", NOW)).toBe(false);
    expect(withinRange(lastWeek, "7d", NOW)).toBe(true);
    expect(withinRange(ancient, "30d", NOW)).toBe(false);
    expect(withinRange(ancient, "year", NOW)).toBe(false);
  });

  it("keeps undated hits only while the filter is 'any'", () => {
    // Files and apps have no timestamp; constraining the date must not leave
    // them floating at the top of every result set.
    expect(withinRange(undated, "any", NOW)).toBe(true);
    expect(withinRange(undated, "30d", NOW)).toBe(false);
  });
});

describe("column sorting", () => {
  const rows = [
    hit({ name: "beta", date: 200, size: 50 }),
    hit({ name: "alpha", date: null, size: null }),
    hit({ name: "gamma", date: 100, size: 900 }),
  ];

  it("sorts by name in both directions", () => {
    expect(sortHits(rows, "name", false, "").map((h) => h.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(sortHits(rows, "name", true, "").map((h) => h.name)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("parks undated and unsized rows at the bottom whichever way you sort", () => {
    expect(sortHits(rows, "date", false, "").map((h) => h.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(sortHits(rows, "date", true, "").map((h) => h.name)).toEqual(["beta", "gamma", "alpha"]);
    expect(sortHits(rows, "size", true, "").map((h) => h.name)).toEqual(["gamma", "beta", "alpha"]);
  });
});

describe("actions", () => {
  const names = (q: string) => matchActions(q).map((h) => h.name);

  it("surfaces the capture tools for the word people actually type", () => {
    // The whole point: typing "screenshot" must offer the region grabber,
    // even though the word appears nowhere in the action's label.
    expect(names("screenshot")).toContain("Capture region");
    expect(names("screenshot")).toContain("Capture full screen");
    expect(names("region")).toContain("Capture region");
    expect(names("snip")).toContain("Capture region");
  });

  it("matches pages on synonyms as well as their names", () => {
    expect(names("settings")).toContain("Settings");
    expect(names("preferences")).toContain("Settings");
    expect(names("calendar")).toContain("Deck");
  });

  it("stays quiet on short or unrelated input", () => {
    expect(matchActions("s")).toEqual([]);
    expect(matchActions("")).toEqual([]);
    expect(names("zzzqqq")).toEqual([]);
  });

  it("ranks actions above content, even a better-named file", () => {
    const file = hit({ name: "screenshot", kind: "file" }); // exact name match
    const action = matchActions("screenshot").find((a) => a.name === "Capture region")!;
    const out = rankHits([file, action], "screenshot");
    expect(out[0].name).toBe("Capture region");
  });

  it("keeps keyword matches from outranking a real name match between actions", () => {
    // "Screenshots" (the page) is a direct name hit; the capture tools match
    // only by keyword, so the page should not be buried beneath them.
    const out = rankHits(matchActions("screenshots"), "screenshots");
    expect(out[0].name).toBe("Screenshots");
  });
});

describe("applyView", () => {
  const rows = [
    hit({ name: "session one", kind: "session", date: NOW - DAY }),
    hit({ name: "a note", kind: "note" }),
    hit({ name: "a skill", kind: "skill", date: NOW - DAY }),
    hit({ name: "a doc", kind: "document", date: NOW - DAY }),
    hit({ name: "old session", kind: "session", date: NOW - 300 * DAY }),
  ];
  const view = (o: Partial<Parameters<typeof applyView>[1]>) =>
    applyView(rows, { query: "", scope: "all", date: "any", sort: "relevance", desc: true, now: NOW, ...o });

  it("filters by scope", () => {
    expect(view({ scope: "session" }).map((h) => h.name)).toEqual(["session one", "old session"]);
  });

  it("folds skills into the Docs scope", () => {
    // "Docs" is one chip covering both — they're all markdown under ~/.claude.
    expect(view({ scope: "document" }).map((h) => h.name).sort()).toEqual(["a doc", "a skill"]);
  });

  it("combines scope and date", () => {
    expect(view({ scope: "session", date: "7d" }).map((h) => h.name)).toEqual(["session one"]);
  });
});
