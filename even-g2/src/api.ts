// HTTP client for the cipherManager G2 facade. Scoped bearer token from
// pairing; never any other credential. All responses are tiny text DTOs.

import { getConfig, getToken, setToken } from "./state";

const TIMEOUT_MS = 8000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getConfig().origin.replace(/\/$/, "");
  if (!base) throw new Error("Configure your server origin in src/state.ts and app.json before pairing.");
  const token = getToken();
  // Hard timeout: a hung fetch on the glasses looks like a dead button.
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(`${base}/api/g2/${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (e) {
    const why = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
    throw new Error(`Can't reach ${base} (${why}). Is the phone on the tailnet?`);
  } finally {
    window.clearTimeout(timer);
  }
  if (r.status === 401) throw new Error("UNPAIRED");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  now: () => call<import("./types").NowDto>("now"),
  deck: () => call<import("./types").DeckDto>("deck"),
  brief: () => call<import("./types").BriefDto>("brief"),
  projects: () => call<import("./types").ProjectsDto>("projects"),

  pairStart: (device: string) =>
    call<{ code: string; expiresInSec: number }>("pair/start", {
      method: "POST",
      body: JSON.stringify({ device }),
    }),

  /** Polls until approved; stores the token on success. Returns true when paired. */
  pairPoll: async (code: string): Promise<boolean> => {
    const r = await call<{ status: string; token?: string }>("pair/status", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (r.status === "approved" && r.token) {
      await setToken(r.token);
      return true;
    }
    if (r.status === "expired") throw new Error("Code expired — start again");
    return false;
  },
};
