// Meeting recorder flow: record (mic + system audio in Rust) → transcribe in
// chunks via the configured STT provider → meeting note into the vault
// (output/meetings/) → git sync. Feature-parity with the old Obsidian Whisper
// plugin, plus system-audio capture so Teams/Zoom needs no loopback cable.

import { useSyncExternalStore } from "react";
import { aiRequest, api, isTauri } from "../api";
import { isProviderReady, runPrompt } from "./ai";
import { getSettings } from "./settings";
import { sttProvider } from "./stt";
import { notify } from "./toast";
import { keyRef } from "./secrets";
import { cloudBackend } from "./cloudVision";
import type { CaptureWindow } from "../types";

export type RecPhase = "idle" | "recording" | "transcribing" | "writing";

export interface MeetingRecState {
  phase: RecPhase;
  startedAt: number | null;
  sources: string;
  title: string;
  windows: CaptureWindow[] | null;
  /** Timestamped pipeline steps for the pill's log modal; reset per run. */
  log: string[];
}

let state: MeetingRecState = {
  phase: "idle",
  startedAt: null,
  sources: "",
  title: "",
  windows: null,
  log: [],
};
let listeners: Array<() => void> = [];

function emit(next: Partial<MeetingRecState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function logStep(msg: string) {
  const t = new Date().toTimeString().slice(0, 8);
  emit({ log: [...state.log, `${t}  ${msg}`] });
}

export function useMeetingRec(): MeetingRecState {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => state
  );
}

export type SttEngine = "whisperx" | "elevenlabs" | "openai";

/** Local WhisperX (GPU) wins when configured; else ElevenLabs; else OpenAI. */
export function meetingSttEngine(): SttEngine | null {
  if (getSettings().whisperxUrl.trim()) return "whisperx";
  return sttProvider();
}

/** STT request parts for the recorder backend (mirrors lib/stt.ts).
 * WhisperX and ElevenLabs both diarize and take the whole file in one
 * request; plain Whisper has neither, so it chunks. */
function sttParts(): {
  engine: SttEngine;
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  fileField: string;
  chunkSecs: number;
} {
  const s = getSettings();
  const engine = meetingSttEngine();
  if (!engine) {
    throw new Error(
      "Set a WhisperX URL or an ElevenLabs/OpenAI API key in Settings to transcribe meetings."
    );
  }
  if (engine === "whisperx") {
    const base = whisperxBase(s.whisperxUrl);
    return {
      engine,
      // enable_diarization is the param this service actually honors; speaker
      // labels additionally need the gated pyannote model authorized on the
      // HF token, else it transcribes without speakers.
      url: `${base}/asr?output_format=json&enable_diarization=true&language=en`,
      headers: {},
      fields: {},
      fileField: "audio_file",
      chunkSecs: 8 * 3600,
    };
  }
  return engine === "elevenlabs"
    ? {
        engine,
        url: "https://api.elevenlabs.io/v1/speech-to-text",
        headers: { "xi-api-key": keyRef("eleven-api-key", s.elevenApiKey) },
        fields: { model_id: "scribe_v1", language_code: "en", diarize: "true" },
        fileField: "file",
        chunkSecs: 4 * 3600, // effectively "don't chunk"
      }
    : {
        engine,
        url: "https://api.openai.com/v1/audio/transcriptions",
        headers: { Authorization: `Bearer ${keyRef("openai-api-key", s.apiKeys.openai)}` },
        fields: { model: "whisper-1", language: "en" },
        fileField: "file",
        chunkSecs: 600,
      };
}

/** STT request parts for clip captions: word timestamps wanted, diarization
 * skipped (it's slow and captions don't need speakers). WhisperX wins when
 * configured; else OpenAI Whisper (verbose_json gives word timing too). */
export function captionStt(): {
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  fileField: string;
  whisperx: boolean;
} {
  const s = getSettings();
  if (s.whisperxUrl.trim()) {
    return {
      url: `${whisperxBase(s.whisperxUrl)}/asr?output_format=json&language=en&word_timestamps=true`,
      headers: {},
      fields: {},
      fileField: "audio_file",
      whisperx: true,
    };
  }
  if (s.apiKeys.openai) {
    return {
      url: "https://api.openai.com/v1/audio/transcriptions",
      headers: { Authorization: `Bearer ${keyRef("openai-api-key", s.apiKeys.openai)}` },
      fields: {
        model: "whisper-1",
        language: "en",
        response_format: "verbose_json",
        "timestamp_granularities[]": "word",
      },
      fileField: "file",
      whisperx: false,
    };
  }
  throw new Error("Set a WhisperX URL or an OpenAI API key in Settings to caption clips.");
}

/** Normalized service base URL: scheme defaulted to http (it's a local
 * container — https://localhost just fails TLS), trailing slashes dropped. */
function whisperxBase(url: string): string {
  let b = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
  return b;
}

/** Make sure the WhisperX container is up; returns true if WE started it (so
 * the caller stops it after — this is a gaming PC, don't hog the GPU). */
export async function ensureWhisperx(): Promise<boolean> {
  const s = getSettings();
  const name = s.whisperxContainer.trim();
  if (!name) return false;
  const st = await api.dockerContainer(name, "status");
  // Daemon down → exists is meaningless; "start" boots Docker Desktop itself.
  if (st.daemonUp && !st.exists) throw new Error(`Docker container "${name}" not found.`);
  let started = false;
  if (!st.running) {
    logStep(
      st.daemonUp
        ? `Starting WhisperX container (${name})…`
        : "Docker is off — booting Docker Desktop, then the WhisperX container…"
    );
    await api.dockerContainer(name, "start");
    started = true;
  }
  // Wait for the model to be ready (cold start loads weights onto the GPU).
  if (started) logStep("Waiting for WhisperX to load its model (GPU cold start)…");
  const base = whisperxBase(s.whisperxUrl);
  const deadline = Date.now() + 180_000;
  let lastErr = "";
  for (;;) {
    try {
      const r = await aiRequest(`${base}/health`, {}, "", "GET");
      if (r.status < 300) break;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = String((e as { message?: string })?.message ?? e);
    }
    if (Date.now() > deadline) {
      // Don't leave a container WE started hogging the GPU after a failure.
      if (started) api.dockerContainer(name, "stop").catch(() => {});
      throw new Error(
        `WhisperX at ${base} didn't answer /health in 3 minutes` +
          (lastErr ? ` — last error: ${lastErr}` : "") +
          ". Check the Service URL in Settings (plain http:// for localhost)."
      );
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return started;
}

// True while a container WE started during recording is still warm, so the
// note pipeline knows to stop it afterwards even though its own ensureWhisperx
// finds it already running.
let warmStarted = false;

// Seconds between audio recording start and the screen capture actually
// starting (picker dwell time) — visual timestamps are video-relative, so
// this is added back before comparing them against audio-relative segments.
let screenOffsetSecs = 0;

export async function startMeetingRecording(
  title?: string,
  opts?: { auto?: boolean }
): Promise<void> {
  if (state.phase !== "idle") return;
  try {
    const { engine } = sttParts(); // fail fast if no STT key — don't record something we can't transcribe
    const sources = await api.startRecording();
    screenOffsetSecs = 0;
    emit({ phase: "recording", startedAt: Date.now(), sources, title: title ?? "", log: [] });
    logStep(`Recording started (${sources})`);
    notify.info(`Recording (${sources})`);
    if (!opts?.auto && getSettings().meetingScreenRec && isTauri()) {
      api
        .listCaptureWindows()
        .then((ws) => {
          // An empty list is a listing failure in disguise — no useless
          // Skip-only picker; recording continues audio-only.
          if (state.phase === "recording" && ws.length) emit({ windows: ws });
        })
        .catch(() => {}); // listing failed — audio-only, no picker
    }
    if (engine === "whisperx") {
      // Warm Docker + the ASR container during the meeting (boots Docker
      // Desktop itself when the daemon is down) so transcription starts the
      // moment recording stops. Failures stay silent here — the stop path
      // retries and surfaces them.
      // ponytail: if warm-up finishes after the note pipeline already read
      // warmStarted (sub-minute recording), the container stays up; next
      // meeting reuses it and stops it.
      void ensureWhisperx()
        .then((started) => {
          warmStarted = warmStarted || started;
        })
        .catch(() => {});
    }
  } catch (e) {
    notify.error(String((e as { message?: string })?.message ?? e));
  }
}

/** Window picked (or null = skip). Closes the picker either way. */
export async function chooseCaptureWindow(title: string | null): Promise<void> {
  emit({ windows: null });
  if (!title) return;
  // ponytail: don't cache the path client-side — the backend tracks the
  // active capture and hands the path back from stopScreenRecord() on stop.
  try {
    await api.startScreenRecord(title);
    screenOffsetSecs = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
    notify.info("Screen capture started");
  } catch (e) {
    notify.error(`Screen capture failed: ${String((e as { message?: string })?.message ?? e)} — recording audio only`);
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "meeting"
  );
}

function durLabel(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function stopMeetingRecording(): Promise<void> {
  if (state.phase !== "recording") return;
  autoKey = null; // manual or auto — either way this recording's auto claim ends
  const title = state.title || `Meeting ${new Date().toLocaleString()}`;
  try {
    emit({ phase: "transcribing", windows: null });
    logStep("Stopping — finalizing audio and screen capture…");
    let screen: string | null = null;
    try {
      screen = await api.stopScreenRecord();
    } catch {
      /* audio pipeline continues regardless */
    }
    const done = await api.stopRecording();
    logStep(`Audio finalized (${durLabel(done.seconds)}, ${done.sources})${screen ? " + screen video" : ""}`);
    await fileMeetingNote(done, title, new Date(), screen);
  } catch (e) {
    emit({ phase: "idle", startedAt: null, title: "", windows: null });
    notify.error(String((e as { message?: string })?.message ?? e));
  }
}

/** Import an existing audio/video file: convert → transcribe → note. */
export async function importAudioNote(src: string, title?: string): Promise<void> {
  if (state.phase !== "idle") return;
  const t =
    title?.trim() ||
    src.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ||
    "Imported meeting";
  try {
    sttParts(); // fail fast without an STT key
    emit({ phase: "transcribing", startedAt: null, sources: "import", title: t, log: [] });
    logStep(`Importing ${src.trim()} — converting to 16 kHz mono…`);
    const done = await api.importRecording(src.trim());
    await fileMeetingNote(done, t);
  } catch (e) {
    emit({ phase: "idle", startedAt: null, title: "", windows: null });
    notify.error(String((e as { message?: string })?.message ?? e));
  }
}

/** Re-run transcribe → summary → note for a recording already on disk — the
 * rescue path when the pipeline died after capture (docker down, STT error). */
export async function retryRecordingNote(
  rec: import("../types").RecordingFile,
  title?: string
): Promise<void> {
  if (state.phase !== "idle") return;
  const t =
    title?.trim() ||
    `Meeting ${new Date(rec.modified ?? Date.now()).toLocaleString()}`;
  try {
    sttParts(); // fail fast without an STT provider
    emit({ phase: "transcribing", startedAt: null, sources: "retry", title: t, log: [] });
    logStep(`Rescuing ${rec.name}…`);
    // Re-attach the matched screen capture; its filename epoch vs the audio
    // start (mtime end - duration) recovers the picker-dwell offset that the
    // live path tracks in screenOffsetSecs.
    const screen = rec.screenPath;
    if (screen) {
      const epoch = Number(/screen-(\d+)\.mp4$/i.exec(screen)?.[1] ?? NaN);
      const endSec = rec.modified ? Date.parse(rec.modified) / 1000 : NaN;
      const startSec = endSec - rec.seconds;
      screenOffsetSecs =
        Number.isFinite(epoch) && Number.isFinite(startSec) ? Math.max(0, epoch - startSec) : 0;
      logStep(`Matched screen capture (${screen.split(/[\\/]/).pop()}) — visual analysis will run`);
    }
    await fileMeetingNote(
      {
        path: rec.path,
        micPath: rec.micPath,
        sysPath: rec.sysPath,
        seconds: rec.seconds,
        sources: rec.micPath && rec.sysPath ? "mic + system" : "import",
      },
      t,
      rec.modified ? new Date(rec.modified) : new Date(),
      screen
    );
  } catch (e) {
    emit({ phase: "idle", startedAt: null, title: "", windows: null });
    notify.error(String((e as { message?: string })?.message ?? e));
  }
}

/** Transcribe a finished recording and file the vault note (shared tail of
 * stop + import). Two-track ("Me" + diarized others) when tracks exist and
 * the provider supports diarization; mixed single-file otherwise. */
async function fileMeetingNote(
  done: import("../types").RecordingDone,
  title: string,
  when: Date = new Date(),
  screen: string | null = null
): Promise<void> {
    // Ollama visual analysis first, then WhisperX transcription — both want the GPU.
    let visuals: import("../types").VisualNote[] = [];
    let speakers: [number, string][] = [];
    let visualOffset = 0;
    if (screen) {
      visualOffset = screenOffsetSecs;
      screenOffsetSecs = 0;
      const s = getSettings();
      // The WhisperX ASR container is pre-warmed during recording (see
      // startMeetingRecording), so it's holding VRAM while local Ollama
      // analysis runs below — stop it first (only if WE started it; the
      // later ensureWhisperx() re-warms it before transcription needs it).
      if (
        meetingSttEngine() === "whisperx" &&
        s.sizzleAiMode === "local" &&
        warmStarted
      ) {
        await api.dockerContainer(s.whisperxContainer.trim(), "stop").catch(() => {});
      }
      // ponytail: if the container was already running before we started
      // recording (not warmStarted), it's not ours to stop — it stays warm
      // and competes with Ollama for VRAM. Upgrade if that co-residency
      // measurably slows analysis: query GPU mem before deciding to analyze.
      try {
        logStep(`Analyzing screen video (${s.sizzleAiMode} AI)…`);
        const analysis = await api.analyzeMeetingVideo(
          screen,
          s.sizzleAiMode === "remote" ? s.sizzleOllamaUrl : undefined,
          s.sizzleAiMode === "cloud" ? cloudBackend(s) : undefined
        );
        visuals = analysis.visuals;
        speakers = analysis.speakers;
        logStep(`Visual analysis done — ${visuals.length} on-screen notes, ${speakers.length} speaker sightings`);
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        logStep(`Visual analysis failed (continuing without it): ${msg}`);
        notify.error(`Visual analysis failed: ${msg}`);
      }
    }

    const { engine, url, headers, fields, fileField, chunkSecs } = sttParts();
    let startedContainer = warmStarted;
    warmStarted = false;
    if (engine === "whisperx") startedContainer = (await ensureWhisperx()) || startedContainer;
    logStep(`Transcribing with ${engine}…`);
    let transcript: string;
    try {
      transcript =
        engine === "openai"
          ? await api.transcribeRecording(done.path, url, headers, fields, chunkSecs)
          : await api.transcribeMeeting(
              done.micPath,
              // No per-source tracks (imports) → diarize the mixed file.
              done.sysPath ?? (done.micPath ? null : done.path),
              url,
              headers,
              fields,
              fileField,
              visuals.map((v) => [v.t + visualOffset, v.text] as [number, string]),
              speakers.map(([t, n]) => [t + visualOffset, n] as [number, string])
            );
      if (engine === "openai" && visuals.length) {
        transcript += `\n\n## On screen\n\n${visuals
          .map((v) => {
            const t = v.t + visualOffset;
            return `- **[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}]** ${v.text}`;
          })
          .join("\n")}`;
      }
    } finally {
      // Free the GPU again — only if we were the ones who started it.
      if (startedContainer) {
        api.dockerContainer(getSettings().whisperxContainer.trim(), "stop").catch(() => {});
      }
    }

    emit({ phase: "writing" });
    logStep(`Transcript ready (${transcript.length.toLocaleString()} chars)`);
    let summary = "";
    if (isProviderReady(getSettings())) {
      // Name the diarized speakers first so the summary uses real names.
      try {
        logStep("Naming speakers + summarizing…");
        transcript = renameSpeakers(transcript, await aiNameSpeakers(transcript));
      } catch {
        /* best-effort; anonymous labels stay, renameable from the Deck */
      }
      try {
        summary = await runPrompt(
          `Summarize this meeting transcript in markdown: 3-6 bullet points of key topics/decisions, then a line "Action items:" followed by a bullet list (who → what, if stated). ${NO_HEADINGS} Be concise.\n\nTranscript:\n${transcript.slice(0, 24000)}`,
          700
        );
      } catch {
        /* summary is best-effort; the transcript is the record */
      }
    }

    const date = when.toISOString().slice(0, 10);
    const note = [
      "---",
      `title: ${title.replace(/[:\n]/g, " ").trim()}`,
      `date: ${when.toISOString()}`,
      `duration: ${durLabel(done.seconds)}`,
      `sources: ${done.sources}`,
      `audio: ${done.path.replace(/\\/g, "/")}`,
      ...(screen ? [`video: ${screen.replace(/\\/g, "/")}`] : []),
      "type: meeting",
      "---",
      "",
      `# ${title}`,
      "",
      ...(summary ? ["## Summary", "", summary, ""] : []),
      "## Transcript",
      "",
      transcript,
      "",
    ].join("\n");

    const vault = getSettings().vaultDir.trim();
    const rel = `output/meetings/${date} ${slug(title)}.md`;
    if (!vault) throw new Error("Set your vault folder in Settings to file meeting notes.");
    await api.writeVaultFile(vault, rel, note);
    logStep(`Note written — ${rel}; rebuilding people pages + git sync…`);
    // People pages aggregate per-person actions/meetings; rebuild then sync once.
    const { rebuildPeoplePages } = await import("./people");
    await rebuildPeoplePages(vault).catch(() => 0);
    api.syncVaultGit(vault).catch(() => {});

    // Follow-through: my action items flow straight into the Deck to-dos
    // (addTodo dedupes open items, so re-filed notes don't double up).
    try {
      const mine = myActions(parseMeetingNote(note).actions);
      if (mine.length) {
        const { addTodo } = await import("./deckStore");
        mine.forEach((a) => addTodo(a));
        notify.info(`${mine.length} action item${mine.length === 1 ? "" : "s"} → to-do list`);
      }
    } catch {
      /* best-effort */
    }

    emit({ phase: "idle", startedAt: null, title: "", windows: null });
    const abs = `${vault.replace(/[/\\]+$/, "")}/${rel}`;
    notify.success(`Meeting note saved — ${rel}`, () => {
      api.openUrl(`obsidian://open?path=${encodeURIComponent(abs)}`).catch(() => {});
    });
}

// --- Meeting-note parsing (for the Deck's Meeting notes section) ----------

export interface MeetingNoteParts {
  title: string;
  date: string | null;
  duration: string | null;
  summary: string;
  /** Bullet lines from the summary's "Action items" list (or all summary bullets). */
  actions: string[];
}

export function parseMeetingNote(md: string): MeetingNoteParts {
  const fm: Record<string, string> = {};
  let body = md;
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = md.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const c = line.indexOf(":");
      if (c > 0) fm[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    }
  }
  // The summary runs until "## Transcript" specifically — AI summaries may
  // contain their own ## headings, which must not end the section early.
  const sum = body.match(/^## Summary\s*\r?\n([\s\S]*?)(?=^## Transcript|$(?![\s\S]))/m);
  const summary = (sum?.[1] ?? "").trim();
  const bullets = (text: string) =>
    text
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*[-*]\s+(.*\S)/)?.[1] ?? "")
      .filter(Boolean);
  // Prefer bullets after an "Action items" marker; fall back to all summary bullets.
  const ai = summary.match(/action items?[^\n]*\r?\n([\s\S]*)/i);
  const actions = bullets(ai ? ai[1] : summary);
  return {
    title: fm.title || body.match(/^# (.+)$/m)?.[1] || "Meeting",
    date: fm.date || null,
    duration: fm.duration || null,
    summary,
    actions,
  };
}

/** Lowercased names that mean "the local user" (me, Deck name, Asana name). */
export function myNames(): string[] {
  const s = getSettings();
  return ["me", ...s.deckName.split(/\s+/), ...s.asanaMe.split(/\s+/)]
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 1 || n === "me");
}

/** The "who" of an action item ("**Jen** → do X" → "Jen"), or null. */
export function actionOwner(action: string): string | null {
  const m = action.match(/^\**(.{1,40}?)\**\s*→/);
  return m ? m[1].replace(/\*/g, "").trim() : null;
}

/** Action items owned by the local user. Items with no stated owner stay —
 * they're usually implicit-you. */
export function myActions(actions: string[]): string[] {
  const names = myNames();
  return actions.filter((a) => {
    const owner = actionOwner(a);
    if (!owner) return true;
    const lower = owner.toLowerCase();
    return names.some((n) => lower.includes(n));
  });
}

/** Distinct "**Speaker N:**" labels in a note's transcript, in first-seen order. */
export function transcriptSpeakers(md: string): string[] {
  const seen: string[] = [];
  for (const m of md.matchAll(/^\*\*(Speaker \d+):\*\*/gm)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** Rename diarized speaker labels throughout the note (e.g. Speaker 1 → Jen). */
export function renameSpeakers(md: string, names: Record<string, string>): string {
  let out = md;
  for (const [from, to] of Object.entries(names)) {
    const name = to.trim();
    if (!name || name === from) continue;
    out = out.split(`**${from}:**`).join(`**${name}:**`);
  }
  return out;
}

/** Validated Speaker→name map from an AI reply (pure, for tests). Keeps only
 * known labels with plausible names; drops "Me"/"Speaker N" non-answers. */
export function parseSpeakerNames(out: string, speakers: string[]): Record<string, string> {
  const m = out.match(/\{[\s\S]*?\}/);
  if (!m) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const name = String(v ?? "").trim();
    if (!speakers.includes(k)) continue;
    if (!name || name.length > 40 || /^(me|speaker \d+|unknown|n\/a)$/i.test(name)) continue;
    names[k] = name;
  }
  return names;
}

/** AI: infer real names for diarized "Speaker N" labels from transcript
 * context (people addressing each other, introductions). Only returns labels
 * the model is confident about — callers apply via renameSpeakers. */
export async function aiNameSpeakers(md: string): Promise<Record<string, string>> {
  const speakers = transcriptSpeakers(md);
  if (speakers.length === 0) return {};
  const me = getSettings().deckName.trim() || "the local user";
  const out = await runPrompt(
    `This meeting transcript has diarized speaker labels. "Me" is ${me}. Work out the real names of ${speakers.join(", ")} from context — people addressing each other by name, introductions, who is asked to do what. Reply with ONLY a JSON object mapping labels to names, e.g. {"Speaker 1":"Jen"}. Include ONLY labels you are confident about; if none, reply {}.\n\nTranscript:\n${noteTranscript(md).slice(0, 24000)}`,
    200
  );
  return parseSpeakerNames(out, speakers);
}

/** The transcript text of a meeting note (everything after "## Transcript"). */
export function noteTranscript(md: string): string {
  const m = md.match(/^## Transcript\s*\r?\n([\s\S]*)/m);
  return (m?.[1] ?? md).trim();
}

/** Replace (or insert) the "## Summary" section, keeping the transcript. */
export function withSummary(md: string, summary: string): string {
  const section = `## Summary\n\n${summary.trim()}\n\n`;
  if (/^## Summary\s*$/m.test(md)) {
    return md.replace(/^## Summary\s*\r?\n[\s\S]*?(?=^## Transcript)/m, section);
  }
  if (/^## Transcript\s*$/m.test(md)) {
    return md.replace(/^## Transcript/m, `${section}## Transcript`);
  }
  return `${md.trimEnd()}\n\n${section}`;
}

const NO_HEADINGS = "Use plain bullet lists only — no markdown headings.";

/** AI: (re)generate the summary section from the note's transcript. */
export async function aiSummarize(md: string): Promise<string> {
  const out = await runPrompt(
    `Summarize this meeting transcript in markdown: 3-6 bullet points of key topics/decisions, then a line "Action items:" followed by a bullet list (who → what, if stated). ${NO_HEADINGS} Be concise.\n\nTranscript:\n${noteTranscript(md).slice(0, 24000)}`,
    700
  );
  return out.trim();
}

/** AI: extract just the action items from the note's transcript. */
export async function aiExtractTasks(md: string): Promise<string[]> {
  const out = await runPrompt(
    `List every action item / task / follow-up from this meeting transcript. One per line, each starting with "- ", format "who → what" when the owner is stated. Output ONLY the bullet list, nothing else. If there are none, output "- none".\n\nTranscript:\n${noteTranscript(md).slice(0, 24000)}`,
    500
  );
  return out
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)/)?.[1] ?? "")
    .filter((t) => t && !/^none\b/i.test(t));
}

/** Merge freshly extracted tasks into the note's summary section (dedup). */
export function withTasks(md: string, tasks: string[]): string {
  const parts = parseMeetingNote(md);
  const existing = new Set(parts.actions.map((a) => a.toLowerCase()));
  const fresh = tasks.filter((t) => !existing.has(t.toLowerCase()));
  if (fresh.length === 0) return md;
  const hasMarker = /action items?/i.test(parts.summary);
  const summary = hasMarker
    ? `${parts.summary}\n${fresh.map((t) => `- ${t}`).join("\n")}`
    : `${parts.summary}${parts.summary ? "\n\n" : ""}Action items:\n${fresh.map((t) => `- ${t}`).join("\n")}`;
  return withSummary(md, summary);
}

// --- Auto-record --------------------------------------------------------
// Driven by the DeckReminders 30s ticker: start when a meeting begins, stop
// shortly after its scheduled end. Opt-in via settings.autoRecordMeetings.

const autoDone = new Set<string>(); // meetings already auto-recorded this session
let autoKey: string | null = null; // set while the CURRENT recording was auto-started
// Past the scheduled end, stop only after this much silence — overruns keep
// recording as long as anyone is still talking.
const END_SILENCE_SECS = 120;
// Hard cap past the scheduled end, even if audio continues (music, videos…).
const END_CAP_MS = 30 * 60_000;

export interface AutoRecEvent {
  title: string;
  start: Date;
  end: Date;
  kind: string;
}

export function autoRecordTick(events: AutoRecEvent[], now: Date, enabled: boolean): void {
  const key = (e: AutoRecEvent) => `${e.title}|${e.start.getTime()}`;

  // Auto-stop: only recordings we auto-started. Once the event's scheduled end
  // has passed, keep going while there's still audio (silence-aware), up to a cap.
  if (state.phase === "recording" && autoKey) {
    const ev = events.find((e) => key(e) === autoKey);
    const endMs = ev ? ev.end.getTime() : 0;
    if (!ev || now.getTime() >= endMs + END_CAP_MS) {
      autoKey = null;
      void stopMeetingRecording();
    } else if (now.getTime() >= endMs) {
      void api.recordingStatus().then((st) => {
        if (autoKey && st.recording && st.silenceSecs >= END_SILENCE_SECS) {
          autoKey = null;
          void stopMeetingRecording();
        }
      });
    }
    return;
  }

  if (!enabled || state.phase !== "idle") return;
  const current = events.find(
    (e) => e.kind !== "Block" && e.start <= now && now < e.end && !autoDone.has(key(e))
  );
  if (!current) return;
  const k = key(current);
  autoDone.add(k);
  void startMeetingRecording(current.title, { auto: true }).then(() => {
    // Claim the auto slot only if the recorder actually started.
    if (state.phase === "recording") autoKey = k;
  });
}

/** Re-attach to a recording that's already running in the backend (e.g. the
 * page reloaded, or it was started from another client). */
export async function hydrateMeetingRec(): Promise<void> {
  try {
    const s = await api.recordingStatus();
    if (s.recording && state.phase === "idle") {
      emit({
        phase: "recording",
        startedAt: Date.now() - s.seconds * 1000,
        sources: s.sources,
        title: "",
      });
    }
  } catch {
    /* mock mode / backend without recorder */
  }
}
