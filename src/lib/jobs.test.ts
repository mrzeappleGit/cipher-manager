import { afterEach, beforeEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ runSkill: vi.fn(), getJob: vi.fn() }));
const config = vi.hoisted(() => ({
  ready: Promise.resolve(), flush: vi.fn(),
  value: { actingMode: false, workDir: "", claudeBin: "claude", claudeArgs: "" },
}));
vi.mock("../api", () => ({ api: backend }));
vi.mock("./settings", () => ({ getSettings: () => config.value, get settingsReady() { return config.ready; }, flushSettings: config.flush }));
vi.mock("./toast", () => ({ notify: { error: vi.fn() } }));
vi.mock("./notify", () => ({ notifyDesktop: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); config.value.actingMode = false; config.ready = Promise.resolve();
  backend.runSkill.mockReset().mockResolvedValue("job-1"); backend.getJob.mockReset(); config.flush.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const params = { skill: "test", label: "Test", prompt: "Test" };

it("rejects every launch while Acting mode is off or the permission cannot be saved", async () => {
  const { startJob } = await import("./jobs");
  expect(await startJob(params)).toBeNull();
  expect(backend.runSkill).not.toHaveBeenCalled();
  config.value.actingMode = true;
  config.flush.mockRejectedValueOnce(new Error("disk full"));
  expect(await startJob(params)).toBeNull();
  expect(backend.runSkill).not.toHaveBeenCalled();
});

it("waits for settings hydration and rechecks permission after saving", async () => {
  let release!: () => void;
  config.ready = new Promise<void>((resolve) => { release = resolve; });
  config.value.actingMode = true;
  config.flush.mockImplementation(async () => { config.value.actingMode = false; });
  const { startJob } = await import("./jobs");
  const launch = startJob(params);
  await Promise.resolve();
  expect(config.flush).not.toHaveBeenCalled();
  release();
  expect(await launch).toBeNull();
  expect(backend.runSkill).not.toHaveBeenCalled();
});

it("rechecks queued work after settings saving and skips canceled launches", async () => {
  config.value.actingMode = true;
  let due = true;
  config.flush.mockImplementation(async () => { due = false; });
  const canLaunch = vi.fn(() => due);
  const { startJob } = await import("./jobs");
  expect(await startJob({ ...params, canLaunch })).toBeNull();
  expect(canLaunch).toHaveBeenCalledOnce();
  expect(backend.runSkill).not.toHaveBeenCalled();
});

it("does not overlap slow job polls", async () => {
  config.value.actingMode = true;
  let release!: (value: object) => void;
  backend.getJob.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const { startJob } = await import("./jobs");
  expect(await startJob(params)).toBe("job-1");
  await vi.advanceTimersByTimeAsync(2700);
  expect(backend.getJob).toHaveBeenCalledTimes(1);
  release({ id: "job-1", status: "running" });
  await Promise.resolve();
});
