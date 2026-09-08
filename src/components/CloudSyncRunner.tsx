// Hourly cloud-snapshot ticker. First push ~1 min after launch (let the app
// settle), then every hour. Gated on the setting and desktop mode.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "../api";
import { pushCloudSnapshotNow } from "../lib/cloudSync";
import { getSettings, useSettings } from "../lib/settings";

export default function CloudSyncRunner() {
  const enabled = useSettings().cloudSyncEnabled;

  // Tray Quit routes through here: final push (if enabled), then real exit.
  // Not gated on `enabled` — the app must still exit when sync is off.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void listen("quit-push", async () => {
      if (getSettings().cloudSyncEnabled) {
        await pushCloudSnapshotNow(false).catch(() => {});
      }
      void api.exitApp();
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const first = window.setTimeout(() => void pushCloudSnapshotNow(false), 60_000);
    const hourly = window.setInterval(() => void pushCloudSnapshotNow(false), 3_600_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(hourly);
    };
  }, [enabled]);
  return null;
}
