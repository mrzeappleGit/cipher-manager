import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isTauri } from "../api";
import { Button, Card, SectionTitle } from "./ui";

interface ServerStatus {
  state: "running" | "stopped" | "unavailable";
  version: string | null;
  versionMatches: boolean;
  message: string;
}

export function ServerControls() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function control(action: "status" | "start" | "stop") {
    setBusy(true);
    setError("");
    try { setStatus(await invoke<ServerStatus>(`local_server_${action}`)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (isTauri()) void control("status"); }, []);
  if (!isTauri()) return null;
  return (
    <Card className="p-5">
      <SectionTitle>Local server</SectionTitle>
      <p className="text-sm text-muted" role="status">
        {status?.message ?? "Checking bundled server…"}
      </p>
      {status?.version && <p className="mt-2 text-xs text-faint">Server version: {status.version}</p>}
      {status?.state === "running" && !status.versionMatches && (
        <p className="mt-2 text-sm text-warn">Finish active work, then stop and start the server to use this app’s bundled version.</p>
      )}
      {error && <p className="mt-2 text-sm text-error" role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button disabled={busy || status?.state !== "stopped"} onClick={() => void control("start")}>Start server</Button>
        <Button disabled={busy || status?.state !== "running"} onClick={() => void control("stop")}>Stop server</Button>
        <Button variant="subtle" disabled={busy} onClick={() => void control("status")}>{busy ? "Working…" : "Refresh status"}</Button>
      </div>
      <p className="mt-3 text-xs text-faint">Starts on this computer only. Stopping is refused while agent sessions, jobs or recordings are active. Closing the app leaves the server running.</p>
    </Card>
  );
}
