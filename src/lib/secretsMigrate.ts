// One-time migration of AI provider keys (WP-0B) from settings/localStorage
// into the OS credential store. Runs once per machine on the desktop app:
// for each provider key with a value, store it in the vault, verify presence,
// then blank the settings field. A failure leaves the raw value intact.

import { api, isTauri } from "../api";
import { getSettings, setApiKey, setSettings, settingsReady, flushSettings, type AppSettings, type ProviderId } from "./settings";
import { loadSecretPresence, providerKeyId } from "./secrets";

const DONE_KEY = "cipher-manager.secrets-migrated.v3";

// User-entered string secrets → vault id. (OAuth-obtained refresh tokens are
// handled by the OAuth-completion path, not here.)
const SIMPLE_SECRETS: Array<{ field: keyof AppSettings; id: string }> = [
  { field: "elevenApiKey", id: "eleven-api-key" },
  { field: "asanaToken", id: "asana-token" },
  { field: "haToken", id: "ha-token" },
  { field: "picovoiceKey", id: "picovoice-key" },
  { field: "twitchClientSecret", id: "twitch-client-secret" },
  { field: "googleClientSecret", id: "google-client-secret" },
  { field: "youtubeApiKey", id: "youtube-api-key" },
  // OAuth-obtained tokens stored by the Connect flow — move existing ones too.
  { field: "twitchRefreshToken", id: "twitch-refresh-token" },
  { field: "youtubeRefreshToken", id: "youtube-refresh-token" },
  { field: "gmailRefreshToken", id: "gmail-refresh-token" },
  { field: "protonBridgePassword", id: "proton-bridge-password" },
];

async function secureLegacyValue(id: string, raw: string): Promise<boolean> {
  // A previous migration may have saved the credential but failed to flush
  // settings. Never replace a newer vault value with that leftover plaintext.
  const existing = await api.secretPresence();
  if (!existing[id]) await api.setSecret(id, raw);
  return (await api.secretPresence())[id] === true;
}

export async function migrateProviderKeys(): Promise<void> {
  if (!isTauri()) return; // secrets are configured on the desktop only
  await settingsReady;
  // Old versions wrote the marker even after failures. Always check for raw keys.
  localStorage.removeItem(DONE_KEY);
  await loadSecretPresence();
  const s = getSettings();
  const providers = Object.keys(s.apiKeys) as ProviderId[];
  let failed = false;
  for (const p of providers) {
    const raw = (s.apiKeys[p] ?? "").trim();
    if (!raw) continue;
    const id = providerKeyId(p);
    try {
      if (await secureLegacyValue(id, raw)) {
        if (getSettings().apiKeys[p] === s.apiKeys[p]) setApiKey(p, "");
      } else failed = true;
    } catch {
      failed = true; // preserve the plaintext until a retry succeeds
    }
  }
  // Simple string secrets (Eleven/Asana/HA/Picovoice).
  for (const { field, id } of SIMPLE_SECRETS) {
    const raw = String(s[field] ?? "").trim();
    if (!raw) continue;
    try {
      if (await secureLegacyValue(id, raw)) {
        if (getSettings()[field] === s[field]) setSettings({ [field]: "" } as Partial<AppSettings>);
      } else failed = true;
    } catch {
      failed = true;
    }
  }
  await loadSecretPresence();
  await flushSettings();
  if (failed) {
    localStorage.removeItem(DONE_KEY);
    throw new Error("Some credentials could not be secured. They remain in local settings; restart to retry.");
  }
  localStorage.setItem(DONE_KEY, "1");
}
