import { beforeEach, expect, it, vi } from "vitest";
const launch = vi.hoisted(() => vi.fn());
vi.mock("./jobs", () => ({ startJob: launch }));
vi.mock("../api", () => ({ api: { loadAppState: async () => null, saveAppState: async () => {} } }));
beforeEach(() => { vi.resetModules(); localStorage.clear(); launch.mockReset(); });

it("marks a run only after launch acceptance and deduplicates concurrent launches", async () => {
  const store = await import("./automations");
  await store.automationsReady;
  store.addAutomation({ name: "Test", prompt: "Test", time: "09:00", enabled: true });
  const id = store.getAutomations()[0].id;
  launch.mockResolvedValueOnce(null);
  expect(await store.runAutomation(id)).toBeNull();
  expect(store.getAutomations()[0].lastRun).toBeNull();
  let accept!: (value: string) => void;
  launch.mockReturnValueOnce(new Promise<string>((resolve) => { accept = resolve; }));
  const pending = store.runAutomation(id);
  await Promise.resolve();
  expect(await store.runAutomation(id)).toBeNull();
  expect(store.getAutomations()[0].lastRun).toBeNull();
  accept("job-1");
  expect(await pending).toBe("job-1");
  expect(store.getAutomations()[0].lastRun).toBe(new Date().toDateString());
  expect(launch).toHaveBeenCalledTimes(2);
});

it("assigns different IDs to a batch created in the same millisecond", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(12345);
  try {
    const store = await import("./automations");
    await store.automationsReady;
    for (const name of ["First", "Second", "Third"]) {
      store.addAutomation({ name, prompt: name, time: "09:00", enabled: false });
    }
    const ids = store.getAutomations().map((a) => a.id);
    expect(new Set(ids).size).toBe(3);
    store.toggleAutomation(ids[1]);
    expect(store.getAutomations().map((a) => a.enabled)).toEqual([false, true, false]);
  } finally { now.mockRestore(); }
});

it.each(["disabled", "already run", "removed"])("rechecks %s automations after a pending launch preparation", async (change) => {
  const store = await import("./automations");
  await store.automationsReady;
  store.addAutomation({ name: "Due", prompt: "Test", time: "00:00", enabled: true });
  const id = store.getAutomations()[0].id;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => { release = resolve; });
  launch.mockImplementation(async (params) => { await preparing; return params.canLaunch() ? "job-1" : null; });
  const pending = store.runAutomation(id, { scheduled: true });
  await Promise.resolve();
  if (change === "disabled") store.toggleAutomation(id);
  else if (change === "already run") store.markRan(id, new Date().toDateString());
  else store.removeAutomation(id);
  release();
  expect(await pending).toBeNull();
});

it("keeps Run now available for disabled/already-run automations but skips them on the timer", async () => {
  const store = await import("./automations");
  await store.automationsReady;
  store.addAutomation({ name: "Manual", prompt: "Test", time: "00:00", enabled: false });
  const id = store.getAutomations()[0].id;
  store.markRan(id, new Date().toDateString());
  launch.mockImplementation(async (params) => params.canLaunch() ? "manual-job" : null);
  expect(await store.runAutomation(id, { scheduled: true })).toBeNull();
  expect(launch).not.toHaveBeenCalled();
  expect(await store.runAutomation(id)).toBe("manual-job");
});

it("checks scheduled ownership, days and valid times", async () => {
  const { automationDue } = await import("./automations");
  const now = new Date(2026, 8, 8, 9, 30);
  const a = { id: "fixture", name: "Fixture", prompt: "Test", enabled: true, time: "09:30", lastRun: null };
  expect(automationDue(a, now)).toBe(true);
  for (const patch of [{ system: true }, { days: [(now.getDay() + 1) % 7] }, { time: "09:31" }, { time: "99:99" }, { time: "09:NaN" }]) {
    expect(automationDue({ ...a, ...patch }, now)).toBe(false);
  }
});
