import { useEffect, useState, type DependencyList } from "react";

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Run an async function, tracking loading/error/data, with a manual reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((d) => {
        if (alive) setState({ data: d, error: null, loading: false });
      })
      .catch((e) => {
        if (alive)
          setState({ data: null, error: String(e?.message ?? e), loading: false });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

// Process-lifetime cache so revisiting a tab doesn't refetch. Cleared on a full
// page reload (which the sidebar "Refresh data" button triggers).
const asyncCache = new Map<string, unknown>();
// When each key was last fetched (for "synced Xm ago" stamps).
const asyncCacheAt = new Map<string, number>();
// In-flight fetches, so two hooks mounting with the same key share one request.
const asyncPending = new Map<string, Promise<unknown>>();
// Hook instances subscribed per key — a refresh by one updates all of them.
const cacheListeners = new Map<string, Set<() => void>>();

function storeResult(key: string, data: unknown) {
  asyncCache.set(key, data);
  asyncCacheAt.set(key, Date.now());
  for (const l of cacheListeners.get(key) ?? []) l();
}

/** Like useAsync, but memoizes the result under `key` for the session. The fetch
 * runs once; navigating away and back reuses the cached value (no spinner, no
 * refetch). Multiple mounted hooks with the same key share the fetch and stay in
 * sync. `reload()` busts this key and refetches; `refresh()` refetches silently. */
export function useCachedAsync<T>(key: string, fn: () => Promise<T>) {
  const has = asyncCache.has(key);
  const [state, setState] = useState<AsyncState<T>>({
    data: has ? (asyncCache.get(key) as T) : null,
    error: null,
    loading: !has,
  });
  const [nonce, setNonce] = useState(0);

  // Track cache updates made by other hook instances (or refresh()).
  useEffect(() => {
    const l = () => setState({ data: asyncCache.get(key) as T, error: null, loading: false });
    let set = cacheListeners.get(key);
    if (!set) cacheListeners.set(key, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
    };
  }, [key]);

  useEffect(() => {
    if (asyncCache.has(key)) {
      setState({ data: asyncCache.get(key) as T, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    let p = asyncPending.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().then((d) => {
        storeResult(key, d);
        return d;
      });
      asyncPending.set(key, p);
      p.finally(() => asyncPending.delete(key)).catch(() => {});
    }
    p.catch((e) => {
      if (alive) setState({ data: null, error: String(e?.message ?? e), loading: false });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return {
    ...state,
    /** Epoch ms of the last successful fetch for this key (null before one). */
    updatedAt: asyncCacheAt.get(key) ?? null,
    reload: () => {
      asyncCache.delete(key);
      setNonce((n) => n + 1);
    },
    /** Refetch in the background without dropping the shown data (no spinner).
     * A failed refresh keeps the stale data silently. */
    refresh: async () => {
      try {
        storeResult(key, await fn());
      } catch {
        /* keep stale data */
      }
    },
  };
}
