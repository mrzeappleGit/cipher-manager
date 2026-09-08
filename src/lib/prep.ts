// Meeting prep: assemble what you need before walking into a meeting —
// open action items for the people in it, the last meeting's summary,
// and related vault notes (semantic when embeddings are configured).

import { api } from "../api";
import { matchingPeoplePages } from "./people";
import { parseMeetingNote } from "./meetingRec";
import { getSettings } from "./settings";
import { providerKeyRef } from "./secrets";
import type { VaultHit } from "../types";

export interface PrepData {
  people: Array<{ name: string; rel: string; actions: string[] }>;
  lastMeeting: { rel: string; title: string; date: string | null; summary: string } | null;
  related: VaultHit[];
}

const STOP = new Set(
  "the a an and or of to with for on in at meeting call sync weekly daily monthly standup review team group working".split(" ")
);

function words(t: string): string[] {
  return [...new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

export async function buildPrep(title: string): Promise<PrepData> {
  const s = getSettings();
  const vault = s.vaultDir.trim();
  if (!vault) throw new Error("Set your vault folder in Settings to build prep briefs.");
  const [files, people] = await Promise.all([api.listVault(vault), matchingPeoplePages(title)]);

  // Open action items per person, from their generated page.
  const peopleOut = await Promise.all(
    people.slice(0, 3).map(async (p) => {
      const md = await api.readVaultFile(vault, p.rel).catch(() => "");
      const section = md.split(/^## Meetings/m)[0].split(/^## Action items/m)[1] ?? "";
      const actions = section
        .split(/\r?\n/)
        .map((l) => l.match(/^- (.+)$/)?.[1] ?? "")
        .filter((x) => x && !/^none recorded/.test(x))
        .slice(0, 6);
      return { ...p, actions };
    })
  );

  // Most recent meeting note sharing a meaningful title word.
  const tw = words(title);
  const meetings = files
    .filter((d) => d.name.toLowerCase().replace(/\\/g, "/").includes("output/meetings/"))
    .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
  let lastMeeting: PrepData["lastMeeting"] = null;
  for (const d of meetings) {
    const base = (d.name.split(/[\\/]/).pop() ?? "").toLowerCase();
    if (!tw.some((w) => base.includes(w))) continue;
    const md = await api.readVaultFile(vault, d.path).catch(() => "");
    if (md) {
      const parts = parseMeetingNote(md);
      lastMeeting = {
        rel: d.name,
        title: parts.title,
        date: parts.date,
        summary: parts.summary.slice(0, 1200),
      };
    }
    break;
  }

  // Related notes by meaning (keyword fallback without embeddings); people
  // pages are already shown above, so drop them from the hits.
  const embUrl = s.embeddingsUrl.trim();
  const related = await (embUrl
    ? api.semanticSearch(
        vault,
        embUrl,
        providerKeyRef(s.provider, s.apiKeys[s.provider] ?? ""),
        s.embeddingsModel.trim() || "nomic-embed-text",
        title,
        4
      )
    : api.searchVault(vault, tw.length ? tw : [title], 4)
  ).catch(() => [] as VaultHit[]);

  return {
    people: peopleOut,
    lastMeeting,
    related: related.filter((r) => !r.rel.replace(/\\/g, "/").includes("output/people/")),
  };
}
