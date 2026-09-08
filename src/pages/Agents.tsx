import { Plus, Skull, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Page } from "../components/Layout";
import { Badge, Button, Card, EmptyState, SectionTitle, cn } from "../components/ui";
import { api } from "../api";
import { withToast } from "../lib/toast";
import { useSettings } from "../lib/settings";
import type { Engine } from "../lib/jobs";
import { useCachedAsync } from "../lib/useAsync";
import { formatRelative } from "../lib/format";
import type { AgentSessionInfo } from "../types";

// btoa(str) breaks on non-Latin1 — go through UTF-8 bytes explicitly.
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function sessionTitle(s: AgentSessionInfo): string {
  return s.title || s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd;
}

/** Quick keys for sequences soft keyboards (and muscle memory) can't type. */
const QUICK_KEYS: Array<[string, string]> = [
  ["Esc", "\x1b"],
  ["^C", "\x03"],
  ["Tab", "\t"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["Enter", "\r"],
];

function AgentTerminal({
  session,
  onExited,
  onRemove,
}: {
  session: AgentSessionInfo;
  onExited: () => void;
  onRemove: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const [status, setStatus] = useState<AgentSessionInfo["status"]>(session.status);
  const [exitCode, setExitCode] = useState<number | undefined>(session.exitCode);
  const [lost, setLost] = useState(false);
  const [line, setLine] = useState("");
  const id = session.id;

  // Serialize writes: two in-flight POSTs can complete out of order and
  // reorder keystrokes. Per-mount promise chain; errors surfaced by the
  // read loop / list.
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Echo latency: poke the read loop the moment a write lands instead of
  // waiting out the poll interval — otherwise every keystroke can sit up to
  // 400ms before it appears.
  const pokeRef = useRef<() => void>(() => {});
  function send(data: string) {
    writeQueueRef.current = writeQueueRef.current
      .then(() => api.agentWrite(id, utf8ToB64(data)))
      .then(() => pokeRef.current())
      .catch(() => {});
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#05060a" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Wire input BEFORE the first read: conhost sends ESC[6n on startup and
    // stalls until the terminal answers ESC[1;1R — xterm answers via onData.
    const dataSub = term.onData((d) => send(d));

    fit.fit();
    api.agentResize(id, term.cols, term.rows).catch(() => {});

    // Fresh mount ⇒ empty terminal, so the offset-0 history replay lands on a
    // clean screen (the per-session `key` remount is the reset).
    offsetRef.current = 0;

    // ponytail: polling attach loop, not websockets/SSE — serve is plain HTTP.
    // Upgrade path: an SSE endpoint in serve.rs if 400ms polling ever hurts.
    let stopped = false;
    let inFlight = false; // guards onVis: a read is mid-await, timer id is stale
    let done = false; // exited: final bytes delivered, never poll again
    let pokePending = false; // write landed during an in-flight read: re-read now
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      inFlight = true;
      try {
        const r = await api.agentRead(id, offsetRef.current);
        if (stopped) return;
        setLost(false);
        if (r.dataB64) term.write(b64ToBytes(r.dataB64));
        offsetRef.current = r.offset;
        if (r.status === "exited") {
          done = true;
          setStatus("exited");
          setExitCode(r.exitCode);
          term.options.disableStdin = true;
          onExited();
          return; // final read delivered the remaining bytes; stop polling
        }
      } catch {
        if (stopped) return;
        setLost(true); // removed elsewhere or serve down; keep retrying at 2s
        timer = setTimeout(tick, 2000);
        return;
      } finally {
        inFlight = false;
      }
      timer = setTimeout(
        tick,
        pokePending ? 0 : document.visibilityState === "visible" ? 400 : 2000
      );
      pokePending = false;
    };
    const onVis = () => {
      // Coming back to the tab: poll now instead of waiting out the 2s backoff.
      // Skip while a read is in flight — clearTimeout on its already-fired timer
      // id is a no-op and we'd fork a second, permanent poll chain.
      if (document.visibilityState === "visible" && !stopped && !done && !inFlight) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    pokeRef.current = () => {
      if (stopped || done) return;
      if (inFlight) {
        pokePending = true; // the in-flight read may predate the write's echo
      } else {
        clearTimeout(timer);
        void tick();
      }
    };
    void tick();

    // Container resize → refit → tell the PTY, debounced (ConPTY resize storms).
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        api.agentResize(id, term.cols, term.rows).catch(() => {});
      }, 250);
    });
    ro.observe(el);

    return () => {
      stopped = true;
      pokeRef.current = () => {};
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      dataSub.dispose();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const exited = status === "exited";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {exited && (
        <div className="flex items-center gap-3 rounded-lg border border-outline bg-surface-2 px-3 py-2 font-mono text-xs text-muted">
          <span>
            session exited{exitCode != null ? ` (code ${exitCode})` : ""} — terminal is read-only
          </span>
          <div className="flex-1" />
          <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        </div>
      )}
      {lost && !exited && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-xs text-warn">
          connection lost — retrying…
        </div>
      )}
      <div
        ref={containerRef}
        className="h-[52vh] min-h-[280px] w-full overflow-hidden rounded-[14px] border border-outline bg-[#05060a] p-2 md:h-[62vh]"
      />
      <div className="flex items-center gap-1.5">
        {QUICK_KEYS.map(([label, seq]) => (
          <button
            key={label}
            disabled={exited}
            onClick={() => send(seq)}
            className="rounded-md border border-outline bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>
      {/* Soft keyboards don't play well with xterm — plain input fallback. */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (exited) return;
          send(line + "\r");
          setLine("");
        }}
      >
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          disabled={exited}
          placeholder="Type a line and send (phone-friendly input)"
          className="min-w-0 flex-1 rounded-lg border border-outline bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-faint focus:border-cyan/50 focus:outline-none disabled:opacity-50"
        />
        <Button type="submit" disabled={exited}>
          Send
        </Button>
      </form>
    </div>
  );
}

export default function AgentsPage() {
  const settings = useSettings();
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const projects = useCachedAsync("projects", () => api.listProjects());

  // New-session form (only rendered with actingMode on).
  const [newCwd, setNewCwd] = useState("");
  const [engine, setEngine] = useState<Engine>("claude");
  const [spawning, setSpawning] = useState(false);

  async function refreshList() {
    try {
      const list = await api.agentList();
      setSessions(list);
      setListError(null);
    } catch (e) {
      setListError(String((e as Error)?.message ?? e));
    }
  }

  useEffect(() => {
    void refreshList();
    const t = setInterval(refreshList, 3000);
    return () => clearInterval(t);
  }, []);

  // ?attach=<id> — select that session once the list arrives, then drop the param.
  useEffect(() => {
    const attach = searchParams.get("attach");
    if (!attach || !sessions) return;
    if (sessions.some((s) => s.id === attach)) setSelectedId(attach);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions === null]);

  // If the selected session vanished (removed from another client, serve restart),
  // drop the selection so the terminal unmounts instead of polling a dead id.
  useEffect(() => {
    if (selectedId && sessions && !sessions.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }, [sessions, selectedId]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  async function spawn(cwd: string, title?: string) {
    // Interactive TUIs all launch bare; job-style extra args (codexArgs etc.)
    // are exec-mode flags and don't apply here.
    const bin =
      engine === "codex"
        ? settings.codexBin || "codex"
        : engine === "gemini"
          ? settings.geminiBin || "gemini"
          : settings.claudeBin || "claude";
    setSpawning(true);
    try {
      const r = await withToast(
        api.agentSpawn({ bin, cwd, title }),
        { error: "Spawn failed" }
      );
      if (r) {
        // Refresh BEFORE selecting: selecting first renders against the stale
        // list, and the vanished-session effect insta-deselects the new id.
        await refreshList();
        setSelectedId(r.id);
      }
    } finally {
      setSpawning(false);
    }
  }

  if (listError && !sessions) {
    return (
      <Page title="Agents" subtitle="Live interactive Claude sessions, hosted by the local web server">
        <EmptyState
          icon={TerminalIcon}
          title="Agent sessions need the local web server running"
          hint={`serve.exe hosts the terminals so they survive app restarts and are reachable from the phone. (${listError})`}
        />
      </Page>
    );
  }

  return (
    <Page
      title="Agents"
      subtitle="Live interactive Claude sessions, hosted by the local web server"
      wide
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex w-full shrink-0 flex-col gap-3 md:w-[320px]">
          <SectionTitle>Sessions</SectionTitle>
          {sessions && sessions.length === 0 && (
            <Card className="p-4 font-body text-sm text-muted">No agent sessions yet.</Card>
          )}
          {sessions?.map((s) => (
            <Card
              key={s.id}
              hover
              onClick={() => setSelectedId(s.id)}
              className={cn("p-3", s.id === selectedId && "border-cyan/60")}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-body text-sm font-semibold text-text">
                  {sessionTitle(s)}
                </span>
                <Badge color={s.status === "running" ? "#00f5ff" : undefined}>
                  {s.status === "running"
                    ? "running"
                    : s.exitCode != null
                      ? `exited (${s.exitCode})`
                      : "exited"}
                </Badge>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-muted" title={s.cwd}>
                {s.cwd}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="flex-1 font-mono text-[10.5px] text-faint">
                  started {formatRelative(new Date(s.startedMs).toISOString())}
                </span>
                {s.status === "running" ? (
                  <Button
                    variant="danger"
                    className="px-2 py-1 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      void withToast(api.agentKill(s.id), { error: "Kill failed" }).then(refreshList);
                    }}
                  >
                    <Skull className="h-3.5 w-3.5" /> Kill
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      void withToast(api.agentRemove(s.id), { error: "Remove failed" }).then(() => {
                        if (selectedId === s.id) setSelectedId(null);
                        void refreshList();
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                )}
              </div>
            </Card>
          ))}

          {settings.actingMode && (
            <Card className="flex flex-col gap-2.5 p-3">
              <SectionTitle>New session</SectionTitle>
              <select
                value=""
                onChange={(e) => {
                  const p = projects.data?.find((x) => x.id === e.target.value);
                  if (p) setNewCwd(p.path);
                }}
                className="rounded-lg border border-outline bg-bg px-2.5 py-2 font-body text-sm text-text focus:border-cyan/50 focus:outline-none"
              >
                <option value="">Pick a project…</option>
                {(projects.data ?? [])
                  .filter((p) => p.pathExists)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <input
                value={newCwd}
                onChange={(e) => setNewCwd(e.target.value)}
                placeholder="…or an absolute path"
                className="rounded-lg border border-outline bg-bg px-2.5 py-2 font-mono text-xs text-text placeholder:text-faint focus:border-cyan/50 focus:outline-none"
              />
              <div className="flex gap-1.5">
                {(["claude", "codex", "gemini"] as Engine[]).map((e) => (
                  <button
                    key={e}
                    onClick={() => setEngine(e)}
                    className={cn(
                      "flex-1 rounded-lg border px-2 py-1.5 font-mono text-xs transition-colors",
                      engine === e
                        ? "border-cyan/60 bg-cyan/10 text-text"
                        : "border-outline bg-bg text-muted hover:text-text"
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <Button
                variant="primary"
                disabled={spawning || !newCwd.trim()}
                onClick={() => void spawn(newCwd.trim())}
              >
                <Plus className="h-4 w-4" /> Start {engine} here
              </Button>
            </Card>
          )}
        </div>

        {selected ? (
          <AgentTerminal
            key={selected.id}
            session={selected}
            onExited={() => void refreshList()}
            onRemove={() =>
              void withToast(api.agentRemove(selected.id), { error: "Remove failed" }).then(() => {
                setSelectedId(null);
                void refreshList();
              })
            }
          />
        ) : (
          <div className="flex-1">
            <EmptyState
              icon={TerminalIcon}
              title="No session attached"
              hint="Pick a session on the left, or start a new one."
            />
          </div>
        )}
      </div>
    </Page>
  );
}
