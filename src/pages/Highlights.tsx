import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Captions,
  Copy,
  ExternalLink,
  Film,
  Flame,
  FolderOpen,
  LayoutTemplate,
  ListVideo,
  Play,
  Radio,
  RefreshCw,
  Scissors,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { Page } from "../components/Layout";
import { Card, EmptyState, SectionTitle, Spinner } from "../components/ui";
import { api, isTauri } from "../api";
import { notify } from "../lib/toast";
import { getSettings, setSettings, useSettings, type ProviderId } from "../lib/settings";
import { captionStt, ensureWhisperx } from "../lib/meetingRec";
import { CLOUD_MODELS, cloudBackend } from "../lib/cloudVision";
import {
  CLIP_LABELS,
  clearClipLog,
  clipsConfigured,
  createTwitchClip,
  latestVods,
  reelText,
  removeClip,
  useClipLog,
  type Vod,
} from "../lib/clips";
import type { Clip, FacecamLayout, Highlight, Job } from "../types";

function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** The mashup/compilation file has no score/bounds; sink it to the bottom. */
function isStitched(c: Clip): boolean {
  return c.name === "mashup.mp4" || c.name.startsWith("compilation");
}

function sortClips(clips: Clip[], byScore: boolean): Clip[] {
  return [...clips].sort((a, b) => {
    if (isStitched(a) !== isStitched(b)) return isStitched(a) ? 1 : -1;
    return byScore ? b.score - a.score : a.name.localeCompare(b.name);
  });
}

/** Excitement tier → a small badge. AI scores are 0–100; old/audio-only clips
 * keep their dB-over-baseline thresholds. */
function tier(c: Clip): { icon: typeof Flame; label: string; color: string } | null {
  const [hot, spicy] = c.aiScored ? [85, 70] : [18, 10];
  if (c.score >= hot) return { icon: Flame, label: "Hot", color: "#f97316" };
  if (c.score >= spicy) return { icon: Zap, label: "Spicy", color: "#eab308" };
  return null;
}

const inputCls =
  "w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";
const btnCls =
  "inline-flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent disabled:opacity-50";

/** Live clip creation (Helix POST /clips) + the labelled clip log/reel. */
function LiveClips() {
  const settings = useSettings();
  const log = useClipLog();
  const [label, setLabel] = useState<string>(CLIP_LABELS[0]);
  const [note, setNote] = useState("");
  const [clipping, setClipping] = useState(false);
  const configured = clipsConfigured();

  async function clipIt() {
    if (clipping) return;
    setClipping(true);
    try {
      const entry = await createTwitchClip(label, note.trim());
      setNote("");
      notify.success(`Clip saved! (${entry.label})`, () => void api.openUrl(entry.url));
    } catch (e) {
      notify.error(e);
    } finally {
      setClipping(false);
    }
  }

  function copyReel() {
    navigator.clipboard
      .writeText(reelText())
      .then(() => notify.success("Reel playlist copied."))
      .catch(() => notify.error("Couldn't copy"));
  }

  return (
    <Card className="mb-4 p-5">
      <SectionTitle
        right={
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={settings.clipChatCommand}
              onChange={(e) => setSettings({ clipChatCommand: e.target.checked })}
              className="h-3.5 w-3.5 accent-cyan"
            />
            !clip chat command
          </label>
        }
      >
        Live clips
      </SectionTitle>
      {!configured ? (
        <div className="text-sm text-muted">
          Connect Twitch in Settings (client id/secret, channel, Connect) to clip your live stream.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={clipIt}
              disabled={clipping}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold text-[#05060a] transition-all hover:brightness-110 disabled:opacity-60"
              style={{ background: "linear-gradient(135deg,#00f5ff,#c000ff)" }}
            >
              {clipping ? <Spinner className="h-4 w-4" /> : <Radio className="h-4 w-4" />}
              CLIP IT
            </button>
            {CLIP_LABELS.map((l) => (
              <button
                key={l}
                onClick={() => setLabel(l)}
                className={
                  "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                  (label === l ? "border-accent text-fg" : "border-line text-muted hover:text-fg")
                }
              >
                {l}
              </button>
            ))}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="note (optional)"
              className={inputCls + " max-w-56 flex-1 py-1.5"}
            />
          </div>
          {log.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-faint">
                  {log.length} clip{log.length === 1 ? "" : "s"} logged
                </span>
                <span className="flex gap-1.5">
                  <button onClick={copyReel} className={btnCls + " px-2 py-1 text-xs"} title="Copy reel playlist">
                    <Copy className="h-3.5 w-3.5" /> reel
                  </button>
                  <button onClick={clearClipLog} className={btnCls + " px-2 py-1 text-xs"} title="Clear log">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {log.map((c) => (
                  <div
                    key={c.id + c.at}
                    className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm"
                  >
                    <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                      {c.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                      {new Date(c.at).toLocaleTimeString()} {c.note && `· ${c.note}`}
                    </span>
                    <button
                      onClick={() => void api.openUrl(c.url)}
                      className={btnCls + " px-2 py-1"}
                      title="Open clip"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => removeClip(c.id)}
                      className={btnCls + " px-2 py-1"}
                      title="Remove from log"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function HighlightsPage() {
  const settings = useSettings();
  const clipsDir = settings.clipsDir.trim() || undefined; // undefined = default folder
  const [src, setSrc] = useState("");
  const [topN, setTopN] = useState(8);
  const [vertical, setVertical] = useState(false);
  const [mashup, setMashup] = useState(false);
  const [layoutSrc, setLayoutSrc] = useState<string | null>(null);

  const [detecting, setDetecting] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[] | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null); // job that owns `clips` (for re-cut / compile)
  const [sortByScore, setSortByScore] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // clip names picked for a compilation
  const [editing, setEditing] = useState<Clip | null>(null); // clip in the Adjust start&end modal
  const [playing, setPlaying] = useState<Clip | null>(null); // clip in the in-app player
  const [compiling, setCompiling] = useState(false);
  const [captioning, setCaptioning] = useState<string | null>(null); // clip name in flight
  const pollRef = useRef<number | null>(null);
  const activeJobRef = useRef<string | null>(null); // id of the job we're polling
  const submittingRef = useRef(false); // synchronous re-entry guard for make()

  const [vods, setVods] = useState<Vod[] | null>(null);
  const [loadingVods, setLoadingVods] = useState(false);

  const trimmed = src.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);
  const running = job?.status === "running";
  const busy = detecting || running;

  async function pickVod() {
    if (loadingVods) return;
    if (vods) {
      setVods(null); // toggle the list closed
      return;
    }
    setLoadingVods(true);
    try {
      setVods(await latestVods(5));
    } catch (e) {
      notify.error(e);
    } finally {
      setLoadingVods(false);
    }
  }

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }
  useEffect(() => stopPolling, []); // clear on unmount

  async function detect() {
    if (!trimmed || isUrl || busy) return;
    stopPolling();
    activeJobRef.current = null;
    setDetecting(true);
    setHighlights(null);
    setClips(null);
    setJob(null);
    try {
      setHighlights(await api.detectHighlights(trimmed, topN));
    } catch (e) {
      notify.error(e);
    } finally {
      setDetecting(false);
    }
  }

  function startPolling(id: string) {
    stopPolling(); // never leave a prior interval running
    activeJobRef.current = id;
    const tick = async () => {
      if (activeJobRef.current !== id) return; // superseded — stop working
      let j: Job;
      try {
        j = await api.getJob(id);
      } catch {
        return; // transient — next tick retries
      }
      if (activeJobRef.current !== id) return; // superseded while awaiting
      setJob(j);
      if (j.status !== "running") {
        stopPolling(); // clear BEFORE the async tail so no tick overlaps it
        activeJobRef.current = null;
        if (j.status === "done") {
          try {
            setClips(await api.listClips(id, clipsDir));
            setJobId(id);
            setSelected(new Set());
            notify.success("Clips ready.");
          } catch (e) {
            notify.error(String(e));
          }
        } else {
          notify.error("Highlight job failed — see the log below.");
        }
      }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 1200);
  }

  // Jobs run in the backend; this page's state doesn't survive a tab switch.
  // On mount, re-attach to the newest sizzle job: resume polling if it's still
  // running, or restore its clips workspace if it finished while we were away.
  useEffect(() => {
    void (async () => {
      try {
        const mine = (await api.listJobs()).filter((j) => j.skill === "sizzle");
        const latest = mine[0]; // newest-first
        if (!latest || activeJobRef.current) return;
        if (latest.status === "running") {
          setJob(latest);
          startPolling(latest.id);
        } else if (latest.status === "done") {
          const c = await api.listClips(latest.id, clipsDir);
          if (c.length > 0) {
            setJob(latest);
            setClips(c);
            setJobId(latest.id);
          }
        }
      } catch {
        /* mock/snapshot mode — nothing to re-attach */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function make(srcOverride?: string) {
    const source = srcOverride ?? trimmed;
    if (!source || submittingRef.current || activeJobRef.current) return;
    submittingRef.current = true;
    stopPolling();
    activeJobRef.current = null;
    setHighlights(null);
    setClips(null);
    setJob(null);
    // Dialog-assisted scoring: hand the caption STT parts to the job so the
    // fine scan can hear spoken jokes. No STT configured → vision-only.
    let stt;
    try {
      const c = captionStt();
      stt = {
        url: c.url,
        headers: c.headers,
        fields: c.fields,
        fileField: c.fileField,
        container: c.whisperx ? settings.whisperxContainer.trim() : "",
      };
    } catch {
      /* vision-only scoring */
    }
    try {
      const id = await api.startSizzle({
        src: source,
        topN,
        vertical,
        mashup,
        outDir: clipsDir,
        ollamaUrl:
          settings.sizzleAiMode === "remote"
            ? settings.sizzleOllamaUrl.trim() || undefined
            : undefined,
        cloud: settings.sizzleAiMode === "cloud" ? cloudBackend(settings) : undefined,
        facecam:
          vertical && settings.sizzleFacecamOn ? settings.sizzleFacecam ?? undefined : undefined,
        stt,
      });
      startPolling(id);
    } catch (e) {
      notify.error(e);
    } finally {
      submittingRef.current = false;
    }
  }

  // Re-run the AI scan on the finished job's already-downloaded video (no
  // re-download); the current "Top clips" value applies, so raising it first
  // yields more clips.
  async function reanalyze() {
    if (!jobId || submittingRef.current || activeJobRef.current) return;
    try {
      await make(await api.sizzleSource(jobId, clipsDir));
    } catch (e) {
      notify.error(e);
    }
  }

  // Burn captions into a copy of the clip. WhisperX docker lifecycle mirrors
  // the meeting recorder: start it if needed, stop it only if we started it.
  async function caption(c: Clip) {
    if (!jobId || captioning) return;
    let startedWx = false;
    setCaptioning(c.name);
    try {
      const stt = captionStt();
      if (stt.whisperx) startedWx = await ensureWhisperx();
      await api.captionClip({
        jobId,
        name: c.name,
        style: settings.sizzleCaptionStyle,
        sttUrl: stt.url,
        sttHeaders: stt.headers,
        sttFields: stt.fields,
        fileField: stt.fileField,
        outDir: clipsDir,
      });
      setClips(await api.listClips(jobId, clipsDir));
      notify.success("Captions burned in.");
    } catch (e) {
      notify.error(e);
    } finally {
      if (startedWx)
        api.dockerContainer(getSettings().whisperxContainer.trim(), "stop").catch(() => {});
      setCaptioning(null);
    }
  }

  const progress = job?.output
    ?.trim()
    .split("\n")
    .filter(Boolean)
    .pop();

  // Rough percent from the job's stage log:
  // fetch → loudness → sample → AI scan → refine → cut i/N → mashup.
  const pct = (() => {
    if (!progress) return 0;
    if (job?.status === "done") return 100;
    const cut = progress.match(/Cutting clip (\d+)\/(\d+)/);
    if (cut) return 75 + Math.round((20 * (+cut[1] - 1)) / +cut[2]);
    if (progress.includes("mashup")) return 95;
    if (progress.includes("Found")) return 75;
    const fine = progress.match(/Refining candidate (\d+)\/(\d+)/);
    if (fine) return 50 + Math.round((25 * (+fine[1] - 1)) / +fine[2]);
    const coarse = progress.match(/AI scan batch (\d+)\/(\d+)/);
    if (coarse) return 22 + Math.round((28 * (+coarse[1] - 1)) / +coarse[2]);
    const samp = progress.match(/Sampling video… (\d+)\/(\d+)/);
    if (samp) return 16 + Math.round((6 * +samp[1]) / +samp[2]);
    if (progress.includes("Sampling")) return 16;
    if (progress.includes("Scanning")) return 15;
    const dl = progress.match(/Downloading\D*(\d+)%/);
    if (dl) return 1 + Math.round(+dl[1] * 0.14); // yt-dlp: 1–15
    return 1; // fetching source
  })();

  return (
    <Page
      title="Highlights"
      subtitle="Clip the live stream, or auto-cut the best moments from a VOD / local video using local visual AI + audio"
    >
      <LiveClips />
      <Card className="p-5">
        <label className="mb-1 block text-xs font-medium text-faint">
          Twitch/YouTube URL or local video path
        </label>
        <div className="flex gap-2">
          <input
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            placeholder="https://twitch.tv/videos/…  or  D:\\clips\\stream.mp4"
            className={inputCls + " font-mono"}
          />
          {clipsConfigured() && (
            <button onClick={pickVod} className={btnCls + " shrink-0"} title="Pick from your recent VODs">
              {loadingVods ? <Spinner className="h-4 w-4" /> : <ListVideo className="h-4 w-4" />}
              latest VODs
            </button>
          )}
        </div>
        {vods && (
          <div className="mt-2 space-y-1">
            {vods.length === 0 && <div className="text-xs text-muted">No VODs found.</div>}
            {vods.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setSrc(v.url);
                  setVods(null);
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left text-sm transition-colors hover:border-accent"
              >
                {v.thumb && (
                  <img
                    src={v.thumb}
                    alt=""
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                    className="h-[45px] w-20 shrink-0 rounded object-cover"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">{v.title}</span>
                  {v.game && <span className="block truncate text-[11px] text-cyan">{v.game}</span>}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {v.duration} · {new Date(v.date).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div className="w-28">
            <label className="mb-1 block text-xs font-medium text-faint">Top clips</label>
            <input
              type="number"
              min={1}
              max={50}
              value={topN}
              onChange={(e) => setTopN(Math.max(1, Math.min(50, +e.target.value || 1)))}
              className={inputCls}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-fg">
            <input
              type="checkbox"
              checked={vertical}
              onChange={(e) => setVertical(e.target.checked)}
              className="h-4 w-4 accent-cyan"
            />
            Vertical (9:16)
          </label>
          {vertical && (
            <>
              <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={settings.sizzleFacecamOn}
                  onChange={(e) => setSettings({ sizzleFacecamOn: e.target.checked })}
                  className="h-4 w-4 accent-cyan"
                />
                Facecam layout
              </label>
              {settings.sizzleFacecamOn && isTauri() && (
                <button
                  onClick={async () => {
                    try {
                      if (!jobId) throw new Error("Run a job first — the layout is positioned on its video.");
                      setLayoutSrc(await api.sizzleSource(jobId, clipsDir));
                    } catch (e) {
                      notify.error(e);
                    }
                  }}
                  className={btnCls + " mb-2.5"}
                  title="Position the facecam and gameplay boxes on a frame of the video"
                >
                  <LayoutTemplate className="h-4 w-4" />
                  {settings.sizzleFacecam ? "Adjust layout" : "Set layout"}
                </button>
              )}
            </>
          )}
          <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-fg">
            <input
              type="checkbox"
              checked={mashup}
              onChange={(e) => setMashup(e.target.checked)}
              className="h-4 w-4 accent-cyan"
            />
            Mashup compilation
          </label>
          {isTauri() && (
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium text-faint">Save clips + VOD to</label>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() =>
                    api
                      .pickFolder()
                      .then((p) => p && setSettings({ clipsDir: p }))
                      .catch((e) => notify.error(String(e)))
                  }
                  className={btnCls + " max-w-80"}
                  title="Choose where clips and downloaded VODs are saved"
                >
                  <FolderOpen className="h-4 w-4 shrink-0" />
                  <span className="truncate font-mono text-xs">
                    {settings.clipsDir || "default folder"}
                  </span>
                </button>
                {settings.clipsDir && (
                  <button
                    onClick={() => setSettings({ clipsDir: "" })}
                    className={btnCls + " px-2 py-2"}
                    title="Reset to the default folder"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">AI backend</label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-lg border border-line">
                {([
                  ["local", "This PC"],
                  ["remote", "Remote"],
                  ["cloud", "Cloud API"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setSettings({ sizzleAiMode: mode })}
                    className={
                      "px-3 py-2 text-sm transition-colors " +
                      (settings.sizzleAiMode === mode
                        ? "bg-panel-2 font-medium text-fg"
                        : "text-muted hover:text-fg")
                    }
                    title={
                      mode === "local"
                        ? "Run Ollama on this PC — started and stopped automatically"
                        : mode === "remote"
                          ? "Run the AI scan on another machine's Ollama (e.g. the streaming PC)"
                          : "Score frames with a cloud API — frees the GPU, pennies per VOD on Gemini Flash"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {settings.sizzleAiMode === "remote" && (
                <input
                  type="text"
                  value={settings.sizzleOllamaUrl}
                  onChange={(e) => setSettings({ sizzleOllamaUrl: e.target.value })}
                  placeholder="http://192.168.1.50:11434"
                  title="Base URL of the remote Ollama (needs OLLAMA_HOST=0.0.0.0 and the model pulled there)"
                  className={inputCls + " w-56 font-mono text-xs"}
                />
              )}
              {settings.sizzleAiMode === "cloud" && (
                <>
                  <select
                    value={settings.sizzleCloudModel}
                    onChange={(e) => setSettings({ sizzleCloudModel: e.target.value })}
                    className={inputCls + " text-xs"}
                    title="Which cloud model scores the frames — uses the API keys from Settings"
                  >
                    {CLOUD_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    <option value="custom">Custom…</option>
                  </select>
                  {settings.sizzleCloudModel === "custom" && (
                    <>
                      <input
                        type="text"
                        value={settings.sizzleCloudUrl}
                        onChange={(e) => setSettings({ sizzleCloudUrl: e.target.value })}
                        placeholder="https://host/v1/chat/completions"
                        title="OpenAI-compatible chat-completions endpoint"
                        className={inputCls + " w-56 font-mono text-xs"}
                      />
                      <input
                        type="text"
                        value={settings.sizzleCloudModelId}
                        onChange={(e) => setSettings({ sizzleCloudModelId: e.target.value })}
                        placeholder="model id"
                        className={inputCls + " w-32 font-mono text-xs"}
                      />
                      <select
                        value={settings.sizzleCloudKey}
                        onChange={(e) => setSettings({ sizzleCloudKey: e.target.value as ProviderId })}
                        title="Which stored API key to send"
                        className={inputCls + " text-xs"}
                      >
                        {(["openai", "anthropic", "gemini", "openai-compatible"] as const).map((k) => (
                          <option key={k} value={k}>{k} key</option>
                        ))}
                      </select>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => make()} disabled={!trimmed || busy} className={btnCls}>
            {running ? <Spinner className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
            {running ? "Working…" : "Make clips"}
          </button>
          {jobId && (
            <button
              onClick={reanalyze}
              disabled={busy}
              className={btnCls}
              title="Re-run the AI scan on the last job's already-downloaded video — no re-download. Raise “Top clips” first to get more clips."
            >
              <RefreshCw className="h-4 w-4" />
              Reanalyze
            </button>
          )}
          <button
            onClick={detect}
            disabled={!trimmed || isUrl || busy}
            className={btnCls}
            title={isUrl ? "Quick scan works on local files; use Make clips for URLs" : "Preview loudness timestamps"}
          >
            <Scissors className="h-4 w-4" />
            {detecting ? "Scanning…" : "Quick audio scan"}
          </button>
        </div>

        {progress && (
          <div className="mt-3 rounded-lg border border-line bg-bg px-3 py-2">
            {running && (
              <div className="mb-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="h-full rounded-full bg-cyan transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-9 text-right font-mono text-[11px] tabular-nums text-faint">{pct}%</span>
              </div>
            )}
            <div className="font-mono text-xs text-muted">{progress}</div>
          </div>
        )}
      </Card>

      {clips && clips.length > 0 && (
        <ClipsWorkspace
          clips={clips}
          jobId={jobId}
          sortByScore={sortByScore}
          setSortByScore={setSortByScore}
          selected={selected}
          setSelected={setSelected}
          compiling={compiling}
          onEdit={setEditing}
          onPlay={setPlaying}
          onCaption={caption}
          captioning={captioning}
          onCompile={async () => {
            if (!jobId || selected.size < 2 || compiling) return;
            setCompiling(true);
            try {
              // Preserve grid order (score or time) in the compilation.
              const order = sortClips(clips, sortByScore).map((c) => c.name);
              const names = order.filter((n) => selected.has(n));
              await api.makeCompilation(jobId, names, clipsDir);
              setClips(await api.listClips(jobId, clipsDir));
              setSelected(new Set());
              notify.success("Compilation built.");
            } catch (e) {
              notify.error(e);
            } finally {
              setCompiling(false);
            }
          }}
        />
      )}

      {playing && <PlayerModal clip={playing} onClose={() => setPlaying(null)} />}
      {layoutSrc && <LayoutModal source={layoutSrc} onClose={() => setLayoutSrc(null)} />}

      {editing && jobId && (
        <TrimModal
          clip={editing}
          jobId={jobId}
          clipsDir={clipsDir}
          onClose={() => setEditing(null)}
          onSave={async (start, end) => {
            try {
              await api.recutClip(jobId, editing.name, start, end, clipsDir);
              setClips(await api.listClips(jobId, clipsDir));
              setEditing(null);
              notify.success("Clip re-cut.");
            } catch (e) {
              notify.error(e);
            }
          }}
        />
      )}

      {highlights && !clips && (
        <Card className="mt-4 p-5">
          <SectionTitle right={<span className="text-xs text-faint">loudness spikes</span>}>
            Detected highlights
          </SectionTitle>
          {highlights.length === 0 ? (
            <EmptyState title="No loud moments found — is there an audio track?" />
          ) : (
            <div className="space-y-1.5">
              {highlights.map((h, i) => (
                <div
                  key={i}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm"
                >
                  <span className="font-mono text-muted">
                    {clock(h.start)} → {clock(h.end)}
                  </span>
                  <span className="tabular-nums text-fg">+{h.score.toFixed(1)} dB</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}

/** The clips grid: excitement sort + tier tags, per-clip play/reveal/adjust,
 * and a compilation builder (select clips → stitch). */
function ClipsWorkspace({
  clips,
  jobId,
  sortByScore,
  setSortByScore,
  selected,
  setSelected,
  compiling,
  onEdit,
  onPlay,
  onCaption,
  captioning,
  onCompile,
}: {
  clips: Clip[];
  jobId: string | null;
  sortByScore: boolean;
  setSortByScore: (v: boolean) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  compiling: boolean;
  onEdit: (c: Clip) => void;
  onPlay: (c: Clip) => void;
  onCaption: (c: Clip) => void;
  captioning: string | null;
  onCompile: () => void;
}) {
  const settings = useSettings();
  const ordered = sortClips(clips, sortByScore);
  const canEdit = isTauri() || jobId !== null; // recut/compile need a live backend
  const toggle = (name: string) => {
    const next = new Set(selected);
    next.has(name) ? next.delete(name) : next.add(name);
    setSelected(next);
  };

  return (
    <Card className="mt-4 p-5">
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5">
            <select
              value={settings.sizzleCaptionStyle}
              onChange={(e) =>
                setSettings({ sizzleCaptionStyle: e.target.value as "bold" | "karaoke" | "minimal" })
              }
              className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-xs text-fg outline-none"
              title="Caption style"
            >
              <option value="bold">Bold pop</option>
              <option value="karaoke">Karaoke</option>
              <option value="minimal">Minimal</option>
            </select>
            <button
              onClick={() => setSortByScore(!sortByScore)}
              className={btnCls + " px-2.5 py-1 text-xs"}
              title="Toggle sort"
            >
              {sortByScore ? <Flame className="h-3.5 w-3.5" /> : <ListVideo className="h-3.5 w-3.5" />}
              {sortByScore ? "By excitement" : "By time"}
            </button>
          </span>
        }
      >
        Clips ({clips.length})
      </SectionTitle>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ordered.map((c) => {
          const t = tier(c);
          const len = c.end > c.start ? Math.round(c.end - c.start) : 0;
          const picked = selected.has(c.name);
          const stitched = isStitched(c);
          return (
            <div
              key={c.path}
              className={
                "flex items-center gap-2.5 rounded-lg border bg-panel-2 px-3 py-2.5 transition-colors " +
                (picked ? "border-accent" : "border-line")
              }
            >
              {canEdit && !stitched && (
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={() => toggle(c.name)}
                  className="h-4 w-4 shrink-0 accent-cyan"
                  title="Add to compilation"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {stitched ? (
                    <Film className="h-3.5 w-3.5 shrink-0 text-violet" />
                  ) : t ? (
                    <t.icon className="h-3.5 w-3.5 shrink-0" style={{ color: t.color }} />
                  ) : null}
                  <span className="truncate font-mono text-sm text-fg">{c.name}</span>
                  {c.vertical && <span className="shrink-0 text-[11px] text-faint">9:16</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-faint">
                  {len > 0 && <span>{len}s</span>}
                  {c.end > c.start && (
                    <span>
                      {clock(c.start)}–{clock(c.end)}
                    </span>
                  )}
                  {c.aiScored ? (
                    <span className="tabular-nums text-muted">AI {Math.round(c.score)}</span>
                  ) : (
                    c.score > 0 && <span className="tabular-nums text-muted">+{c.score.toFixed(1)} dB</span>
                  )}
                </div>
                {c.reason && (
                  <div className="mt-0.5 truncate text-[11px] text-faint" title={c.reason}>
                    {c.reason}
                  </div>
                )}
              </div>
              {canEdit && !stitched && (
                <button
                  onClick={() => onCaption(c)}
                  disabled={captioning !== null}
                  className={btnCls + " shrink-0 px-2 py-1"}
                  title="Burn animated captions into a copy of this clip"
                >
                  {captioning === c.name ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Captions className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              {isTauri() ? (
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => onPlay(c)} className={btnCls + " px-2 py-1"} title="Play">
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  {!stitched && canEdit && (
                    <button
                      onClick={() => onEdit(c)}
                      className={btnCls + " px-2 py-1"}
                      title="Adjust start & end"
                    >
                      <Scissors className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => api.revealPath(c.path).catch((e) => notify.error(String(e)))}
                    className={btnCls + " px-2 py-1"}
                    title="Reveal in folder"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <span className="shrink-0 truncate font-mono text-[11px] text-faint">{c.path}</span>
              )}
            </div>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
          <span className="flex-1 text-sm text-fg">
            {selected.size} clip{selected.size === 1 ? "" : "s"} selected for a compilation
          </span>
          <button onClick={() => setSelected(new Set())} className={btnCls + " px-2.5 py-1 text-xs"}>
            Clear
          </button>
          <button
            onClick={onCompile}
            disabled={selected.size < 2 || compiling}
            className={btnCls + " px-3 py-1.5"}
          >
            {compiling ? <Spinner className="h-4 w-4" /> : <Film className="h-4 w-4" />}
            Make compilation
          </button>
        </div>
      )}
    </Card>
  );
}

/** In-app clip player — streams the file over Tauri's asset protocol, so no
 * external video app is needed. */
function PlayerModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-[16px] border border-outline bg-surface-2 p-4 shadow-[var(--cm-shadow-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <Play className="h-4 w-4 text-cyan" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{clip.name}</span>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:text-cyan" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <video
          src={convertFileSrc(clip.path)}
          controls
          autoPlay
          className="max-h-[70vh] w-full rounded-lg bg-black"
        />
        {clip.reason && <p className="mt-2 text-[11px] text-muted">{clip.reason}</p>}
      </div>
    </div>
  );
}

/** Adjust start & end: trim OR extend a clip's bounds (seconds), then re-cut. */
function TrimModal({
  clip,
  jobId,
  clipsDir,
  onClose,
  onSave,
}: {
  clip: Clip;
  jobId: string | null;
  clipsDir?: string;
  onClose: () => void;
  onSave: (start: number, end: number) => void | Promise<void>;
}) {
  const [start, setStart] = useState(clip.start);
  const [end, setEnd] = useState(clip.end);
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"in" | "out" | null>(null);
  const len = Math.max(0, end - start);

  // Window the timeline to ±30s around the clip's original bounds; handles
  // clamp at the edges (extend further with the number fields if needed).
  const win0 = Math.max(0, clip.start - 30);
  const win1 = clip.end + 30;
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - win0) / (win1 - win0)) * 100));

  useEffect(() => {
    if (!isTauri() || !jobId) return;
    api
      .sizzleSource(jobId, clipsDir)
      .then(setSource)
      .catch(() => {}); // no source → numeric-only modal, same as web
  }, [jobId, clipsDir]);

  function trackTime(e: React.PointerEvent): number {
    const r = trackRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return win0 + f * (win1 - win0);
  }

  function onTrackDown(e: React.PointerEvent) {
    const t = trackTime(e);
    // Grab the nearer handle; plain clicks scrub the preview.
    const dIn = Math.abs(t - start);
    const dOut = Math.abs(t - end);
    if (Math.min(dIn, dOut) < (win1 - win0) * 0.03) {
      dragRef.current = dIn <= dOut ? "in" : "out";
      (e.target as Element).setPointerCapture(e.pointerId);
    } else if (videoRef.current) {
      videoRef.current.currentTime = t;
    }
  }

  function onTrackMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const t = Math.round(trackTime(e) * 10) / 10;
    if (dragRef.current === "in") setStart(Math.min(t, end - 0.5));
    else setEnd(Math.max(t, start + 0.5));
  }

  function playSelection() {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start;
    void v.play();
  }

  const step = (setter: (v: number) => void, cur: number, delta: number) =>
    setter(Math.max(0, Math.round((cur + delta) * 10) / 10));

  async function save() {
    if (!(end > start) || saving) return;
    setSaving(true);
    try {
      await onSave(start, end);
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, value: number, setter: (v: number) => void) => (
    <div className="flex-1">
      <div className="mb-1 text-xs font-medium text-faint">{label}</div>
      <div className="flex items-center gap-1">
        <button onClick={() => step(setter, value, -1)} className={btnCls + " px-2 py-1.5"} title="-1s">
          −
        </button>
        <input
          type="number"
          step={0.5}
          min={0}
          value={value}
          onChange={(e) => setter(Math.max(0, +e.target.value || 0))}
          className={inputCls + " text-center font-mono"}
        />
        <button onClick={() => step(setter, value, 1)} className={btnCls + " px-2 py-1.5"} title="+1s">
          +
        </button>
      </div>
      <div className="mt-1 text-center font-mono text-[11px] text-faint">{clock(value)}</div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-[16px] border border-outline bg-surface-2 p-5 shadow-[var(--cm-shadow-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <Scissors className="h-4 w-4 text-cyan" />
          <span className="flex-1 font-body text-sm font-semibold text-text">Adjust start &amp; end</span>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:text-cyan" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-1 font-mono text-xs text-faint">{clip.name}</div>
        <p className="mb-3 text-[11px] text-muted">
          Trim in, or extend past the original window. The clip is re-cut from the source video.
        </p>
        {source && (
          <div className="mb-3">
            <video
              ref={videoRef}
              src={convertFileSrc(source)}
              className="max-h-[40vh] w-full rounded-lg bg-black"
              onLoadedMetadata={() => {
                if (videoRef.current) videoRef.current.currentTime = start;
              }}
              onTimeUpdate={() => {
                const v = videoRef.current;
                if (v && !v.paused && v.currentTime >= end) v.pause();
              }}
              controls={false}
            />
            <div
              ref={trackRef}
              className="relative mt-2 h-8 cursor-pointer rounded-lg bg-panel-2"
              style={{ touchAction: "none" }}
              onPointerDown={onTrackDown}
              onPointerMove={onTrackMove}
              onPointerUp={() => (dragRef.current = null)}
              onPointerCancel={() => (dragRef.current = null)}
            >
              {/* selected region */}
              <div
                className="absolute inset-y-0 rounded bg-cyan/25"
                style={{ left: `${pos(start)}%`, width: `${Math.max(0, pos(end) - pos(start))}%` }}
              />
              {/* in/out handles */}
              <div
                className="absolute inset-y-0 w-1.5 rounded bg-cyan"
                style={{ left: `calc(${pos(start)}% - 3px)` }}
              />
              <div
                className="absolute inset-y-0 w-1.5 rounded bg-cyan"
                style={{ left: `calc(${pos(end)}% - 3px)` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[10px] text-faint">
                {clock(win0)} – {clock(win1)}
              </span>
              <button onClick={playSelection} className={btnCls + " px-2 py-1 text-xs"}>
                <Play className="h-3 w-3" /> Preview selection
              </button>
            </div>
          </div>
        )}
        <div className="flex items-start gap-3">
          {field("Start", start, setStart)}
          <div className="pt-6 text-center">
            <div className="font-mono text-lg tabular-nums text-fg">{Math.round(len)}s</div>
            <div className="text-[10px] text-faint">length</div>
          </div>
          {field("End", end, setEnd)}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className={btnCls}>
            Cancel
          </button>
          <button onClick={save} disabled={!(end > start) || saving} className={btnCls}>
            {saving ? <Spinner className="h-4 w-4" /> : <Scissors className="h-4 w-4" />}
            Re-cut
          </button>
        </div>
      </div>
    </div>
  );
}

/** Position the facecam + gameplay crop boxes on a frame of the source video.
 * Boxes are normalized 0–1 and aspect-locked to their 1080×640 / 1080×1280
 * output slots. Saved to settings, reused by every facecam job. */
function LayoutModal({ source, onClose }: { source: string; onClose: () => void }) {
  const settings = useSettings();
  const [layout, setLayout] = useState<FacecamLayout>(
    settings.sizzleFacecam ?? {
      cam: { x: 0.72, y: 0.02, w: 0.26, h: 0.26 },
      game: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    }
  );
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // key of the box being dragged + mode, e.g. { key: "cam", resize: true }
  const dragRef = useRef<{ key: "cam" | "game"; resize: boolean; dx: number; dy: number } | null>(null);

  // Output slot aspect (w/h) each box must keep, in *source pixels*.
  const slotAspect = { cam: 1080 / 640, game: 1080 / 1280 };

  /** Locked normalized height for a normalized width, using the video dims. */
  function lockedH(key: "cam" | "game", w: number): number {
    const v = videoRef.current;
    const va = v && v.videoWidth ? v.videoWidth / v.videoHeight : 16 / 9;
    return (w * va) / slotAspect[key];
  }

  function onPointerDown(e: React.PointerEvent, key: "cam" | "game", resize: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const r = frameRef.current!.getBoundingClientRect();
    const b = layout[key];
    dragRef.current = {
      key,
      resize,
      dx: (e.clientX - r.left) / r.width - (resize ? b.w : b.x),
      dy: (e.clientY - r.top) / r.height - (resize ? b.h : b.y),
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const r = frameRef.current!.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - d.dx;
    const py = (e.clientY - r.top) / r.height - d.dy;
    setLayout((l) => {
      const b = { ...l[d.key] };
      if (d.resize) {
        b.w = Math.min(1, Math.max(0.08, px));
        b.h = lockedH(d.key, b.w);
        if (b.h > 1) {
          b.h = 1;
          // Re-derive width from the clamped height to keep the lock.
          const v = videoRef.current;
          const va = v && v.videoWidth ? v.videoWidth / v.videoHeight : 16 / 9;
          b.w = Math.min(1, (b.h * slotAspect[d.key]) / va);
        }
      } else {
        b.x = px;
        b.y = py;
      }
      b.x = Math.min(Math.max(b.x, 0), 1 - b.w);
      b.y = Math.min(Math.max(b.y, 0), 1 - b.h);
      return { ...l, [d.key]: b };
    });
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  // Snap both boxes' aspects once the video reports its real dimensions.
  function onMeta() {
    setLayout((l) => ({
      cam: { ...l.cam, h: Math.min(1, lockedH("cam", l.cam.w)) },
      game: { ...l.game, h: Math.min(1, lockedH("game", l.game.w)) },
    }));
  }

  const boxStyle = (key: "cam" | "game", color: string): React.CSSProperties => ({
    position: "absolute",
    left: `${layout[key].x * 100}%`,
    top: `${layout[key].y * 100}%`,
    width: `${layout[key].w * 100}%`,
    height: `${layout[key].h * 100}%`,
    border: `2px solid ${color}`,
    boxShadow: "0 0 0 9999px rgba(0,0,0,0.0)",
    cursor: "move",
    touchAction: "none",
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-[16px] border border-outline bg-surface-2 p-4 shadow-[var(--cm-shadow-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <LayoutTemplate className="h-4 w-4 text-cyan" />
          <span className="flex-1 text-sm font-semibold text-text">
            Facecam layout — <span className="text-cyan">cam</span> on top,{" "}
            <span className="text-violet">gameplay</span> below
          </span>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:text-cyan" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={frameRef}
          className="relative select-none overflow-hidden rounded-lg bg-black"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <video
            ref={videoRef}
            src={convertFileSrc(source)}
            className="w-full"
            muted
            onLoadedMetadata={onMeta}
          />
          {(["game", "cam"] as const).map((key) => {
            const color = key === "cam" ? "#00f5ff" : "#c000ff";
            return (
              <div key={key} style={boxStyle(key, color)} onPointerDown={(e) => onPointerDown(e, key, false)}>
                <span
                  className="absolute left-1 top-0.5 font-mono text-[10px] font-bold"
                  style={{ color, textShadow: "0 0 4px #000" }}
                >
                  {key === "cam" ? "CAM" : "GAME"}
                </span>
                <div
                  onPointerDown={(e) => onPointerDown(e, key, true)}
                  className="absolute -bottom-1.5 -right-1.5 h-4 w-4 rounded-full"
                  style={{ background: color, cursor: "nwse-resize" }}
                />
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Drag a box to move it; drag its corner dot to resize (aspect locked to the output slot).
          Scrub the job's clips beforehand if you need a frame where the cam is visible.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className={btnCls}>
            Cancel
          </button>
          <button
            onClick={() => {
              setSettings({ sizzleFacecam: layout, sizzleFacecamOn: true });
              notify.success("Layout saved — vertical clips will use it.");
              onClose();
            }}
            className={btnCls}
          >
            Save layout
          </button>
        </div>
      </div>
    </div>
  );
}
