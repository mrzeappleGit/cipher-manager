// localStorage-backed settings with a subscribe hook for React, mirrored to
// the shared on-disk app state so desktop and web-server clients converge.

import { useSyncExternalStore } from "react";
import type { FacecamLayout } from "../types";
import { mirrorAppState } from "./appState";
import { notify } from "./toast";

export type ProviderId = "anthropic" | "openai" | "gemini" | "openai-compatible";

export interface AppSettings {
  /** Which AI provider to use for daily summaries. */
  provider: ProviderId;
  /** API key per provider (stored locally only). */
  apiKeys: Record<ProviderId, string>;
  /** Model id per provider. */
  models: Record<ProviderId, string>;
  /** Base URL for the OpenAI-compatible provider (Ollama, LM Studio, …). */
  baseUrl: string;
  /** Show a desktop notification when a background AI task finishes. */
  notifications: boolean;
  /** Text-to-speech engine for read-aloud. */
  ttsEngine: "web" | "elevenlabs";
  elevenApiKey: string;
  elevenVoiceId: string;
  elevenModel: string;
  /** Deck (calendar + tasks) config. */
  deckName: string;
  icsUrls: string[];
  asanaToken: string;
  asanaProject: string;
  asanaWorkspace: string;
  /** Open Asana tasks in the desktop app (asanadesktop:// deep link) vs browser. */
  asanaOpenInApp: boolean;
  /** Open Zoom/Teams meetings in their desktop apps vs the browser. */
  meetingsOpenInApp: boolean;
  /** Desktop notification ~2 min before a meeting starts (while the app is open). */
  meetingReminders: boolean;
  /** Auto-start the meeting recorder when a calendar meeting begins (app open). */
  autoRecordMeetings: boolean;
  /** Offer window capture (screen recording + AI visual notes) when recording meetings. */
  meetingScreenRec: boolean;
  /** "HH:MM" for a once-a-day desktop digest of the day ahead; "" = off. */
  digestTime: string;
  /** Your display name in Asana — enables the "Mine" task filter on the Deck. */
  asanaMe: string;
  /** Show only tasks assigned to you (matched against asanaMe). */
  deckMineOnly: boolean;
  /** Tasks carrying any of these tags are hidden from the Deck. */
  hiddenTags: string[];
  /** Custom-field names hidden from task cards on the Deck (still shown in the task detail). */
  hiddenFields: string[];
  /** Master switch for running skills (headless `claude -p`). Off by default. */
  actingMode: boolean;
  /** Let unattended harvest automations write vault notes directly, skipping the Memory Inbox. Off = everything goes through review. */
  memoryAutoPromote: boolean;
  /** Path/name of the Claude Code CLI binary. */
  claudeBin: string;
  /** Codex CLI path/name and extra args, for jobs run on the codex engine. */
  codexBin: string;
  codexArgs: string;
  /** Gemini CLI path/name and extra args, for jobs run on the gemini engine. */
  geminiBin: string;
  geminiArgs: string;
  /** Extra CLI args passed to `claude -p` (advanced). */
  claudeArgs: string;
  /** Working directory skills run in (defaults to ~/.claude). */
  workDir: string;
  /** Folder of markdown notes/reports to browse on the Documents page. */
  vaultDir: string;
  /** CipherCodex WebDAV state directory; empty disables reading-note sync. */
  ccxStateUrl: string;
  /** Where Highlights saves clips + downloaded VODs; "" = ~/.claude/cipher-manager/clips. */
  clipsDir: string;
  /** Where screenshots are saved; "" = ~/.claude/cipher-manager/screenshots. */
  screenshotDir: string;
  /** Global Ctrl+Alt+S region grab, usable while the app is in the tray. */
  shotHotkey: boolean;
  /** Global Ctrl+Alt+Space — raise the app and open the command palette. */
  paletteHotkey: boolean;
  /** CipherScribe: self-hosted LanguageTool + rewrite endpoint. */
  scribeEndpoint: string;
  /** Checking language, e.g. "en-US". */
  scribeLanguage: string;
  /** Live docking nib + automatic checking as you type. */
  scribeNib: boolean;
  /** Global Ctrl+Alt+G (check) and Ctrl+Alt+R (rewrite). */
  scribeHotkeys: boolean;
  /** Pause live checking while a fullscreen app or game is foreground. */
  scribeIgnoreFullscreen: boolean;
  /** Lowercased exe basenames ("notepad.exe") where live checking is off. */
  scribeDisabledApps: string[];
  /** The style Ctrl+Alt+R and the tray entry use. The panel's picker overrides
   * it per invocation. These are wire values the rewrite proxy's `STYLES` map
   * accepts (cipherScribe/deploy/rewrite-proxy/server.mjs) — an unknown one
   * there falls back to `formal` silently, so the two lists must agree. */
  scribeRewriteStyle: "formal" | "casual" | "concise" | "expand" | "leet" | "prompt";
  /** Ollama base URL for Highlights AI scoring; "" = local (auto start/stop).
   * e.g. http://192.168.1.50:11434 for a remote GPU box. */
  sizzleOllamaUrl: string;
  /** Where the vision AI runs: local Ollama (auto start/stop), a remote
   * Ollama host, or a cloud API (see sizzleCloudModel). */
  sizzleAiMode: "local" | "remote" | "cloud";
  /** Curated cloud model id, or "custom" (then the three fields below). */
  sizzleCloudModel: string;
  sizzleCloudUrl: string;
  sizzleCloudModelId: string;
  sizzleCloudKey: ProviderId;
  /** Facecam/game crop boxes for vertical clips; null = center crop. */
  sizzleFacecam: FacecamLayout | null;
  /** Cut vertical clips with the facecam layout (vs blind center crop). */
  sizzleFacecamOn: boolean;
  /** Burned-caption style preset. */
  sizzleCaptionStyle: "bold" | "karaoke" | "minimal";
  /** Projects tab layout. */
  projectsLayout: "list" | "grid";
  /** Creator stats (dashboard card): YouTube Data API key + channel handle or UC… id. */
  youtubeApiKey: string;
  youtubeChannel: string;
  /** Twitch app credentials (client-credentials flow) + channel login name. */
  twitchClientId: string;
  twitchClientSecret: string;
  twitchLogin: string;
  /** Twitch user refresh token (OAuth) — enables follower + subscriber counts. */
  twitchRefreshToken: string;
  /** Listen for a !clip chat command while the app is open (broadcaster/mods). */
  clipChatCommand: boolean;
  /** Local WhisperX ASR service base URL (e.g. http://localhost:9000); ""=off.
   * When set, meeting transcription runs on the local GPU instead of the cloud. */
  whisperxUrl: string;
  /** Docker container to start/stop around transcriptions (GPU freed after). */
  whisperxContainer: string;
  /** OpenAI-compatible embeddings base URL for semantic recall; "" = keyword only.
   * e.g. http://localhost:11434/v1 (Ollama on the local GPU). */
  embeddingsUrl: string;
  embeddingsModel: string;
  /** Wake-word voice assistant ("Cipher, …"). Desktop only. */
  voiceEnabled: boolean;
  picovoiceKey: string;
  /** Custom .ppn keyword file; "" = built-in "Computer". */
  wakeKeywordPath: string;
  /** Global Ctrl+Alt+C push-to-talk (also what the Stream Deck key sends). */
  pttHotkey: boolean;
  haUrl: string;
  haToken: string;
  /** Entity ids shown on the Deck's Home card, in card order. */
  haEntities: string[];
  /** Hourly push of a read-only snapshot (deck, notes, sessions) to the VPS. */
  cloudSyncEnabled: boolean;
  /** SSH host or config alias; optionally user@host. Publishing is unconfigured by default. */
  sshHost: string;
  /** Absolute remote file paths, with parent directories created on upload. */
  scheduleRemotePath: string;
  snapshotRemotePath: string;
  /** ntfy push for finished jobs/automations; "" topic = off. */
  ntfyServer: string;
  ntfyTopic: string;
  /** Google OAuth client (Desktop app) for YouTube Analytics — separate from the
   * plain Data API key above. */
  googleClientId: string;
  googleClientSecret: string;
  /** YouTube (Google) refresh token — enables watch-time / views analytics. */
  youtubeRefreshToken: string;
  /** Gmail (Google) refresh token — enables package tracking off shipping mail.
   * Separate token from the YouTube one; same OAuth client. */
  gmailRefreshToken: string;
  /** Proton Mail via Bridge's local IMAP server. Host stays loopback even when
   * Bridge runs on another machine — tunnel it (ssh -L) rather than exposing
   * Bridge to the LAN; the backend rejects non-loopback hosts. "" user = off. */
  protonHost: string;
  protonPort: number;
  protonUser: string;
  /** Which IMAP folder to scan. Bridge exposes "All Mail" alongside INBOX. */
  protonMailbox: string;
  /** Bridge's generated password (vault-backed; never the Proton password). */
  protonBridgePassword: string;
}

const KEY = "cipher-manager.settings";

const DEFAULTS: AppSettings = {
  provider: "anthropic",
  apiKeys: { anthropic: "", openai: "", gemini: "", "openai-compatible": "" },
  models: {
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-4o-mini",
    gemini: "gemini-2.0-flash",
    "openai-compatible": "llama3.1",
  },
  baseUrl: "http://localhost:11434/v1",
  notifications: false,
  ttsEngine: "web",
  elevenApiKey: "",
  elevenVoiceId: "21m00Tcm4TlvDq8ikWAM",
  elevenModel: "eleven_turbo_v2_5",
  deckName: "",
  icsUrls: [],
  asanaToken: "",
  asanaProject: "",
  asanaWorkspace: "",
  asanaOpenInApp: true,
  meetingsOpenInApp: true,
  meetingReminders: true,
  autoRecordMeetings: false,
  meetingScreenRec: false,
  digestTime: "",
  asanaMe: "",
  deckMineOnly: false,
  hiddenTags: [],
  hiddenFields: [],
  actingMode: false,
  memoryAutoPromote: false,
  claudeBin: "claude",
  codexBin: "codex",
  codexArgs: "",
  geminiBin: "gemini",
  geminiArgs: "",
  claudeArgs: "",
  workDir: "",
  vaultDir: "",
  ccxStateUrl: "",
  clipsDir: "",
  screenshotDir: "",
  shotHotkey: true,
  paletteHotkey: true,
  scribeEndpoint: "",
  scribeLanguage: "en-US",
  scribeNib: false,
  scribeHotkeys: false,
  scribeIgnoreFullscreen: true,
  scribeDisabledApps: [],
  scribeRewriteStyle: "formal",
  sizzleOllamaUrl: "",
  sizzleAiMode: "local",
  sizzleCloudModel: "gemini-flash-latest",
  sizzleCloudUrl: "",
  sizzleCloudModelId: "",
  sizzleCloudKey: "openai-compatible",
  sizzleFacecam: null,
  sizzleFacecamOn: false,
  sizzleCaptionStyle: "bold",
  projectsLayout: "list",
  youtubeApiKey: "",
  youtubeChannel: "",
  twitchClientId: "",
  twitchClientSecret: "",
  twitchLogin: "",
  twitchRefreshToken: "",
  clipChatCommand: false,
  whisperxUrl: "",
  whisperxContainer: "whisperx-whisperx-1",
  embeddingsUrl: "",
  embeddingsModel: "nomic-embed-text",
  voiceEnabled: false,
  picovoiceKey: "",
  wakeKeywordPath: "",
  pttHotkey: true,
  haUrl: "",
  haToken: "",
  haEntities: [],
  cloudSyncEnabled: false,
  sshHost: "",
  scheduleRemotePath: "",
  snapshotRemotePath: "",
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  googleClientId: "",
  googleClientSecret: "",
  youtubeRefreshToken: "",
  gmailRefreshToken: "",
  protonHost: "127.0.0.1",
  // Bridge's documented default is 1143, but it hands out other ports freely
  // (a real install was on 5858) — check Bridge's own settings screen.
  protonPort: 1143,
  protonUser: "",
  // Comma-separated. NOT "All Mail" — Proton puts Trash and Spam in there,
  // where a Gmail search excludes both unless asked. INBOX+Archive matches.
  protonMailbox: "INBOX,Archive",
  protonBridgePassword: "",
};

function clone(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s));
}

let cache: AppSettings = load();
let listeners: Array<() => void> = [];

function normalize(raw: string): AppSettings {
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)
        || ("actingMode" in p && typeof p.actingMode !== "boolean")) {
      throw new Error("Invalid persisted settings");
    }
    const merged: AppSettings = {
      ...DEFAULTS,
      ...p,
      apiKeys: { ...DEFAULTS.apiKeys, ...(p.apiKeys || {}) },
      models: { ...DEFAULTS.models, ...(p.models || {}) },
    };
    // Migrate the old single-provider shape.
    if (p.anthropicApiKey && !merged.apiKeys.anthropic) {
      merged.apiKeys.anthropic = p.anthropicApiKey;
    }
    delete (merged as unknown as Record<string, unknown>).anthropicApiKey;
    if (p.summaryModel && !p.models?.anthropic) {
      merged.models.anthropic = p.summaryModel;
    }
    // Migrate the pre-cloud remote toggle.
    if (p.sizzleOllamaRemote && !p.sizzleAiMode) merged.sizzleAiMode = "remote";
    delete (merged as unknown as Record<string, unknown>).sizzleOllamaRemote;
    return merged;
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(raw) : clone(DEFAULTS);
  } catch {
    return clone(DEFAULTS);
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  disk.onPersist();
  for (const l of listeners) l();
}

// Shared on-disk copy (~/.claude/cipher-manager/settings.json): lets the web
// server (phone) inherit the desktop config. Disk wins at boot, then mirrors.
const disk = mirrorAppState(
  "settings",
  (raw) => {
      cache = normalize(raw);
      try {
        localStorage.setItem(KEY, JSON.stringify(cache));
      } catch {
        /* ignore */
      }
      for (const l of listeners) l();
  },
  () => JSON.stringify(cache),
  {
    validate: normalize,
    onError: () => {
      cache = { ...cache, actingMode: false };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* disk flush can retry */ }
      for (const l of listeners) l();
      notify.error("Couldn't read shared settings. Acting mode was turned off; review Settings before running jobs.");
    },
  }
);

export const settingsReady = disk.ready;

/** Persist the current permission/settings before an execution command. */
export async function flushSettings(): Promise<void> {
  await settingsReady;
  localStorage.setItem(KEY, JSON.stringify(cache));
  disk.onPersist();
  await disk.flush();
}

export function getSettings(): AppSettings {
  return cache;
}

export function setSettings(patch: Partial<AppSettings>): void {
  cache = { ...cache, ...patch };
  persist();
}

export function setApiKey(provider: ProviderId, value: string): void {
  cache = { ...cache, apiKeys: { ...cache.apiKeys, [provider]: value } };
  persist();
}

export function setModel(provider: ProviderId, value: string): void {
  cache = { ...cache, models: { ...cache.models, [provider]: value } };
  persist();
}

/** Add or remove a value from a hidden list (case-insensitive). */
function toggleHidden(key: "hiddenTags" | "hiddenFields" | "scribeDisabledApps", value: string): void {
  const t = value.trim();
  if (!t) return;
  const lower = t.toLowerCase();
  const list = cache[key];
  const has = list.some((x) => x.toLowerCase() === lower);
  cache = {
    ...cache,
    [key]: has ? list.filter((x) => x.toLowerCase() !== lower) : [...list, t],
  };
  persist();
}

/** Add or remove a tag from the hidden set (case-insensitive). */
export function toggleHiddenTag(tag: string): void {
  toggleHidden("hiddenTags", tag);
}

/** Add or remove a custom-field name from the hidden set (case-insensitive). */
export function toggleHiddenField(name: string): void {
  toggleHidden("hiddenFields", name);
}

/** Add or remove an exe from Scribe's per-app kill list (case-insensitive).
 * Used by the Scribe settings card's `HiddenListEditor`; the panel's own
 * "Turn off for <exe>" footer goes through `disableAppInSettings` instead
 * (add-only, see src/lib/scribe.ts). */
export function toggleScribeDisabledApp(exe: string): void {
  toggleHidden("scribeDisabledApps", exe);
}

function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

// Cache summaries per day so we don't re-call the API needlessly.
const SUMMARY_PREFIX = "cipher-manager.summary.";

export function getCachedSummary(day: string): string | null {
  try {
    return localStorage.getItem(SUMMARY_PREFIX + day);
  } catch {
    return null;
  }
}

export function setCachedSummary(day: string, text: string): void {
  try {
    localStorage.setItem(SUMMARY_PREFIX + day, text);
  } catch {
    /* ignore */
  }
}
