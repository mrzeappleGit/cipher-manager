// Gathers what the Rust side can't know (deck needs tokens, vault dir is a
// setting) and pushes the baked snapshot to the VPS. Called hourly by
// CloudSyncRunner and by the Settings push-now button.
import { api } from "../api";
import { getSettings } from "./settings";
import { keyConfigured, keyRef } from "./secrets";
import { ntfyConfigured, pushPhone } from "./ntfy";
import { notify } from "./toast";
import type { DeckDashboard, SnapshotDoc } from "../types";

const DOC_CAP = 20;
let failureToastShown = false; // one nag per app session, not one per hour
let failurePinged = false; // one phone ping per failure streak, reset on success

export async function pushCloudSnapshotNow(manual: boolean): Promise<void> {
  const s = getSettings();
  if (!s.sshHost.trim() || !s.snapshotRemotePath.trim()) {
    if (!manual) return;
    const error = new Error("Configure an SSH host and snapshot file path in Settings first.");
    notify.error(error.message);
    throw error;
  }
  let deck: DeckDashboard | undefined;
  try {
    if (s.icsUrls.length > 0 || keyConfigured("asana-token", s.asanaToken)) {
      deck = await api.getDeck({
        icsUrls: s.icsUrls,
        asanaToken: keyRef("asana-token", s.asanaToken),
        asanaProject: s.asanaProject,
        asanaWorkspace: s.asanaWorkspace,
      });
    }
  } catch {
    /* deck unavailable — push the rest anyway */
  }
  let docs: SnapshotDoc[] | undefined;
  try {
    if (s.vaultDir) {
      const files = (await api.listVault(s.vaultDir))
        .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
        .slice(0, DOC_CAP);
      docs = await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          name: f.name,
          modified: Date.parse(f.modified ?? "") || 0,
          content: await api.readVaultFile(s.vaultDir, f.path).catch(() => ""),
        }))
      );
    }
  } catch {
    /* vault unavailable — push the rest anyway */
  }
  try {
    await api.pushCloudSnapshot({ deck, docs }, s.sshHost, s.snapshotRemotePath);
    failurePinged = false; // next failure streak pings again
    if (manual) notify.success("Snapshot pushed — phone cache is current.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (manual || !failureToastShown) {
      notify.error(`Cloud snapshot push failed: ${msg}`);
      failureToastShown = true;
    }
    if (!manual && !failurePinged && ntfyConfigured()) {
      failurePinged = true;
      void pushPhone("Cloud snapshot push failed", msg, false).catch(() => {});
    }
    console.error("cloud snapshot push failed:", msg);
    if (manual) throw e;
  }
}
