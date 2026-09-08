// CipherCodex → Obsidian sync helpers: where the notes land in the vault and
// the quiet once-a-day auto-sync (manual sync lives in Settings).

import { api, isTauri } from "../api";
import { getSettings } from "./settings";

const LAST_SYNC_KEY = "cm-codex-last-sync";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Same folder the codex-harvest skill writes, so downstream consumers
 * (memory-harvest, vault-curator, Obsidian search) see no difference.
 * vaultDir is already the Generated folder — the skill's target is
 * `<vaultDir>\output\codex`, not a path from the vault repo root. */
export function codexOutDir(vaultDir: string): string {
  return vaultDir.trim().replace(/[/\\]+$/, "") + "\\output\\codex";
}

export function markCodexSynced(): void {
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
}

/** Silent daily sync — errors are swallowed (the Settings button surfaces them). */
export async function codexAutoSync(vaultDir: string): Promise<void> {
  const stateUrl = getSettings().ccxStateUrl.trim();
  if (!isTauri() || !vaultDir.trim() || !stateUrl) return;
  if (Date.now() - +(localStorage.getItem(LAST_SYNC_KEY) ?? 0) < DAY_MS) return;
  try {
    await api.codexSync(codexOutDir(vaultDir), stateUrl);
    markCodexSynced();
  } catch {
    /* not configured / offline — the manual button reports details */
  }
}
