// Mirror a localStorage-backed store to the shared on-disk app state
// (~/.claude/cipher-manager/<key>.json), so the desktop app and the web
// server (phone) converge on one config. Disk wins once at boot; after that
// every persist writes back. ponytail: last writer wins across clients — add
// timestamps only if real conflicts ever show up.

import { api } from "../api";
import { notify } from "./toast";

export function mirrorAppState(
  key: string,
  apply: (json: string) => void,
  current: () => string,
  hydration: { validate?: (json: string) => void; onError?: (error: unknown) => void } = {}
): { ready: Promise<void>; flush: () => Promise<void>; onPersist: () => void } {
  let dirty = false;
  let writing: Promise<void> | null = null;
  const ready = api
    .loadAppState(key)
    .then((raw) => {
      // Validation still runs when an early local edit takes precedence.
      if (raw !== null) hydration.validate?.(raw);
      if (raw && !dirty) {
        if (raw !== current()) apply(raw);
        // Store normalization may remove obsolete fields during hydration.
        if (raw !== current()) dirty = true;
      }
    })
    .catch((error) => {
      hydration.onError?.(error);
      /* backend unavailable (mock/snapshot) — localStorage carries on */
    })
    .then(() => {
      if (dirty) void flush().catch(() => {});
    });
  async function flush(): Promise<void> {
    await ready;
    if (writing) return writing;
    writing = (async () => {
      while (dirty) {
        dirty = false;
        try {
          await api.saveAppState(key, current());
        } catch (error) {
          dirty = true;
          notify.error(`Couldn't save ${key}. Click to retry.`, () => { void flush().catch(() => {}); });
          throw error;
        }
      }
    })();
    try { await writing; } finally { writing = null; }
  }
  return {
    ready,
    flush,
    onPersist: () => {
      dirty = true;
      void flush().catch(() => {});
    },
  };
}
