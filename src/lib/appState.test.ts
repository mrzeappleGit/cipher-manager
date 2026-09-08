import { beforeEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ loadAppState: vi.fn(), saveAppState: vi.fn() }));
vi.mock("../api", () => ({ api: backend }));
vi.mock("./toast", () => ({ notify: { error: vi.fn() } }));
import { mirrorAppState } from "./appState";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
beforeEach(() => { backend.loadAppState.mockReset().mockResolvedValue(null); backend.saveAppState.mockReset().mockResolvedValue(undefined); });

it("preserves an edit made before disk hydration", async () => {
  const load = deferred<string>();
  backend.loadAppState.mockReturnValue(load.promise);
  let state = "local";
  const store = mirrorAppState("test", (raw) => { state = raw; }, () => state);
  state = "edited";
  store.onPersist();
  load.resolve("stale disk");
  await store.flush();
  expect(state).toBe("edited");
  expect(backend.saveAppState).toHaveBeenLastCalledWith("test", "edited");
});

it("serializes writes and flushes the latest state", async () => {
  const first = deferred<void>();
  backend.saveAppState.mockReturnValueOnce(first.promise);
  let state = "first";
  const store = mirrorAppState("test", (raw) => { state = raw; }, () => state);
  await store.ready;
  store.onPersist();
  await Promise.resolve();
  state = "latest";
  store.onPersist();
  expect(backend.saveAppState).toHaveBeenCalledTimes(1);
  first.resolve();
  await store.flush();
  expect(backend.saveAppState.mock.calls).toEqual([["test", "first"], ["test", "latest"]]);
});

it("rejects failed flushes and retains a pending snapshot for retry", async () => {
  backend.saveAppState.mockRejectedValueOnce(new Error("disk full"));
  const store = mirrorAppState("test", () => {}, () => "keep me");
  await store.ready;
  store.onPersist();
  await expect(store.flush()).rejects.toThrow("disk full");
  await store.flush();
  expect(backend.saveAppState).toHaveBeenLastCalledWith("test", "keep me");
  expect(backend.saveAppState).toHaveBeenCalledTimes(2);
});
