// Persisted state: server origin, pairing token, last route, cached DTOs.
// Android may reclaim the WebView at any time, so everything important is
// written eagerly through the SDK's local storage (with an in-memory mirror
// so reads stay synchronous for the render path).

let bridgeStore: {
  set: (k: string, v: string) => Promise<unknown>;
  get: (k: string) => Promise<string | null | undefined>;
} | null = null;

const mem = new Map<string, string>();

const KEYS = ["origin", "token", "route", "cache.now", "cache.deck", "cache.brief", "cache.projects"];

/** Call once after the bridge is up; hydrates the in-memory mirror. */
export async function initState(bridge: {
  setLocalStorage: (k: string, v: string) => Promise<unknown>;
  getLocalStorage: (k: string) => Promise<string | null | undefined>;
}): Promise<void> {
  bridgeStore = { set: (k, v) => bridge.setLocalStorage(k, v), get: (k) => bridge.getLocalStorage(k) };
  for (const k of KEYS) {
    try {
      const v = await bridgeStore.get(`cm.${k}`);
      if (typeof v === "string" && v) mem.set(k, v);
    } catch {
      /* fresh install */
    }
  }
}

function persist(k: string, v: string): void {
  mem.set(k, v);
  void bridgeStore?.set(`cm.${k}`, v).catch(() => {});
}

// --- config ---

/** The Tailscale-served HTTPS origin for cipherManager's serve process —
 * reachable from the phone (tailnet) and from this PC (simulator) alike.
 * Must match an app.json whitelist entry. */
const DEFAULT_ORIGIN = "";

export function getConfig(): { origin: string } {
  return { origin: mem.get("origin") || DEFAULT_ORIGIN };
}

export function setOrigin(origin: string): void {
  persist("origin", origin);
}

// --- pairing token ---

export function getToken(): string | null {
  return mem.get("token") || null;
}

export async function setToken(token: string): Promise<void> {
  persist("token", token);
}

// --- cached last-good DTOs (shown immediately with their timestamp) ---

export function getCache<T>(key: string): T | null {
  const raw = mem.get(`cache.${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setCache(key: string, value: unknown): void {
  persist(`cache.${key}`, JSON.stringify(value));
}

// --- last route (restored on relaunch; never restores into an action) ---

export function saveRoute(name: string): void {
  persist("route", name);
}

export function lastRoute(): string {
  return mem.get("route") || "root";
}
