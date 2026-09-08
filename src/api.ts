import { invoke } from "@tauri-apps/api/core";
import * as mock from "./lib/mock";
import type {
  AgentSessionInfo,
  AppEntry,
  AppInfo,
  AuditEntry,
  CaptureWindow,
  Clip,
  CloudVision,
  DayRecap,
  DeckDashboard,
  DoctorReport,
  HaEntity,
  FacecamLayout,
  TaskComments,
  TaskDetail,
  DiskStats,
  DocFile,
  Documents,
  FileHit,
  Shot,
  BookmarkProfile,
  CodexSyncResult,
  G2Client,
  G2Pending,
  Highlight,
  InboxProposal,
  Job,
  ProjectSummary,
  RecentSession,
  RecentUsage,
  RecordingDone,
  RecordingFile,
  MeetingVideoAnalysis,
  RecordingStatus,
  SearchResult,
  SessionDetail,
  SessionSummary,
  Skill,
  SnapshotDoc,
  UsageStats,
  VaultHit,
} from "./types";

/** One message from Proton Bridge — mirrors `MailMessage` in src-tauri/src/proton.rs. */
export interface ProtonMail {
  id: string;
  subject: string;
  from: string;
  /** RFC3339, so it compares directly against Gmail's dates. */
  date: string;
  body: string;
}

/** Baked-in data for the shareable static snapshot page. */
interface Snapshot {
  projects: ProjectSummary[];
  usage: UsageStats;
  recaps: DayRecap[];
  disk: DiskStats;
  appInfo: AppInfo;
  sessions: Record<string, SessionSummary[]>;
  deck?: DeckDashboard;
  docs?: SnapshotDoc[];
  generatedAt?: number;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function snap(): Snapshot | null {
  return (window as unknown as { __CIPHER_SNAPSHOT__?: Snapshot }).__CIPHER_SNAPSHOT__ ?? null;
}

export function isSnapshot(): boolean {
  return snap() !== null;
}

/** When the baked snapshot was pushed (epoch ms), null outside snapshot mode. */
export function snapshotGeneratedAt(): number | null {
  return snap()?.generatedAt ?? null;
}

export type DataMode = "snapshot" | "tauri" | "web" | "mock";

/** Which data source is actually backing the app right now. */
export async function dataMode(): Promise<DataMode> {
  if (isSnapshot()) return "snapshot";
  if (isTauri()) return "tauri";
  if (await isWebServer()) return "web";
  return "mock";
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Detect (once) whether we're being served by the local web server.
let webModePromise: Promise<boolean> | null = null;
function isWebServer(): Promise<boolean> {
  if (!webModePromise) {
    webModePromise = fetch("/api/health", { method: "POST" })
      .then(async (r) => {
        if (!r.ok) return false;
        try {
          const j = await r.json();
          return j?.ok === true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
  }
  return webModePromise;
}

async function httpCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    let msg = `${cmd} failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** Resolve a read query across snapshot / Tauri / web-server / mock. */
async function resolve<T>(
  cmd: string,
  args: Record<string, unknown>,
  fromSnapshot: (s: Snapshot) => T,
  fromMock: () => T
): Promise<T> {
  const s = snap();
  if (s) return fromSnapshot(s);
  if (isTauri()) return invoke<T>(cmd, args);
  if (await isWebServer()) return httpCall<T>(cmd, args);
  await delay(150);
  return fromMock();
}

function desktopOnly(): Promise<never> {
  return Promise.reject(new Error("Only available in the desktop app"));
}

// Agent PTY sessions live in the serve process (they must outlive the app and
// be reachable from the phone), so even the desktop app calls them over
// localhost HTTP — with the serve token, fetched once via get_serve_token.
let serveTokenPromise: Promise<string> | null = null;

async function agentCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    if (!serveTokenPromise)
      serveTokenPromise = invoke<string>("get_serve_token").catch((e) => {
        serveTokenPromise = null; // don't cache the rejection — retry next call
        throw e;
      });
    const token = await serveTokenPromise;
    const res = await fetch(`http://localhost:4600/api/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args ?? {}),
    });
    if (!res.ok) {
      let msg = `${cmd} failed (${res.status})`;
      try {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return res.json() as Promise<T>;
  }
  // Web mode: same-origin relative call; the browser's cookie/token auth applies.
  if (await isWebServer()) return httpCall<T>(cmd, args);
  throw new Error("Agent sessions need the local web server (serve.exe) running");
}

function abToBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

/** Proxy a TTS request server-side (avoids CORS); returns base64 audio. */
export async function ttsRequest(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; bodyBase64: string }> {
  if (isTauri()) {
    return invoke<{ status: number; bodyBase64: string }>("tts_proxy", {
      url,
      method: "POST",
      headers,
      body,
    });
  }
  if (await isWebServer()) {
    const res = await fetch("/api/tts_proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, method: "POST", headers, body }),
    });
    if (!res.ok) throw new Error(`Proxy error (${res.status})`);
    const j = await res.json();
    return { status: j.status, bodyBase64: j.bodyBase64 };
  }
  const res = await fetch(url, { method: "POST", headers, body });
  return { status: res.status, bodyBase64: abToBase64(await res.arrayBuffer()) };
}

/**
 * Send an AI-provider HTTP request server-side to avoid browser CORS (OpenAI and
 * most local endpoints don't send CORS headers). Falls back to a direct browser
 * fetch only in pure-browser dev/mock, where there is no backend to proxy through.
 */
export async function aiRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  method = "POST"
): Promise<{ status: number; text: string }> {
  if (isTauri()) {
    const r = await invoke<{ status: number; body: string }>("ai_proxy", {
      url,
      method,
      headers,
      body,
    });
    return { status: r.status, text: r.body };
  }
  if (await isWebServer()) {
    const res = await fetch("/api/ai_proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, method, headers, body }),
    });
    if (!res.ok) throw new Error(`Proxy error (${res.status})`);
    const j = await res.json();
    return { status: j.status, text: j.body };
  }
  // Pure browser (dev/mock): direct request, subject to the provider's CORS policy.
  const res = await fetch(url, { method, headers, ...(method === "GET" ? {} : { body }) });
  return { status: res.status, text: await res.text() };
}

/** Proxy an STT (speech-to-text) upload server-side; multipart with the audio
 * blob. Falls back to a direct browser request outside the desktop app. */
export async function sttRequest(params: {
  url: string;
  headers: Record<string, string>;
  blob: Blob;
  filename: string;
  fields: Record<string, string>;
}): Promise<{ status: number; text: string }> {
  if (isTauri()) {
    const r = await invoke<{ status: number; body: string }>("stt_proxy", {
      url: params.url,
      headers: params.headers,
      audioBase64: abToBase64(await params.blob.arrayBuffer()),
      filename: params.filename,
      mime: params.blob.type || "audio/webm",
      fields: params.fields,
    });
    return { status: r.status, text: r.body };
  }
  // Browser: direct multipart request, subject to the provider's CORS policy.
  const fd = new FormData();
  for (const [k, v] of Object.entries(params.fields)) fd.append(k, v);
  fd.append("file", params.blob, params.filename);
  const res = await fetch(params.url, { method: "POST", headers: params.headers, body: fd });
  return { status: res.status, text: await res.text() };
}

export const api = {
  listProjects: () =>
    resolve<ProjectSummary[]>("list_projects", {}, (s) => s.projects, mock.projects),

  getUsageStats: () => resolve<UsageStats>("get_usage_stats", {}, (s) => s.usage, mock.usage),

  getDailyRecaps: () => resolve<DayRecap[]>("get_daily_recaps", {}, (s) => s.recaps, mock.recaps),

  getRecentUsage: () =>
    resolve<RecentUsage>("get_recent_usage", {}, () => mock.emptyRecent(), mock.recentUsage),

  getDocuments: () =>
    resolve<Documents>("get_documents", {}, () => ({ plans: [], memory: [] }), mock.documents),

  getSkills: () => resolve<Skill[]>("get_skills", {}, () => [], mock.skills),

  getDeck: (cfg: {
    icsUrls: string[];
    asanaToken: string;
    asanaProject: string;
    asanaWorkspace: string;
  }) =>
    resolve<DeckDashboard>("get_deck", cfg, (s) => s.deck ?? mock.deckDashboard(), mock.deckDashboard),

  getTaskDetail: async (token: string, gid: string): Promise<TaskDetail> => {
    if (isTauri()) return invoke<TaskDetail>("get_task_detail", { token, gid });
    if (await isWebServer()) return httpCall<TaskDetail>("get_task_detail", { token, gid });
    return mock.taskDetail();
  },

  getTaskComments: async (token: string, ids: string[]): Promise<TaskComments[]> => {
    if (!ids.length) return [];
    if (isTauri()) return invoke<TaskComments[]>("get_task_comments", { token, ids });
    if (await isWebServer()) return httpCall<TaskComments[]>("get_task_comments", { token, ids });
    return [];
  },

  getRecentSessions: (limit?: number) =>
    resolve<RecentSession[]>(
      "get_recent_sessions",
      { limit },
      () => [],
      () => mock.recentSessions(limit ?? 8)
    ),

  readDocument: async (path: string): Promise<string> => {
    if (isTauri()) return invoke<string>("read_document_cmd", { path });
    if (await isWebServer()) return httpCall<string>("read_document", { path });
    return mock.docContent(path);
  },

  getDiskStats: () => resolve<DiskStats>("get_disk_stats", {}, (s) => s.disk, mock.disk),

  getAppInfo: () => resolve<AppInfo>("get_app_info", {}, (s) => s.appInfo, mock.appInfo),

  // Secure credential store (WP-0B). set/delete are desktop-only (configure
  // keys on the PC); presence works everywhere. No get-secret command exists.
  setSecret: (id: string, value: string): Promise<void> =>
    isTauri() ? invoke<void>("set_secret", { id, value }) : desktopOnly(),
  deleteSecret: (id: string): Promise<void> =>
    isTauri() ? invoke<void>("delete_secret", { id }) : desktopOnly(),
  secretPresence: async (): Promise<Record<string, boolean>> => {
    if (isTauri()) return invoke<Record<string, boolean>>("secret_presence", {});
    if (await isWebServer()) return httpCall<Record<string, boolean>>("secret_presence", {});
    return {};
  },

  // Even G2 glasses pairing — approval stays on the desktop by design.
  g2PairPending: (): Promise<G2Pending[]> =>
    isTauri() ? invoke<G2Pending[]>("g2_pair_pending", {}) : Promise.resolve([]),
  g2PairApprove: (code: string): Promise<void> =>
    isTauri() ? invoke<void>("g2_pair_approve", { code }) : desktopOnly(),
  g2Clients: (): Promise<G2Client[]> =>
    isTauri() ? invoke<G2Client[]>("g2_clients", {}) : Promise.resolve([]),
  g2Revoke: (id: string): Promise<void> =>
    isTauri() ? invoke<void>("g2_revoke", { id }) : desktopOnly(),

  listSessions: (projectId: string) =>
    resolve<SessionSummary[]>(
      "list_sessions",
      { projectId },
      (s) => s.sessions[projectId] ?? [],
      () => mock.sessions(projectId)
    ),

  getSession: async (projectId: string, sessionId: string): Promise<SessionDetail> => {
    if (snap()) {
      throw new Error("Full transcripts aren't included in the snapshot — open the app to read them.");
    }
    if (isTauri()) return invoke<SessionDetail>("get_session", { projectId, sessionId });
    if (await isWebServer()) return httpCall<SessionDetail>("get_session", { projectId, sessionId });
    await delay(150);
    return mock.sessionDetail(projectId, sessionId);
  },

  search: async (query: string, limit?: number): Promise<SearchResult[]> => {
    if (snap()) {
      throw new Error("Search isn't available in the snapshot — open the app to search.");
    }
    if (isTauri()) return invoke<SearchResult[]>("search", { query, limit });
    if (await isWebServer()) return httpCall<SearchResult[]>("search", { query, limit });
    await delay(150);
    return mock.search(query);
  },

  searchAny: (terms: string[], limit?: number) =>
    resolve<SearchResult[]>(
      "search_any",
      { terms, limit },
      () => [],
      () => mock.search(terms[0] ?? "history")
    ),

  refresh: async (): Promise<UsageStats> => {
    const s = snap();
    if (s) return s.usage;
    if (isTauri()) return invoke<UsageStats>("refresh", {});
    if (await isWebServer()) return httpCall<UsageStats>("refresh", {});
    return mock.usage();
  },

  // Desktop-only actions (the web server is read-only).
  deleteSession: (projectId: string, sessionId: string) =>
    isTauri() ? invoke<void>("delete_session", { projectId, sessionId }) : desktopOnly(),

  archiveSession: (projectId: string, sessionId: string) =>
    isTauri() ? invoke<void>("archive_session", { projectId, sessionId }) : desktopOnly(),

  openPath: (path: string) => (isTauri() ? invoke<void>("open_path", { path }) : desktopOnly()),

  revealPath: (path: string) => (isTauri() ? invoke<void>("reveal_path", { path }) : desktopOnly()),

  openInEditor: (path: string) =>
    isTauri() ? invoke<void>("open_in_editor", { path }) : desktopOnly(),

  // Open a terminal at a directory, optionally running a command in it
  // (e.g. `claude --continue` to resume a project).
  openTerminal: (path: string, run?: string) =>
    isTauri() ? invoke<void>("open_terminal", { path, run }) : desktopOnly(),

  // Launch-at-login (Windows Run key); reads/writes real registry state.
  getAutostart: async (): Promise<boolean> =>
    isTauri() ? invoke<boolean>("get_autostart", {}) : false,

  setAutostart: (enabled: boolean) =>
    isTauri() ? invoke<void>("set_autostart", { enabled }) : desktopOnly(),

  // Vault browser — markdown files under the configured vault folder.
  listVault: async (dir: string): Promise<DocFile[]> => {
    const s0 = snap();
    if (s0)
      return (s0.docs ?? []).map((d) => ({
        name: d.name,
        path: d.path,
        sizeBytes: d.content.length,
        modified: new Date(d.modified).toISOString(),
        kind: "vault",
      }));
    if (isTauri()) return invoke<DocFile[]>("list_vault", { dir });
    if (await isWebServer()) return httpCall<DocFile[]>("list_vault", { dir });
    return [];
  },

  readVaultFile: async (dir: string, path: string): Promise<string> => {
    const s0 = snap();
    if (s0) {
      const d = (s0.docs ?? []).find((d) => d.path === path);
      if (d) return d.content;
      throw new Error("This document isn't in the snapshot — open the app to read it.");
    }
    if (isTauri()) return invoke<string>("read_vault_file", { dir, path });
    if (await isWebServer()) return httpCall<string>("read_vault_file", { dir, path });
    return desktopOnly();
  },

  // Real exit — tray Quit emits quit-push, CloudSyncRunner pushes, then this.
  exitApp: (): Promise<void> => (isTauri() ? invoke("exit_app", {}) : desktopOnly()),

  // Remote-access pairing info (desktop only — it inspects THIS machine).
  remoteInfo: (): Promise<{
    serveUp: boolean;
    tailscaleIp: string | null;
    url: string;
    qrSvg: string;
  }> => (isTauri() ? invoke("remote_info", {}) : desktopOnly()),

  // Commit/pull/push the vault's git repo (GitHub backup). Returns a summary.
  syncVaultGit: async (dir: string): Promise<string> => {
    if (isTauri()) return invoke<string>("sync_vault_git", { dir });
    if (await isWebServer()) return httpCall<string>("sync_vault_git", { dir });
    return Promise.reject(new Error("Vault sync is only available in the app"));
  },

  // Publish to the user's configured SSH destination.
  pushScheduleSite: async (json: string, sshHost: string, remotePath: string): Promise<void> => {
    if (isTauri()) return invoke<void>("push_schedule_site", { json, sshHost, remotePath });
    return desktopOnly();
  },

  // Cloud snapshot push — bakes the shareable page and uploads it to the VPS.
  pushCloudSnapshot: async (extra: { deck?: DeckDashboard; docs?: SnapshotDoc[] }, sshHost: string, remotePath: string): Promise<void> => {
    if (isTauri()) return invoke<void>("push_cloud_snapshot", { extra, sshHost, remotePath });
    return desktopOnly();
  },

  // Write a markdown file at a relative path inside the vault (backend confines it).
  writeVaultFile: async (dir: string, rel: string, content: string): Promise<void> => {
    if (isTauri()) return invoke<void>("write_vault_file", { dir, rel, content });
    if (await isWebServer()) return httpCall<void>("write_vault_file", { dir, rel, content });
    return Promise.reject(new Error("Vault writes are only available in the app"));
  },

  // Vault recall — keyword search over the vault's markdown files.
  searchVault: async (
    dir: string,
    terms: string[],
    limit = 8
  ): Promise<VaultHit[]> => {
    if (isTauri()) return invoke<VaultHit[]>("search_vault", { dir, terms, limit });
    if (await isWebServer()) return httpCall<VaultHit[]>("search_vault", { dir, terms, limit });
    return [];
  },

  vaultDoctor: async (dir: string): Promise<DoctorReport> => {
    if (isTauri()) return invoke<DoctorReport>("vault_doctor", { dir });
    if (await isWebServer()) return httpCall<DoctorReport>("vault_doctor", { dir });
    return desktopOnly();
  },

  inboxList: async (): Promise<InboxProposal[]> => {
    if (isTauri()) return invoke<InboxProposal[]>("inbox_list");
    if (await isWebServer()) return httpCall<InboxProposal[]>("inbox_list", {});
    return desktopOnly();
  },

  inboxDecide: async (dir: string, id: string, approve: boolean): Promise<InboxProposal> => {
    if (isTauri()) return invoke<InboxProposal>("inbox_decide", { dir, id, approve });
    if (await isWebServer()) return httpCall<InboxProposal>("inbox_decide", { dir, id, approve });
    return desktopOnly();
  },

  // Semantic recall — embeds vault chunks (cached on disk) via an
  // OpenAI-compatible endpoint and ranks by cosine similarity.
  semanticSearch: async (
    dir: string,
    url: string,
    key: string,
    model: string,
    query: string,
    limit = 8
  ): Promise<VaultHit[]> => {
    const args = { dir, url, key, model, query, limit };
    if (isTauri()) return invoke<VaultHit[]>("semantic_search", args);
    if (await isWebServer()) return httpCall<VaultHit[]>("semantic_search", args);
    return [];
  },

  // Semantic recall over session transcripts (user-message digests, cached).
  semanticSearchSessions: async (
    url: string,
    key: string,
    model: string,
    query: string,
    limit = 6
  ): Promise<SearchResult[]> => {
    const args = { url, key, model, query, limit };
    if (isTauri()) return invoke<SearchResult[]>("semantic_search_sessions", args);
    if (await isWebServer()) return httpCall<SearchResult[]>("semantic_search_sessions", args);
    return [];
  },

  // Meeting recorder — captures mic + system audio (WASAPI loopback) on the
  // machine running the backend; from a phone it acts as a remote control.
  startRecording: async (): Promise<string> => {
    if (isTauri()) return invoke<string>("start_recording", {});
    if (await isWebServer()) return httpCall<string>("start_recording", {});
    return desktopOnly();
  },

  stopRecording: async (): Promise<RecordingDone> => {
    if (isTauri()) return invoke<RecordingDone>("stop_recording", {});
    if (await isWebServer()) return httpCall<RecordingDone>("stop_recording", {});
    return desktopOnly();
  },

  recordingStatus: async (): Promise<RecordingStatus> => {
    if (isTauri()) return invoke<RecordingStatus>("recording_status", {});
    if (await isWebServer()) return httpCall<RecordingStatus>("recording_status", {});
    return { recording: false, seconds: 0, sources: "", silenceSecs: 0 };
  },

  // Two-track transcription: mic = "Me" (exact), system = diarized speakers.
  transcribeMeeting: async (
    micPath: string | null,
    sysPath: string | null,
    url: string,
    headers: Record<string, string>,
    fields: Record<string, string>,
    fileField?: string,
    visuals?: [number, string][],
    speakerHints?: [number, string][]
  ): Promise<string> => {
    const args = { micPath, sysPath, url, headers, fields, fileField, visuals, speakerHints };
    if (isTauri()) return invoke<string>("transcribe_meeting", args);
    if (await isWebServer()) return httpCall<string>("transcribe_meeting", args);
    return desktopOnly();
  },

  // Start/stop/status a docker container (the local WhisperX ASR service).
  dockerContainer: async (
    name: string,
    action: "start" | "stop" | "status"
  ): Promise<{ daemonUp: boolean; exists: boolean; running: boolean }> => {
    if (isTauri()) return invoke("docker_container", { name, action });
    if (await isWebServer()) return httpCall("docker_container", { name, action });
    return desktopOnly();
  },

  // --- screenshots (desktop-only) ---
  // Capture to PNG *and* the clipboard. null = a region drag the user cancelled.
  captureScreenshot: async (
    mode: "screen" | "window" | "region",
    dir: string,
    title?: string
  ): Promise<Shot | null> => {
    if (isTauri()) return invoke<Shot | null>("capture_screenshot", { mode, dir, title });
    return desktopOnly();
  },
  listScreenshots: async (dir: string): Promise<Shot[]> => {
    if (isTauri()) return invoke<Shot[]>("list_screenshots", { dir });
    return desktopOnly();
  },
  // Full-size base64 PNG for the lightbox; `name` is resolved inside `dir`.
  readScreenshot: async (dir: string, name: string): Promise<string> => {
    if (isTauri()) return invoke<string>("read_screenshot", { dir, name });
    return desktopOnly();
  },
  copyScreenshot: async (dir: string, name: string): Promise<void> => {
    if (isTauri()) return invoke<void>("copy_screenshot", { dir, name });
    return desktopOnly();
  },
  deleteScreenshot: async (dir: string, name: string): Promise<void> => {
    if (isTauri()) return invoke<void>("delete_screenshot", { dir, name });
    return desktopOnly();
  },
  // Global Ctrl+Alt+S region grab; follows the settings toggle.
  setShotHotkey: (enabled: boolean): Promise<void> =>
    isTauri() ? invoke<void>("set_shot_hotkey", { enabled }) : Promise.resolve(),

  // Global Ctrl+Alt+Space — summon the universal-search window.
  setPaletteHotkey: (enabled: boolean): Promise<void> =>
    isTauri() ? invoke<void>("set_palette_hotkey", { enabled }) : Promise.resolve(),

  // Global Ctrl+Alt+G (check) / Ctrl+Alt+R (rewrite) — same quiet-resolve
  // shape as the other hotkey-registration commands above; there's no field
  // to act on outside the desktop app either way.
  setScribeHotkeys: (enabled: boolean): Promise<void> =>
    isTauri() ? invoke<void>("set_scribe_hotkeys", { enabled }) : Promise.resolve(),

  // --- universal-search window (desktop-only) ---
  openSearchWindow: (): Promise<void> =>
    isTauri() ? invoke<void>("open_search_window", {}) : desktopOnly(),

  // Hand an in-app route from the search window to the main window.
  openInMain: (path: string): Promise<void> =>
    isTauri() ? invoke<void>("open_in_main", { path }) : desktopOnly(),

  // --- CipherScribe live watcher (desktop-only) ---
  // Rust never reads settings, so the watcher's whole config — including
  // whether it runs at all — is pushed from ScribeRunner in App.tsx. `token`
  // is the {{secret:scribe-token}} placeholder; Rust resolves it in the
  // network path. Resolves to nothing outside the desktop app (there is no
  // field to watch), rather than rejecting on every settings change.
  scribeSetLive: (cfg: {
    enabled: boolean;
    endpoint: string;
    token: string;
    language: string;
    style: string;
    ignoreFullscreen: boolean;
    disabledApps: string[];
  }): Promise<void> => (isTauri() ? invoke<void>("scribe_set_live", cfg) : Promise.resolve()),

  // Settings' Scribe card "Test" button: round-trips a fixed sentence through
  // the check endpoint so a bad token/endpoint is diagnosable without leaving
  // Settings. `token` is the `{{secret:scribe-token}}` placeholder, resolved
  // on the Rust side exactly like `scribeSetLive`'s.
  scribePing: (endpoint: string, token: string, language: string): Promise<string> =>
    isTauri() ? invoke<string>("scribe_ping", { endpoint, token, language }) : desktopOnly(),

  // --- CipherScribe nib/panel windows (desktop-only) ---
  // Non-activating overlays driven from Rust; x/y are physical pixels.
  // scribe_show_nib/scribe_hide_nib have no JS caller — live.rs's watcher
  // calls the Rust fns directly — so they're plain fns, not commands here.
  scribeTogglePanel: (): Promise<void> =>
    isTauri() ? invoke<void>("scribe_toggle_panel", {}) : desktopOnly(),
  scribeHidePanel: (): Promise<void> =>
    isTauri() ? invoke<void>("scribe_hide_panel", {}) : desktopOnly(),

  // Panel actions — apply/dismiss run the blocking UI Automation apply engine
  // on the Rust side (spawn_blocking'd there); `gen` is the session generation
  // the panel rendered against, so a stale click after the field changed is
  // refused rather than editing the wrong text.
  scribeApplyIssue: (gen: number, index: number, replacement: string): Promise<void> =>
    isTauri() ? invoke<void>("scribe_apply_issue", { gen, index, replacement }) : desktopOnly(),
  scribeApplyAll: (gen: number): Promise<void> =>
    isTauri() ? invoke<void>("scribe_apply_all", { gen }) : desktopOnly(),
  scribeDismissIssue: (gen: number, index: number): Promise<void> =>
    isTauri() ? invoke<void>("scribe_dismiss_issue", { gen, index }) : desktopOnly(),
  /** Rewrite the whole focused field. No `gen`: unlike the issue actions this
   *  re-reads the field through UI Automation rather than acting on indices
   *  into a rendered snapshot, so there is no stale-index hazard to guard. */
  scribeRewrite: (style: string): Promise<void> =>
    isTauri() ? invoke<void>("scribe_rewrite", { style }) : desktopOnly(),

  // --- universal search backends (desktop-only) ---
  // Start Menu shortcuts; launched through openPath.
  listApps: async (): Promise<AppEntry[]> => {
    if (isTauri()) return invoke<AppEntry[]>("list_apps", {});
    return [];
  },
  // Windows Search index. Returns [] rather than throwing when the index is
  // unavailable — this runs on every keystroke and must never raise a toast.
  searchFiles: async (query: string, limit = 20): Promise<FileHit[]> => {
    if (isTauri()) return invoke<FileHit[]>("search_files", { query, limit });
    return [];
  },

  // --- meeting screen recording (desktop-only) ---
  listCaptureWindows: async (): Promise<CaptureWindow[]> => {
    if (isTauri()) return invoke<CaptureWindow[]>("list_capture_windows", {});
    return desktopOnly();
  },
  startScreenRecord: async (title: string): Promise<string> => {
    if (isTauri()) return invoke<string>("start_screen_record", { title });
    return desktopOnly();
  },
  stopScreenRecord: async (): Promise<string | null> => {
    if (isTauri()) return invoke<string | null>("stop_screen_record", {});
    return desktopOnly();
  },
  analyzeMeetingVideo: async (path: string, ollama?: string, cloud?: CloudVision): Promise<MeetingVideoAnalysis> => {
    if (isTauri()) return invoke<MeetingVideoAnalysis>("analyze_meeting_video", { path, ollama, cloud });
    return desktopOnly();
  },

  // Voice assistant (wake word) — the ear lives in the desktop process only.
  startVoice: (accessKey: string, keywordPath: string): Promise<void> =>
    isTauri() ? invoke<void>("start_voice", { accessKey, keywordPath }) : desktopOnly(),

  stopVoice: (): Promise<void> => (isTauri() ? invoke<void>("stop_voice", {}) : Promise.resolve()),

  // Push-to-talk: skip the wake word and capture a command right now.
  triggerVoice: (): Promise<void> =>
    isTauri() ? invoke<void>("trigger_voice", {}) : desktopOnly(),

  setPttHotkey: (enabled: boolean): Promise<void> =>
    isTauri() ? invoke<void>("set_ptt_hotkey", { enabled }) : Promise.resolve(),

  voiceStatus: (): Promise<{ running: boolean; phase: number; lastError: string }> =>
    isTauri()
      ? invoke("voice_status", {})
      : Promise.resolve({ running: false, phase: 0, lastError: "" }),

  // Free text to Home Assistant's conversation API; returns the spoken reply
  // plus a conversation id for follow-ups.
  haConversation: (
    url: string,
    token: string,
    text: string,
    conversationId?: string | null
  ): Promise<{ speech: string; conversationId: string | null }> =>
    isTauri()
      ? invoke("ha_conversation", { url, token, text, conversationId: conversationId ?? null })
      : desktopOnly(),

  // Home Assistant entity states (empty entityIds = all — the Settings picker).
  // Snapshot mode: none — the read-only cloud cache must not show stale toggles.
  haStates: async (url: string, token: string, entityIds: string[]): Promise<HaEntity[]> => {
    if (isSnapshot()) return [];
    if (isTauri()) return invoke<HaEntity[]>("ha_states", { url, token, entityIds });
    if (await isWebServer()) return httpCall<HaEntity[]>("ha_states", { url, token, entityIds });
    return [];
  },

  haCallService: async (
    url: string,
    token: string,
    domain: string,
    service: string,
    entityId: string
  ): Promise<void> => {
    if (isTauri()) return invoke("ha_call_service", { url, token, domain, service, entityId });
    if (await isWebServer())
      return httpCall("ha_call_service", { url, token, domain, service, entityId });
    return desktopOnly();
  },

  // User scripts (~/.claude/cipher-manager/scripts) — list + run. Works over
  // serve so the phone can trigger them ("close my work programs").
  listUserScripts: async (): Promise<string[]> => {
    if (isTauri()) return invoke<string[]>("list_user_scripts", {});
    if (await isWebServer()) return httpCall<string[]>("list_user_scripts", {});
    return [];
  },

  runUserScript: async (name: string): Promise<string> => {
    if (isTauri()) return invoke<string>("run_user_script", { name });
    if (await isWebServer()) return httpCall<string>("run_user_script", { name });
    return desktopOnly();
  },

  // Finished recordings on disk, newest first — used to surface recordings
  // whose transcribe→note pipeline failed (docker down, STT error).
  listRecordings: async (): Promise<RecordingFile[]> => {
    if (isTauri()) return invoke<RecordingFile[]>("list_recordings", {});
    if (await isWebServer()) return httpCall<RecordingFile[]>("list_recordings", {});
    return [];
  },

  // Convert an arbitrary audio/video file (ffmpeg) into the recordings dir so
  // it can run through the meeting transcription flow. Desktop only.
  importRecording: (src: string): Promise<RecordingDone> =>
    isTauri() ? invoke<RecordingDone>("import_recording", { src }) : desktopOnly(),

  // Native open-file dialog (audio/video filter). Null when cancelled.
  pickAudioFile: (): Promise<string | null> =>
    isTauri() ? invoke<string | null>("pick_audio_file", {}) : desktopOnly(),

  transcribeRecording: async (
    path: string,
    url: string,
    headers: Record<string, string>,
    fields: Record<string, string>,
    chunkSecs?: number
  ): Promise<string> => {
    if (isTauri())
      return invoke<string>("transcribe_recording", { path, url, headers, fields, chunkSecs });
    if (await isWebServer())
      return httpCall<string>("transcribe_recording", { path, url, headers, fields, chunkSecs });
    return desktopOnly();
  },

  // Proton Mail for the Packages page, read through Bridge's local IMAP server.
  // Desktop-only: Bridge runs on a machine, not in a browser, and the loopback
  // host is meaningless to a phone hitting the web server.
  protonFetchMail: async (args: {
    host: string;
    port: number;
    user: string;
    password: string;
    mailboxes: string[];
    daysBack: number;
    subjectHints: string[];
    fromHints: string[];
    limit: number;
  }): Promise<ProtonMail[]> => {
    if (isTauri()) return invoke<ProtonMail[]>("proton_fetch_mail", args);
    return desktopOnly();
  },

  // Open an external URL (Deck join / task links). Uses the OS opener in the
  // desktop app; a new browser tab everywhere else.
  openUrl: async (url: string): Promise<void> => {
    if (isTauri()) return invoke<void>("open_url", { url });
    window.open(url, "_blank", "noopener,noreferrer");
  },

  // Brave bookmarks, read straight from Brave's profile files on the PC.
  listBookmarks: async (): Promise<BookmarkProfile[]> => {
    if (isTauri()) return invoke<BookmarkProfile[]>("list_bookmarks", {});
    if (await isWebServer()) return httpCall<BookmarkProfile[]>("list_bookmarks", {});
    return [];
  },
  // Desktop: launch Brave with the URL. Web/phone: open in the local browser.
  openInBrave: async (url: string): Promise<void> => {
    if (isTauri()) return invoke<void>("open_in_brave", { url });
    window.open(url, "_blank", "noopener,noreferrer");
  },
  // Native directory picker (bookmark a file-explorer folder).
  pickFolder: (): Promise<string | null> =>
    isTauri() ? invoke<string | null>("pick_folder", {}) : desktopOnly(),
  // Page snapshot as base64 PNG. The desktop generates (headless Brave) and
  // caches; the web server only serves thumbs already in that cache.
  snapshotUrl: async (url: string, refresh = false): Promise<string> => {
    if (isTauri()) return invoke<string>("snapshot_url", { url, refresh });
    if (await isWebServer()) return httpCall<string>("snapshot_url", { url });
    return Promise.reject(new Error("No snapshots in mock mode"));
  },
  // Pick an image file to use as a bookmark's snapshot (manual override).
  pickSnapshotImage: (url: string): Promise<boolean> =>
    isTauri() ? invoke<boolean>("pick_snapshot_image", { url }) : desktopOnly(),

  revealSession: (projectId: string, sessionId: string) =>
    isTauri() ? invoke<void>("reveal_session", { projectId, sessionId }) : desktopOnly(),

  // Shared app state — small JSON blobs under ~/.claude/cipher-manager so the
  // desktop app and the web server (phone) share one config. Null in mock mode.
  loadAppState: async (key: string): Promise<string | null> => {
    if (isTauri()) return invoke<string | null>("load_app_state", { key });
    if (await isWebServer()) return httpCall<string | null>("load_app_state", { key });
    return null;
  },

  saveAppState: async (key: string, json: string): Promise<void> => {
    if (isTauri()) return invoke<void>("save_app_state", { key, json });
    if (await isWebServer()) return httpCall<void>("save_app_state", { key, json });
  },

  // System automations — Windows Task Scheduler tasks running claude -p even
  // when the app is closed. Desktop-only.
  createSystemTask: (params: {
    slug: string;
    time: string;
    days: string[];
    prompt: string;
    bin?: string;
    args?: string;
    cwd?: string;
  }) => (isTauri() ? invoke<void>("create_system_task", params) : desktopOnly()),

  deleteSystemTask: (slug: string) =>
    isTauri() ? invoke<void>("delete_system_task", { slug }) : desktopOnly(),

  setSystemTaskEnabled: (slug: string, enabled: boolean) =>
    isTauri() ? invoke<void>("set_system_task_enabled", { slug, enabled }) : desktopOnly(),

  // Deck snapshot — background write to ~/.claude/cipher-deck/today.md so
  // headless skill runs can see today's deck. No-op in snapshot/mock mode.
  saveDeckSnapshot: async (content: string): Promise<void> => {
    if (isTauri()) return invoke<void>("save_deck_snapshot", { content });
    if (await isWebServer()) return httpCall<void>("save_deck_snapshot", { content });
  },

  // Skill editor — overwrite a SKILL.md (backend confines to ~/.claude/skills).
  writeSkill: async (path: string, content: string): Promise<void> => {
    if (isTauri()) return invoke<void>("write_skill", { path, content });
    if (await isWebServer()) return httpCall<void>("write_skill", { path, content });
    return Promise.reject(new Error("Editing skills is only available in the app"));
  },

  // Execution engine — runs a headless `claude -p`. Works in the desktop app and
  // the local web server (each spawns in its own process); not in snapshot/mock.
  runSkill: async (params: {
    skill: string;
    label: string;
    prompt: string;
    bin?: string;
    args?: string;
    cwd?: string;
  }): Promise<string> => {
    if (isTauri()) return invoke<string>("run_skill", params);
    if (await isWebServer()) return httpCall<string>("run_skill", params);
    return Promise.reject(new Error("Running skills is only available in the app"));
  },

  getJob: async (id: string): Promise<Job> => {
    if (isTauri()) {
      const j = await invoke<Job | null>("get_job", { id });
      if (!j) throw new Error("Unknown job");
      return j;
    }
    if (await isWebServer()) return httpCall<Job>("get_job", { id });
    return Promise.reject(new Error("Running skills is only available in the app"));
  },

  listJobs: async (): Promise<Job[]> => {
    if (isTauri()) return invoke<Job[]>("list_jobs", {});
    if (await isWebServer()) return httpCall<Job[]>("list_jobs", {});
    return [];
  },

  // Pull CipherCodex reading notes from the WebDAV store into the vault.
  codexSync: async (outDir: string, stateUrl: string): Promise<CodexSyncResult> => {
    if (isTauri()) return invoke<CodexSyncResult>("codex_sync", { outDir, stateUrl });
    return desktopOnly();
  },

  // --- cipherSizzle: auto-highlights ---
  detectHighlights: (path: string, topN: number) =>
    resolve<Highlight[]>("detect_highlights", { path, topN }, () => [], mock.highlights),

  startSizzle: async (args: {
    src: string;
    topN: number;
    vertical: boolean;
    mashup: boolean;
    outDir?: string;
    ollamaUrl?: string;
    facecam?: FacecamLayout;
    cloud?: CloudVision;
    /** Caption STT parts + WhisperX container — lets the fine scan hear the dialog. */
    stt?: {
      url: string;
      headers: Record<string, string>;
      fields: Record<string, string>;
      fileField: string;
      container: string;
    };
  }): Promise<string> => {
    if (isTauri()) return invoke<string>("start_sizzle", args);
    if (await isWebServer()) return httpCall<string>("start_sizzle", args);
    return Promise.reject(new Error("Highlights are only available in the app / web server"));
  },

  listClips: (jobId: string, outDir?: string) =>
    resolve<Clip[]>("list_clips", { jobId, outDir }, () => [], () => []),

  // Source video path a finished job analyzed (for Reanalyze without re-download).
  sizzleSource: async (jobId: string, outDir?: string): Promise<string> => {
    if (isTauri()) return invoke<string>("sizzle_source", { jobId, outDir });
    if (await isWebServer()) return httpCall<string>("sizzle_source", { jobId, outDir });
    return desktopOnly();
  },

  // Re-cut one clip at adjusted bounds (Adjust start & end — trim or extend).
  recutClip: async (jobId: string, name: string, start: number, end: number, outDir?: string): Promise<Clip> => {
    if (isTauri()) return invoke<Clip>("recut_clip", { jobId, name, start, end, outDir });
    if (await isWebServer()) return httpCall<Clip>("recut_clip", { jobId, name, start, end, outDir });
    return desktopOnly();
  },

  // Burn animated captions into a copy of one clip (original kept).
  captionClip: async (args: {
    jobId: string;
    name: string;
    style: string;
    sttUrl: string;
    sttHeaders: Record<string, string>;
    sttFields: Record<string, string>;
    fileField: string;
    outDir?: string;
  }): Promise<Clip> => {
    if (isTauri()) return invoke<Clip>("caption_clip", args);
    if (await isWebServer()) return httpCall<Clip>("caption_clip", args);
    return desktopOnly();
  },

  // Stitch selected clips (in order) from one job into a compilation video.
  makeCompilation: async (jobId: string, names: string[], outDir?: string): Promise<Clip> => {
    if (isTauri()) return invoke<Clip>("make_compilation", { jobId, names, outDir });
    if (await isWebServer()) return httpCall<Clip>("make_compilation", { jobId, names, outDir });
    return desktopOnly();
  },

  stopJob: async (id: string): Promise<void> => {
    if (isTauri()) return invoke<void>("stop_job", { id });
    if (await isWebServer()) {
      await httpCall("stop_job", { id });
      return;
    }
    return Promise.reject(new Error("Running skills is only available in the app"));
  },

  getAudit: async (limit?: number): Promise<AuditEntry[]> => {
    if (isTauri()) return invoke<AuditEntry[]>("get_audit", { limit });
    if (await isWebServer()) return httpCall<AuditEntry[]>("get_audit", { limit });
    return [];
  },

  // --- Agent PTY sessions (hosted by serve; see agentCall above) ---
  agentSpawn: (params: {
    bin: string;
    args?: string[];
    title?: string;
    cwd?: string;
    createCwd?: boolean;
    resume?: { projectId: string; sessionId: string };
  }) => agentCall<{ id: string }>("agent_spawn", params),

  agentList: () => agentCall<AgentSessionInfo[]>("agent_list", {}),

  agentRead: (id: string, offset: number) =>
    agentCall<{
      dataB64: string;
      offset: number;
      status: "running" | "exited";
      exitCode?: number;
    }>("agent_read", { id, offset }),

  agentWrite: (id: string, dataB64: string) =>
    agentCall<Record<string, never>>("agent_write", { id, dataB64 }),

  agentResize: (id: string, cols: number, rows: number) =>
    agentCall<Record<string, never>>("agent_resize", { id, cols, rows }),

  agentKill: (id: string) => agentCall<Record<string, never>>("agent_kill", { id }),

  agentRemove: (id: string) => agentCall<Record<string, never>>("agent_remove", { id }),
};
