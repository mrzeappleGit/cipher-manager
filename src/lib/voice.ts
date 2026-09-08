// Voice assistant brain: the Rust ear emits voice-wake / voice-command events;
// this module transcribes the clip, routes it (quick intents → Home Assistant
// → Claude job), and answers via TTS + toast. Desktop only.

import { useSyncExternalStore } from "react";
import { api, isTauri } from "../api";
import { getSettings } from "./settings";
import { sttProvider } from "./stt";
import { speak } from "./speech";
import { notify } from "./toast";
import { startJob } from "./jobs";
import { recallAnswer } from "./recall";
import { addTodo } from "./deckStore";
import { startMeetingRecording, stopMeetingRecording } from "./meetingRec";
import * as deck from "./deck";
import type { DeckDashboard } from "../types";
import { keyRef, keyConfigured } from "./secrets";

export type VoicePhase = "off" | "listening" | "awake" | "thinking" | "speaking";

let phase: VoicePhase = "off";
let lastHeard = "";
let listeners: Array<() => void> = [];

function emit(next: VoicePhase, heard?: string) {
  phase = next;
  if (heard !== undefined) lastHeard = heard;
  for (const l of listeners) l();
}

export function useVoice(): { phase: VoicePhase; lastHeard: string } {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => snapshot()
  );
}
let snap: { phase: VoicePhase; lastHeard: string } = { phase, lastHeard };
function snapshot() {
  if (snap.phase !== phase || snap.lastHeard !== lastHeard) snap = { phase, lastHeard };
  return snap;
}

/** Soft two-tone chime on wake — WebAudio, no asset. */
function chime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    osc.start();
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.09);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.stop(ctx.currentTime + 0.26);
    osc.onended = () => void ctx.close();
  } catch {
    /* no audio out — fine */
  }
}

// Follow-up window: after an HA reply the mic re-arms so "and the kitchen too"
// works without re-waking. A silent window is cancelled by the ear (3s
// no-speech) without nagging.
let followUpArmed = false;
let haConv: { id: string; at: number } | null = null;
// When set, route() is being driven by typed text (Assistant panel): capture
// the reply instead of speaking, and skip the mic follow-up.
let capture: ((text: string) => void) | null = null;

async function reply(text: string, followUp = false) {
  if (capture) {
    capture(text);
    return;
  }
  emit("speaking");
  notify.success(`🎙 ${text}`);
  try {
    await speak("voice-reply", text);
  } catch {
    /* TTS not configured — toast already shown */
  }
  emit("listening");
  if (followUp) {
    followUpArmed = true;
    api.triggerVoice().catch(() => {
      followUpArmed = false;
    });
  }
}

/** Transcribe a command wav via the configured cloud STT (fast for 3s clips). */
async function transcribeClip(path: string): Promise<string> {
  const s = getSettings();
  const provider = sttProvider();
  if (!provider) throw new Error("Add an ElevenLabs or OpenAI API key for voice commands.");
  const text =
    provider === "elevenlabs"
      ? await api.transcribeRecording(
          path,
          "https://api.elevenlabs.io/v1/speech-to-text",
          { "xi-api-key": keyRef("eleven-api-key", s.elevenApiKey) },
          { model_id: "scribe_v1", language_code: "en" },
          4 * 3600
        )
      : await api.transcribeRecording(
          path,
          "https://api.openai.com/v1/audio/transcriptions",
          { Authorization: `Bearer ${keyRef("openai-api-key", s.apiKeys.openai)}` },
          { model: "whisper-1", language: "en" },
          600
        );
  // Diarization labels are noise for a one-speaker command.
  return text.replace(/\*\*[^*]+:\*\*\s*/g, "").trim();
}

const HOME_RE =
  /\b(lights?|lamp|scene|thermostat|temperature|heat|ac\b|air condition|lock|unlock|garage|fan|switch|plug|blinds?|curtains?|dim|brighten|turn (on|off)|vacuum)\b/i;

/** Today's agenda sentence from the shared deck cache (desktop keeps it fresh). */
async function agendaReply(): Promise<string> {
  const raw = await api.loadAppState("deck-cache").catch(() => null);
  if (!raw) return "I don't have your calendar cached yet.";
  const d = JSON.parse(raw) as DeckDashboard;
  const now = new Date();
  const events = deck.todaysEvents(deck.parseEvents(d), now).filter((e) => e.kind !== "Block");
  const left = events.filter((e) => e.end > now);
  if (left.length === 0) return "Nothing left on your calendar today.";
  const list = left
    .slice(0, 4)
    .map((e) => `${e.title} at ${deck.fmtTime(e.start)}`)
    .join(", ");
  return `${left.length} meeting${left.length === 1 ? "" : "s"} left today: ${list}.`;
}

async function route(text: string): Promise<void> {
  const t = text.toLowerCase().replace(/[.,!?]+$/, "").trim();
  const s = getSettings();
  if (!t) return void reply("I didn't catch that.");

  if (/^(stop|end) (the )?recording\b/.test(t)) {
    await stopMeetingRecording();
    return void reply("Stopping the recording.");
  }
  if (/^(start|begin) (a )?(meeting )?recording\b|^record (this|the) meeting\b/.test(t)) {
    await startMeetingRecording();
    return void reply("Recording.");
  }

  const run = t.match(/^(?:run|execute|launch) (?:the )?(?:script )?(.+)$/);
  if (run) {
    if (!s.actingMode) return void reply("Acting mode is off, so I can't run scripts.");
    const scripts = await api.listUserScripts().catch(() => [] as string[]);
    const want = run[1].replace(/\s+/g, "").toLowerCase();
    const hit = scripts.find((x) => x.replace(/\.(bat|cmd|ps1)$/i, "").replace(/\s+/g, "").toLowerCase() === want)
      ?? scripts.find((x) => x.toLowerCase().includes(run[1].trim().toLowerCase()));
    if (!hit) return void reply(`I don't have a script called ${run[1]}.`);
    try {
      await api.runUserScript(hit);
      return void reply(`Ran ${hit.replace(/\.[^.]+$/, "")}.`);
    } catch (e) {
      return void reply(`The script failed: ${String((e as Error).message ?? e).slice(0, 120)}`);
    }
  }

  const todo = t.match(/^(?:add|create|make) (?:a |an )?(?:to.?do|task|reminder)(?: to| for| that says)? (.+)$/);
  if (todo) {
    addTodo(todo[1]);
    return void reply(`Added: ${todo[1]}.`);
  }

  if (/\b(agenda|calendar|meetings? (today|left)|next meeting|what's next|whats next)\b/.test(t)) {
    return void reply(await agendaReply());
  }

  // Second-brain recall: explicit ("ask my history …") or implicit
  // ("how did I set up X", "what did we decide about Y").
  const hist =
    t.match(/^(?:ask|search)(?: my)? (?:history|notes|brain|memory)[:,]?\s*(.*)$/) ??
    (/\b(how did (i|we)|what did (i|we) (decide|do|say|figure)|when did (i|we))\b/.test(t)
      ? ([null, text] as const)
      : null);
  if (hist) {
    const q = (hist[1] || text).trim();
    if (!q) return void reply("Ask me what you want from your history.");
    const a = await recallAnswer(q).catch(() => null);
    return void reply(a ?? "I didn't find anything relevant in your history.");
  }

  if (HOME_RE.test(t) && s.haUrl.trim()) {
    try {
      const convId = haConv && Date.now() - haConv.at < 120_000 ? haConv.id : null;
      const r = await api.haConversation(s.haUrl.trim(), keyRef("ha-token", s.haToken), text, convId);
      if (r.conversationId) haConv = { id: r.conversationId, at: Date.now() };
      return void reply(r.speech, true); // keep the mic hot for a follow-up
    } catch (e) {
      return void reply(`Home Assistant problem: ${String((e as Error).message ?? e).slice(0, 120)}`);
    }
  }

  // Everything else → a headless Claude job (the full agentic OS).
  if (!s.actingMode) {
    return void reply("Acting mode is off — enable it in Settings and I can act on that.");
  }
  const id = await startJob({
    skill: "voice",
    label: `Voice: ${text.slice(0, 60)}`,
    prompt: `${text}\n\nAnswer concisely — the reply will be read aloud.`,
    reveal: false,
  });
  if (id) void watchJob(id);
  return void reply("On it.");
}

/** Poll a voice-started job and read its result aloud when it lands. */
async function watchJob(id: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let j;
    try {
      j = await api.getJob(id);
    } catch {
      continue;
    }
    if (!j || j.status === "running") continue;
    if (j.status !== "done" || (j.exitCode ?? 0) !== 0) {
      return void reply("That job failed — details are in the Jobs panel.");
    }
    // Speak the tail of the output: the final answer, not the tool chatter.
    const clean = (j.output ?? "")
      .replace(/[*#_`>|-]{1,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tail = clean.length > 550 ? `…${clean.slice(-550)}` : clean;
    return void reply(tail || "Done — the result is in the Jobs panel.");
  }
  return void reply("Still working — I'll leave it in the Jobs panel.");
}

async function onCommand(path: string) {
  const wasFollowUp = followUpArmed;
  followUpArmed = false;
  emit("thinking");
  try {
    const text = await transcribeClip(path);
    if (!text.trim()) {
      // Declined follow-up windows end silently; real commands get a nudge.
      return void (wasFollowUp ? emit("listening") : reply("I didn't catch that."));
    }
    emit("thinking", text);
    await route(text);
  } catch (e) {
    if (wasFollowUp) return void emit("listening");
    notify.error(String((e as Error).message ?? e));
    emit("listening");
  }
}

// --- Lifecycle ---------------------------------------------------------------

let wired = false;

/** Start/stop the ear to match settings + meeting-recorder state. Safe to call
 * repeatedly; VoicePill calls it on every relevant change. */
/** Run a typed command through the same router the wake word uses. Returns the
 * reply text for display (no TTS, no mic follow-up). Everything route() can do —
 * recording, scripts, to-dos, agenda, Home Assistant, recall, and Claude jobs. */
export async function runTextCommand(text: string): Promise<string> {
  const t = text.trim();
  if (!t) return "";
  let out = "";
  capture = (r) => {
    out = r;
  };
  try {
    await route(t);
  } catch (e) {
    out = String((e as Error).message ?? e);
  } finally {
    capture = null;
  }
  return out;
}

export async function syncVoice(recActive: boolean): Promise<void> {
  if (!isTauri()) return;
  const s = getSettings();
  const want = s.voiceEnabled && !recActive && !!sttProvider() && keyConfigured("picovoice-key", s.picovoiceKey);

  if (!wired && want) {
    wired = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen("voice-wake", () => {
      chime();
      emit("awake");
    });
    await listen<{ path: string; seconds: number }>("voice-command", (e) => {
      void onCommand(e.payload.path);
    });
    // The ear cancelled a capture that never heard speech (stray wake or a
    // declined follow-up window) — reset quietly.
    await listen("voice-cancel", () => {
      followUpArmed = false;
      emit("listening");
    });
  }

  if (want) {
    try {
      await api.startVoice(keyRef("picovoice-key", s.picovoiceKey), s.wakeKeywordPath.trim());
      if (phase === "off") emit("listening");
    } catch (e) {
      emit("off");
      notify.error(`Voice assistant: ${String((e as Error).message ?? e)}`);
    }
  } else {
    await api.stopVoice().catch(() => {});
    emit("off");
  }
}
