// Phone push via ntfy — install the ntfy app, subscribe to your topic, and
// job/automation completions land on the phone even when you're away.
// No account: the topic string IS the secret, so use something unguessable.

import { aiRequest } from "../api";
import { getSettings } from "./settings";

export function ntfyConfigured(): boolean {
  return getSettings().ntfyTopic.trim() !== "";
}

export async function pushPhone(title: string, message: string, ok = true): Promise<void> {
  const s = getSettings();
  const topic = s.ntfyTopic.trim();
  if (!topic) return;
  const server = (s.ntfyServer.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  const r = await aiRequest(
    `${server}/${encodeURIComponent(topic)}`,
    // ntfy metadata rides in headers; Tags render as emoji on the phone.
    { Title: title.slice(0, 120), Tags: ok ? "white_check_mark" : "x" },
    message.slice(0, 2000),
    "POST"
  );
  if (r.status >= 300) throw new Error(`ntfy ${r.status}: ${r.text.slice(0, 120)}`);
}
