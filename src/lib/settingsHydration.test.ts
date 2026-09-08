import { beforeEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ loadAppState: vi.fn(), saveAppState: vi.fn() }));
const showError = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: backend }));
vi.mock("./toast", () => ({ notify: { error: showError } }));
beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  backend.loadAppState.mockReset().mockResolvedValue(null);
  backend.saveAppState.mockReset().mockResolvedValue(undefined);
  showError.mockClear();
});

it.each(["broken JSON", "null", "[]", '{"actingMode":"true"}', "unreadable"])("fails Acting mode closed for %s on disk", async (raw) => {
  localStorage.setItem("cipher-manager.settings", JSON.stringify({ actingMode: true, deckName: "Local name" }));
  if (raw === "unreadable") backend.loadAppState.mockRejectedValue(new Error("access denied"));
  else backend.loadAppState.mockResolvedValue(raw);
  const settings = await import("./settings");
  await settings.settingsReady;
  expect(settings.getSettings().actingMode).toBe(false);
  expect(settings.getSettings().deckName).toBe("Local name");
  expect(showError).toHaveBeenCalled();
  await settings.flushSettings();
  const calls = backend.saveAppState.mock.calls;
  expect(JSON.parse(calls[calls.length - 1][1]).actingMode).toBe(false);
});

it("validates disk permissions even when an early local edit is pending", async () => {
  let resolve!: (raw: string) => void;
  backend.loadAppState.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
  const settings = await import("./settings");
  settings.setSettings({ actingMode: true, deckName: "Early edit" });
  resolve("broken JSON");
  await settings.settingsReady;
  expect(settings.getSettings().actingMode).toBe(false);
  expect(settings.getSettings().deckName).toBe("Early edit");
});

it.each(["local", "disk"])("normalizes a legacy provider key from %s without retaining the old field", async (source) => {
  const raw = JSON.stringify({ anthropicApiKey: "fixture-value", scribeEndpoint: "https://scribe.example.com" });
  if (source === "local") localStorage.setItem("cipher-manager.settings", raw);
  else backend.loadAppState.mockResolvedValue(raw);
  const settings = await import("./settings");
  await settings.settingsReady;
  expect(settings.getSettings().apiKeys.anthropic).toBe("fixture-value");
  expect(settings.getSettings()).not.toHaveProperty("anthropicApiKey");
  expect(settings.getSettings().scribeEndpoint).toBe("https://scribe.example.com");
  await settings.flushSettings();
  const calls = backend.saveAppState.mock.calls;
  expect(JSON.parse(calls[calls.length - 1][1])).not.toHaveProperty("anthropicApiKey");
});
