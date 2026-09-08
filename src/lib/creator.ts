// Twitch + YouTube stats for the dashboard creator card. All calls go through
// the backend HTTP proxy (aiRequest) so browser CORS doesn't apply.

import { aiRequest } from "../api";
import { getSettings } from "./settings";
import { accessTokenFromRefresh, clearTokenCache, GOOGLE_OAUTH, TWITCH_OAUTH } from "./oauth";
import { keyRef, keyConfigured, setSecret as vaultSet } from "./secrets";

export interface YtVideo {
  id: string;
  title: string;
  views: number;
  published: string;
}

export interface CreatorStats {
  youtube?: {
    subs: number;
    views: number;
    videos: number;
    latest: YtVideo[];
    /** Last-28-day analytics (OAuth only). */
    analytics?: { views: number; minutes: number; days: number };
  };
  twitch?: {
    displayName: string;
    live: boolean;
    title?: string;
    game?: string;
    viewers?: number;
    vods: { id: string; title: string; views: number; date: string }[];
    /** Follower + subscriber counts (OAuth only). */
    followers?: number;
    subs?: number;
    subPoints?: number;
  };
  errors: string[];
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await aiRequest(url, headers, "", "GET");
  const j = JSON.parse(r.text || "null");
  if (r.status >= 400) {
    throw new Error(j?.message || j?.error?.message || `HTTP ${r.status}`);
  }
  return j;
}

// --- YouTube (plain API key, no OAuth) ---

async function fetchYouTube(key: string, channel: string) {
  const base = "https://www.googleapis.com/youtube/v3";
  const c = channel.trim();
  const sel = c.startsWith("UC")
    ? `id=${c}`
    : `forHandle=${encodeURIComponent(c.replace(/^@/, ""))}`;
  const ch = await getJson(`${base}/channels?part=statistics,contentDetails&${sel}`, { "X-Goog-Api-Key": key });
  const item = ch.items?.[0];
  if (!item) throw new Error("channel not found");
  const st = item.statistics;
  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  let latest: YtVideo[] = [];
  if (uploads) {
    const pl = await getJson(
      `${base}/playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=3`,
      { "X-Goog-Api-Key": key }
    );
    const ids = (pl.items ?? [])
      .map((i: { contentDetails: { videoId: string } }) => i.contentDetails.videoId)
      .join(",");
    if (ids) {
      const vids = await getJson(`${base}/videos?part=snippet,statistics&id=${ids}`, { "X-Goog-Api-Key": key });
      latest = (vids.items ?? []).map(
        (v: {
          id: string;
          snippet: { title: string; publishedAt: string };
          statistics: { viewCount: string };
        }) => ({
          id: v.id,
          title: v.snippet.title,
          views: +v.statistics.viewCount || 0,
          published: v.snippet.publishedAt,
        })
      );
    }
  }
  const yt = {
    subs: +st.subscriberCount || 0,
    views: +st.viewCount || 0,
    videos: +st.videoCount || 0,
    latest,
    analytics: undefined as { views: number; minutes: number; days: number } | undefined,
  };

  // OAuth analytics (watch time / views over the last 28 days), if connected.
  // A dead refresh token only costs the analytics row, not the whole card.
  const s = getSettings();
  if (s.googleClientId && keyConfigured("google-client-secret", s.googleClientSecret) && keyConfigured("youtube-refresh-token", s.youtubeRefreshToken)) {
    try {
      const access = await accessTokenFromRefresh(
        "google",
        GOOGLE_OAUTH,
        s.googleClientId,
        keyRef("google-client-secret", s.googleClientSecret),
        keyRef("youtube-refresh-token", s.youtubeRefreshToken),
        (t) => void vaultSet("youtube-refresh-token", t)
      );
      const end = new Date();
      const start = new Date(end.getTime() - 28 * 86400_000);
      const rep = await getJson(
        `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE` +
          `&startDate=${ymd(start)}&endDate=${ymd(end)}` +
          `&metrics=views,estimatedMinutesWatched`,
        { Authorization: `Bearer ${access}` }
      );
      const row = rep.rows?.[0];
      if (row) yt.analytics = { views: +row[0] || 0, minutes: +row[1] || 0, days: 28 };
    } catch {
      /* reconnect Google in Settings to restore analytics */
    }
  }
  return yt;
}

// --- Twitch (client-credentials app token, cached until near expiry) ---

const TOKEN_KEY = "cipher-manager.twitchToken";

async function twitchToken(id: string, secret: string): Promise<string> {
  try {
    const c = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (c && c.id === id && c.exp > Date.now() + 60_000) return c.token;
  } catch {
    /* refetch */
  }
  const r = await aiRequest(
    "https://id.twitch.tv/oauth2/token",
    { "content-type": "application/x-www-form-urlencoded" },
    `client_id=${id}&client_secret=${secret}&grant_type=client_credentials`
  );
  const j = JSON.parse(r.text || "null");
  if (r.status >= 400 || !j?.access_token) throw new Error(j?.message || "auth failed");
  try {
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ id, token: j.access_token, exp: Date.now() + j.expires_in * 1000 })
    );
  } catch {
    /* ignore */
  }
  return j.access_token;
}

async function fetchTwitch(id: string, secret: string, login: string) {
  try {
    return await fetchTwitchInner(id, secret, login);
  } catch (e) {
    // The cached app token can die server-side long before its ~60-day local
    // expiry (secret rotation invalidates it). Evict and retry once fresh.
    if (!/invalid oauth token/i.test((e as Error).message)) throw e;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    clearTokenCache("twitch");
    return fetchTwitchInner(id, secret, login);
  }
}

async function fetchTwitchInner(id: string, secret: string, login: string) {
  const token = await twitchToken(id, secret);
  const h = { "Client-Id": id, Authorization: `Bearer ${token}` };
  const l = login.trim().toLowerCase().replace(/^@/, "");
  const [users, streams] = await Promise.all([
    getJson(`https://api.twitch.tv/helix/users?login=${l}`, h),
    getJson(`https://api.twitch.tv/helix/streams?user_login=${l}`, h),
  ]);
  const u = users.data?.[0];
  if (!u) throw new Error("user not found");
  const vodsRes = await getJson(
    `https://api.twitch.tv/helix/videos?user_id=${u.id}&first=3&type=archive`,
    h
  );
  const vods = (vodsRes.data ?? []).map(
    (v: { id: string; title: string; view_count: number; created_at: string }) => ({
      id: v.id,
      title: v.title,
      views: v.view_count,
      date: v.created_at,
    })
  );
  const s = streams.data?.[0];
  const base = s
    ? {
        displayName: u.display_name as string,
        live: true,
        title: s.title as string,
        game: s.game_name as string,
        viewers: s.viewer_count as number,
        vods,
      }
    : { displayName: u.display_name as string, live: false, vods };

  // Follower + subscriber counts need a USER token (OAuth), not the app token.
  const cfg = getSettings();
  const result: CreatorStats["twitch"] = { ...base };
  if (keyConfigured("twitch-refresh-token", cfg.twitchRefreshToken)) {
    let userToken: string;
    try {
      userToken = await accessTokenFromRefresh(
        "twitch",
        TWITCH_OAUTH,
        id,
        secret,
        keyRef("twitch-refresh-token", cfg.twitchRefreshToken),
        (t) => void vaultSet("twitch-refresh-token", t)
      );
    } catch {
      return result; // token dead — user must reconnect; leave the base stats.
    }
    const uh = { "Client-Id": id, Authorization: `Bearer ${userToken}` };
    // Followers and subs independently — a non-affiliate channel 403s on subs.
    const [f, sub] = await Promise.allSettled([
      getJson(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${u.id}&first=1`, uh),
      getJson(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${u.id}&first=1`, uh),
    ]);
    if (f.status === "fulfilled") result.followers = f.value.total ?? 0;
    if (sub.status === "fulfilled") {
      result.subs = sub.value.total ?? 0;
      result.subPoints = sub.value.points ?? undefined;
    }
  }
  return result;
}

export function creatorConfigured(): boolean {
  const s = getSettings();
  return !!(
    (keyConfigured("youtube-api-key", s.youtubeApiKey) && s.youtubeChannel) ||
    (s.twitchClientId && keyConfigured("twitch-client-secret", s.twitchClientSecret) && s.twitchLogin)
  );
}

export async function fetchCreatorStats(): Promise<CreatorStats> {
  const s = getSettings();
  const out: CreatorStats = { errors: [] };
  await Promise.all([
    (async () => {
      if (!keyConfigured("youtube-api-key", s.youtubeApiKey) || !s.youtubeChannel) return;
      try {
        out.youtube = await fetchYouTube(keyRef("youtube-api-key", s.youtubeApiKey), s.youtubeChannel);
      } catch (e) {
        out.errors.push(`YouTube: ${(e as Error).message}`);
      }
    })(),
    (async () => {
      if (!s.twitchClientId || !keyConfigured("twitch-client-secret", s.twitchClientSecret) || !s.twitchLogin) return;
      try {
        out.twitch = await fetchTwitch(s.twitchClientId, keyRef("twitch-client-secret", s.twitchClientSecret), s.twitchLogin);
      } catch (e) {
        out.errors.push(`Twitch: ${(e as Error).message}`);
      }
    })(),
  ]);
  return out;
}
