// OAuth Authorization Code flow. The interactive login runs in Rust (a one-shot
// localhost listener — desktop only); token refresh runs here through the HTTP
// proxy. Used for Twitch (follower/sub counts) and Google (YouTube Analytics).

import { invoke } from "@tauri-apps/api/core";
import { aiRequest, isTauri } from "../api";

export interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  port: number;
  extraAuth?: Record<string, string>;
}

// Both flows use the same loopback port; they never run at the same time, and
// the redirect URL (http://localhost:4636) is registered in each provider's app.
export const TWITCH_OAUTH: OAuthProvider = {
  authUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  // clips:edit + chat:* power the clip pipeline (CLIP IT button, !clip chat
  // command). Tokens minted before these were added need a re-connect.
  scope: "moderator:read:followers channel:read:subscriptions clips:edit chat:read chat:edit",
  port: 4636,
};

export const GOOGLE_OAUTH: OAuthProvider = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/yt-analytics.readonly",
  port: 4636,
  extraAuth: { access_type: "offline", prompt: "consent" },
};

// Deliberately a separate provider from GOOGLE_OAUTH rather than another scope
// on it: widening that one's scope forces a re-consent that invalidates the
// working YouTube refresh token. Same client id/secret, its own token.
// `gmail.readonly` is a restricted scope — fine for a personal desktop client
// with yourself as a test user, but Google requires verification to publish.
export const GMAIL_OAUTH: OAuthProvider = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  port: 4636,
  // `select_account` as well as `consent`, because this provider can be linked
  // several times over (one slot per mailbox). `consent` alone only forces the
  // permission screen — with an active Google session Google re-authorizes
  // whoever is already signed in, so "add another" silently mints another
  // token for the SAME account and the extra slot does nothing.
  extraAuth: { access_type: "offline", prompt: "select_account consent" },
};

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Interactive login — opens the browser, captures the redirect, returns tokens.
 * Desktop-app only (needs a localhost listener the browser sandbox can't run). */
export async function oauthLogin(
  p: OAuthProvider,
  clientId: string,
  clientSecret: string
): Promise<OAuthTokens> {
  if (!isTauri()) {
    throw new Error("Connect from the desktop app — the browser can't complete this login.");
  }
  return invoke<OAuthTokens>("oauth_login", {
    authUrl: p.authUrl,
    tokenUrl: p.tokenUrl,
    clientId,
    clientSecret,
    scope: p.scope,
    port: p.port,
    extraAuth: p.extraAuth ?? {},
  });
}

// Short-lived access tokens are cached in localStorage until ~1 min before expiry.
function cacheKey(name: string) {
  return "cipher-manager.oauthTok." + name;
}
function readCache(name: string): string | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(name)) || "null");
    if (c && c.exp > Date.now() + 60_000) return c.token;
  } catch {
    /* refetch */
  }
  return null;
}
/** Evict a cached access token (call when the API 401s it — a token can die
 * server-side long before its local expiry, e.g. after a secret rotation). */
export function clearTokenCache(name: string) {
  try {
    localStorage.removeItem(cacheKey(name));
  } catch {
    /* ignore */
  }
}
function writeCache(name: string, token: string, expiresIn: number) {
  try {
    localStorage.setItem(
      cacheKey(name),
      JSON.stringify({ token, exp: Date.now() + expiresIn * 1000 })
    );
  } catch {
    /* ignore */
  }
}

/** Exchange a refresh token for a fresh access token (cached). `onRotate` fires
 * when the provider issues a new refresh token (Twitch rotates them; Google
 * doesn't) so the caller can persist it. */
export async function accessTokenFromRefresh(
  name: string,
  p: OAuthProvider,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  onRotate: (t: string) => void
): Promise<string> {
  const cached = readCache(name);
  if (cached) return cached;
  // Vault placeholders must reach the backend VERBATIM — the resolver matches
  // the literal {{secret:id}} token, so URL-encoding it breaks resolution.
  // ponytail: resolved secrets are provider-issued (no &/=/+), safe unencoded.
  const enc = (v: string) => (/^\{\{secret:[a-z0-9-]+\}\}$/.test(v) ? v : encodeURIComponent(v));
  const body =
    `grant_type=refresh_token` +
    `&refresh_token=${enc(refreshToken)}` +
    `&client_id=${enc(clientId)}` +
    `&client_secret=${enc(clientSecret)}`;
  const r = await aiRequest(
    p.tokenUrl,
    { "content-type": "application/x-www-form-urlencoded" },
    body
  );
  const j = JSON.parse(r.text || "null");
  if (r.status >= 400 || !j?.access_token) {
    throw new Error(j?.message || j?.error_description || j?.error || "token refresh failed");
  }
  if (j.refresh_token && j.refresh_token !== refreshToken) onRotate(j.refresh_token);
  writeCache(name, j.access_token, j.expires_in || 3600);
  return j.access_token;
}
