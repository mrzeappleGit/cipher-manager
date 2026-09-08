// Compact recall core for voice: keyword + semantic search over transcripts
// and the vault, synthesized into one spoken answer. The Ask page keeps its
// own richer version (per-source rendering, error surfacing) — this is the
// eyes-free path.

import { api } from "../api";
import { answerWithContext, isProviderReady } from "./ai";
import { getSettings } from "./settings";
import { providerKeyRef } from "./secrets";
import type { SearchResult, VaultHit } from "../types";

const STOP = new Set(
  "the a an and or of to in on for with how did do i my me is was are what when where why that this it we you can get set up over about into from your".split(" ")
);

function keywords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 6);
}

export async function recallAnswer(q: string): Promise<string | null> {
  const s = getSettings();
  const terms = keywords(q);
  const vaultDir = s.vaultDir.trim();
  const embUrl = s.embeddingsUrl.trim();
  const embModel = s.embeddingsModel.trim() || "nomic-embed-text";
  const embKey = providerKeyRef(s.provider, s.apiKeys[s.provider] ?? "");
  const [keyword, semantic, vault] = await Promise.all([
    api.searchAny(terms.length ? terms : [q], 8).catch(() => [] as SearchResult[]),
    embUrl
      ? api.semanticSearchSessions(embUrl, embKey, embModel, q, 5).catch(() => [] as SearchResult[])
      : Promise.resolve([] as SearchResult[]),
    !vaultDir
      ? Promise.resolve([] as VaultHit[])
      : (embUrl
          ? api.semanticSearch(vaultDir, embUrl, embKey, embModel, q, 5)
          : api.searchVault(vaultDir, terms.length ? terms : [q], 5)
        ).catch(() => [] as VaultHit[]),
  ]);
  const seen = new Set(keyword.map((r) => r.sessionId));
  const results = [...keyword, ...semantic.filter((r) => !seen.has(r.sessionId))].slice(0, 10);
  if (results.length === 0 && vault.length === 0) return null;
  if (!isProviderReady(s)) {
    const names = [...vault.map((v) => v.name), ...results.map((r) => r.sessionTitle ?? r.projectName)]
      .filter(Boolean)
      .slice(0, 3);
    return `I found ${results.length + vault.length} matches — top: ${names.join(", ")}. Details are on the Ask page.`;
  }
  const answer = await answerWithContext(q, [
    ...vault.map((v) => ({ projectName: "vault", sessionTitle: v.name, snippet: v.snippet })),
    ...results.map((r) => ({ projectName: r.projectName, sessionTitle: r.sessionTitle, snippet: r.snippet })),
  ]);
  return answer.trim() || null;
}
