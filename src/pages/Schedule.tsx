// The schedule maker is a self-contained HTML tool served from /schedule-maker.html
// (public/); it manages its own state via localStorage, so we just frame it.
// The frame can't reach Tauri IPC, so its "Push to Website" button posts the
// serialized schedule up to us and we run the backend call + toasts.
import { useEffect, useRef } from "react";
import { api } from "../api";
import { notify } from "../lib/toast";
import { getSettings } from "../lib/settings";

export default function SchedulePage() {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; json?: string } | null;
      if (d?.type !== "cipher-push-schedule" || typeof d.json !== "string") return;
      const s = getSettings();
      if (!s.sshHost.trim() || !s.scheduleRemotePath.trim()) {
        notify.error("Configure an SSH host and schedule file path in Settings first.");
        return;
      }
      api
        .pushScheduleSite(d.json, s.sshHost, s.scheduleRemotePath)
        .then(() => notify.success("Schedule published to your configured destination"))
        .catch((err) =>
          notify.error(
            `Schedule push failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <iframe
      ref={frame}
      src="/schedule-maker.html"
      title="Schedule maker"
      className="block h-full w-full border-0"
    />
  );
}
