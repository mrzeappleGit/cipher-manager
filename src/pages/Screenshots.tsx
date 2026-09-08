// Screenshots: capture the desktop, a single window, or a dragged region.
// Every capture lands on the clipboard as well as on disk, so the usual flow
// is grab → paste. The gallery below is what's already in the folder.

import { useState } from "react";
import {
  Camera,
  Check,
  Copy,
  Crop,
  FolderOpen,
  Keyboard,
  Monitor,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { Page } from "../components/Layout";
import { Button, Card, EmptyState, ErrorState, IconButton, Loading, Modal, Spinner, cn } from "../components/ui";
import { formatBytes, formatRelative } from "../lib/format";
import { setSettings, useSettings } from "../lib/settings";
import { captureShot, shotsChanged, useShotsVersion } from "../lib/shots";
import { notify } from "../lib/toast";
import { useAsync } from "../lib/useAsync";
import type { CaptureWindow, Shot } from "../types";

const DEFAULT_DIR = "~\\.claude\\cipher-manager\\screenshots";

/** Folder holding `shot`, so Reveal works even on the default (unset) folder. */
function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : "";
}

/** Pick a window to capture — the same listing the meeting recorder uses. */
function WindowPicker({ onPick, onClose }: { onPick: (title: string) => void; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.listCaptureWindows(), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={onClose}
    >
      <div
        className="w-[680px] max-w-[94vw] overflow-hidden rounded-[20px] border border-outline bg-surface-3 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-outline px-5 py-4">
          <Monitor className="h-[18px] w-[18px] text-cyan" strokeWidth={1.9} />
          <span className="flex-1 font-display text-[15px] font-bold text-text">
            Capture a window
          </span>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-4">
          {loading ? (
            <Loading label="Looking for windows…" />
          ) : error ? (
            <ErrorState message={error} />
          ) : !data?.length ? (
            <EmptyState icon={Monitor} title="No open windows" hint="Nothing on screen can be captured." />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {data.map((w: CaptureWindow) => (
                <button
                  key={`${w.app}:${w.title}`}
                  onClick={() => onPick(w.title)}
                  className="overflow-hidden rounded-[12px] border border-outline bg-surface-2 text-left transition-colors hover:border-cyan/60"
                >
                  <div className="flex h-[92px] items-center justify-center overflow-hidden bg-bg">
                    {w.thumb ? (
                      <img src={`data:image/jpeg;base64,${w.thumb}`} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Monitor className="h-6 w-6 text-faint" />
                    )}
                  </div>
                  <div className="px-2.5 py-2">
                    <div className="truncate font-body text-[12.5px] text-text">{w.title}</div>
                    <div className="truncate font-mono text-[10.5px] text-faint">{w.app}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Full-size view of one shot, with the actions that act on it. */
function Lightbox({ shot, dir, onClose }: { shot: Shot; dir: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.readScreenshot(dir, shot.name), [dir, shot.name]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await api.copyScreenshot(dir, shot.name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      notify.error(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function remove() {
    try {
      await api.deleteScreenshot(dir, shot.name);
      setConfirmDelete(false);
      shotsChanged();
      onClose();
    } catch (e) {
      notify.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
      style={{ background: "rgba(3,6,9,0.86)", animation: "cmScrim 150ms ease both" }}
      onClick={onClose}
    >
      <div className="mb-3 flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-bold text-text">{shot.name}</div>
          <div className="truncate font-mono text-[11px] text-faint">
            {shot.width}×{shot.height} · {formatBytes(shot.bytes)}
          </div>
        </div>
        <Button onClick={copy}>
          {copied ? <Check className="h-4 w-4 text-cyan" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button onClick={() => api.revealPath(shot.path).catch(() => {})}>
          <FolderOpen className="h-4 w-4" />
          Reveal
        </Button>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
        <IconButton title="Close" onClick={onClose}>
          <X className="h-5 w-5" />
        </IconButton>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-[16px] border border-outline bg-surface-1"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <Spinner className="h-6 w-6" />
        ) : error ? (
          <ErrorState message={error} />
        ) : (
          <img src={`data:image/png;base64,${data}`} alt={shot.name} className="max-h-full max-w-full object-contain" />
        )}
      </div>

      {/* Contained, or dismissing the confirm would bubble up and shut the
          lightbox behind it too. */}
      <div onClick={(e) => e.stopPropagation()}>
        <Modal
          open={confirmDelete}
          danger
          title="Delete this screenshot?"
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="danger" onClick={remove}>
                Delete
              </Button>
            </>
          }
        >
          <span className="font-mono text-[12.5px]">{shot.name}</span> will be removed from disk.
          This can't be undone.
        </Modal>
      </div>
    </div>
  );
}

export default function Screenshots() {
  const settings = useSettings();
  const version = useShotsVersion();
  const dir = settings.screenshotDir;
  const { data, error, loading } = useAsync(() => api.listScreenshots(dir), [dir, version]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Shot | null>(null);

  const shots = data ?? [];
  // The default folder is resolved in Rust; borrow it from any shot we listed.
  const folder = dir.trim() || (shots[0] ? parentOf(shots[0].path) : "");

  async function grab(mode: "screen" | "region" | "window", title?: string) {
    setBusy(mode);
    await captureShot(mode, title);
    setBusy(null);
  }

  async function chooseFolder() {
    try {
      const picked = await api.pickFolder();
      if (picked) setSettings({ screenshotDir: picked });
    } catch (e) {
      notify.error(`Couldn't open the folder picker: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <Page
      wide
      title="Screenshots"
      subtitle="Every capture is copied to the clipboard and saved to your folder."
      actions={
        <>
          <Button variant="primary" disabled={busy !== null} onClick={() => grab("region")}>
            {busy === "region" ? <Spinner className="h-4 w-4" /> : <Crop className="h-4 w-4" />}
            Region
          </Button>
          <Button disabled={busy !== null} onClick={() => grab("screen")}>
            {busy === "screen" ? <Spinner className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
            Screen
          </Button>
          <Button disabled={busy !== null} onClick={() => setPicking(true)}>
            <Monitor className="h-4 w-4" />
            Window
          </Button>
        </>
      }
    >
      <Card className="mb-5 flex flex-wrap items-center gap-3 p-4">
        <FolderOpen className="h-[18px] w-[18px] shrink-0 text-cyan" strokeWidth={1.9} />
        <div className="min-w-0 flex-1">
          <div className="font-body text-[11px] uppercase tracking-[1px] text-faint">
            Saving to
          </div>
          <div className="truncate font-mono text-[12.5px] text-text">{folder || DEFAULT_DIR}</div>
        </div>
        <Button onClick={chooseFolder}>Change…</Button>
        <Button disabled={!folder} onClick={() => api.openPath(folder).catch(() => {})}>
          Open
        </Button>
        <button
          onClick={() => setSettings({ shotHotkey: !settings.shotHotkey })}
          title="Grab a region from anywhere, even with the app in the tray"
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-[11.5px] transition-colors",
            settings.shotHotkey
              ? "border-cyan/50 bg-cyan/10 text-cyan"
              : "border-outline bg-surface-2 text-muted hover:text-text"
          )}
        >
          <Keyboard className="h-4 w-4" />
          Ctrl+Alt+S
        </button>
      </Card>

      {loading && shots.length === 0 ? (
        <Loading label="Reading your screenshots…" />
      ) : error ? (
        <ErrorState message={error} />
      ) : shots.length === 0 ? (
        <EmptyState
          icon={Camera}
          title="No screenshots yet"
          hint="Hit Region to drag a box anywhere on screen — it lands on your clipboard straight away."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {shots.map((s) => (
            <button
              key={s.name}
              onClick={() => setOpen(s)}
              className="overflow-hidden rounded-[14px] border border-outline bg-surface-2 text-left transition-all hover:border-cyan/60 hover:shadow-[var(--cm-shadow-2)]"
            >
              <div className="flex h-[140px] items-center justify-center overflow-hidden bg-bg">
                {s.thumb ? (
                  <img src={`data:image/jpeg;base64,${s.thumb}`} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Camera className="h-7 w-7 text-faint" />
                )}
              </div>
              <div className="px-3 py-2.5">
                <div className="truncate font-body text-[12.5px] text-text">{s.name}</div>
                <div className="truncate font-mono text-[10.5px] text-faint">
                  {s.width}×{s.height} · {formatBytes(s.bytes)} ·{" "}
                  {formatRelative(new Date(s.takenAt).toISOString())}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {picking && (
        <WindowPicker
          onClose={() => setPicking(false)}
          onPick={(title) => {
            setPicking(false);
            void grab("window", title);
          }}
        />
      )}
      {open && <Lightbox shot={open} dir={dir} onClose={() => setOpen(null)} />}
    </Page>
  );
}
