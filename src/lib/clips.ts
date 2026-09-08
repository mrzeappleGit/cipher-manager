// Live Twitch clip pipeline (folded in from the standalone clipping-tool):
// create real clips via Helix while the stream is live, keep a labelled log
// (disk-mirrored so phone + desktop share it), and export a reel playlist.
// Uses the same Twitch OAuth creds as the creator card; clips need the
// clips:edit scope (re-connect Twitch in Settings if the token predates it).

import { useSyncExternalStore } from "react";
import { aiRequest } from "../api";
import { mirrorAppState } from "./appState";
import { accessTokenFromRefresh, clearTokenCache, TWITCH_OAUTH } from "./oauth";
import { getSettings } from "./settings";
import { keyRef, keyConfigured, setSecret as vaultSet } from "./secrets";

export const CLIP_LABELS = ["Clip", "Funny", "Epic", "Hype", "Fail"] as const;

export interface ClipEntry {
  id: string;
  url: string;
  editUrl: string;
  label: string;
  note: string;
  at: string; // ISO timestamp
  source: "button" | "chat";
}

// --- Clip log store (module state + disk mirror, same pattern as deckStore) ---

const KEY = "cipher-manager.clip-log";
let log: ClipEntry[] = load();
let listeners: Array<() => void> = [];

function load(): ClipEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

const mirror = mirrorAppState(
  "clip-log",
  (json) => {
    try {
      log = JSON.parse(json);
      try {
        localStorage.setItem(KEY, json);
      } catch {
        /* ignore */
      }
      for (const l of listeners) l();
    } catch {
      /* bad disk state — keep local */
    }
  },
  () => JSON.stringify(log)
);

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    /* ignore */
  }
  mirror.onPersist();
  for (const l of listeners) l();
}

export function useClipLog(): ClipEntry[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => log
  );
}

export function removeClip(id: string) {
  log = log.filter((c) => c.id !== id);
  persist();
}

export function clearClipLog() {
  log = [];
  persist();
}

/** Plain-text reel playlist (parity with the clipping-tool's reel.txt). */
export function reelText(): string {
  return log
    .map((c) => `${c.url}  —  ${c.label}${c.note ? ` (${c.note})` : ""}  ·  ${c.at}`)
    .join("\n");
}

// --- Twitch Helix ---------------------------------------------------------

export function clipsConfigured(): boolean {
  const s = getSettings();
  return !!(s.twitchClientId && s.twitchLogin && keyConfigured("twitch-client-secret", s.twitchClientSecret) && keyConfigured("twitch-refresh-token", s.twitchRefreshToken));
}

async function userToken(): Promise<string> {
  const s = getSettings();
  if (!clipsConfigured()) {
    throw new Error("Connect Twitch in Settings (client id/secret, login, and Connect) first.");
  }
  return accessTokenFromRefresh(
    "twitch",
    TWITCH_OAUTH,
    s.twitchClientId,
    keyRef("twitch-client-secret", s.twitchClientSecret),
    keyRef("twitch-refresh-token", s.twitchRefreshToken),
    (t) => void vaultSet("twitch-refresh-token", t)
  );
}

async function helix(pathAndQuery: string, method = "GET", retried = false): Promise<any> {
  const s = getSettings();
  const token = await userToken();
  const r = await aiRequest(
    `https://api.twitch.tv/helix${pathAndQuery}`,
    { "Client-Id": s.twitchClientId, Authorization: `Bearer ${token}` },
    "",
    method
  );
  const j = JSON.parse(r.text || "null");
  if (r.status >= 400) {
    if (r.status === 404) throw new Error("Channel is offline — Twitch only clips live streams.");
    if (r.status === 401 && !retried) {
      // Cached access token died server-side — evict and mint a fresh one.
      clearTokenCache("twitch");
      return helix(pathAndQuery, method, true);
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error(
        j?.message ?? "Twitch refused — re-connect Twitch in Settings to grant the clips scope."
      );
    }
    throw new Error(j?.message || `Twitch HTTP ${r.status}`);
  }
  return j;
}

let broadcasterId: string | null = null;
async function getBroadcasterId(): Promise<string> {
  if (broadcasterId) return broadcasterId;
  const login = getSettings().twitchLogin.trim().toLowerCase().replace(/^@/, "");
  const j = await helix(`/users?login=${login}`);
  const id = j.data?.[0]?.id;
  if (!id) throw new Error(`Twitch user "${login}" not found`);
  broadcasterId = id;
  return id;
}

/** Create a real Twitch clip of the live stream and log it. */
export async function createTwitchClip(
  label: string,
  note: string,
  source: ClipEntry["source"] = "button"
): Promise<ClipEntry> {
  const id = await getBroadcasterId();
  const j = await helix(`/clips?broadcaster_id=${id}`, "POST");
  const c = j.data?.[0];
  if (!c?.id) throw new Error("Twitch returned no clip");
  const entry: ClipEntry = {
    id: c.id,
    url: `https://clips.twitch.tv/${c.id}`,
    editUrl: c.edit_url,
    label,
    note,
    at: new Date().toISOString(),
    source,
  };
  log = [entry, ...log].slice(0, 500);
  persist();
  return entry;
}

export interface Vod {
  id: string;
  title: string;
  url: string;
  date: string;
  duration: string;
  /** Stream thumbnail ("" while Twitch is still processing the VOD). */
  thumb: string;
  /** Game being played ("" if lookup failed). */
  game: string;
}

/** Helix /videos has no game field; Twitch's public GQL does (same API yt-dlp
 * uses). One batched query, best-effort — failures just leave game blank. */
async function vodGames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const q = ids.map((id, i) => `v${i}: video(id:"${id}"){game{displayName}}`).join(" ");
    const r = await aiRequest(
      "https://gql.twitch.tv/gql",
      { "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h0ko", "Content-Type": "application/json" },
      JSON.stringify({ query: `query{${q}}` })
    );
    const d = JSON.parse(r.text)?.data ?? {};
    return Object.fromEntries(ids.map((id, i) => [id, d[`v${i}`]?.game?.displayName ?? ""]));
  } catch {
    return {};
  }
}

/** The channel's most recent VODs — feeds "use latest VOD" on Highlights. */
export async function latestVods(n = 5): Promise<Vod[]> {
  const id = await getBroadcasterId();
  const j = await helix(`/videos?user_id=${id}&first=${n}&type=archive`);
  const data: Array<{
    id: string;
    title: string;
    url: string;
    created_at: string;
    duration: string;
    thumbnail_url?: string;
  }> = j.data ?? [];
  const games = await vodGames(data.map((v) => v.id));
  return data.map((v) => ({
    id: v.id,
    title: v.title,
    url: v.url || `https://www.twitch.tv/videos/${v.id}`,
    date: v.created_at,
    duration: v.duration,
    // Fresh VODs return a "processing" placeholder with no size template — skip it.
    thumb: v.thumbnail_url?.includes("%{width}")
      ? v.thumbnail_url.replace("%{width}", "320").replace("%{height}", "180")
      : "",
    game: games[v.id] ?? "",
  }));
}

/** Raw user token for the chat (IRC) connection. */
export async function chatToken(): Promise<{ token: string; login: string }> {
  const token = await userToken();
  return { token, login: getSettings().twitchLogin.trim().toLowerCase().replace(/^@/, "") };
}
