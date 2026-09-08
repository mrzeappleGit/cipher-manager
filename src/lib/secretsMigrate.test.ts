import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  settings: { apiKeys: { anthropic: "fixture-value" }, asanaToken: "" } as Record<string, any>,
  ready: Promise.resolve(), flush: vi.fn(), setSecret: vi.fn(), presence: vi.fn(),
  vault: {} as Record<string, string>,
}));
vi.mock("../api", () => ({ isTauri: () => true, api: { setSecret: state.setSecret, secretPresence: state.presence } }));
vi.mock("./settings", () => ({
  getSettings: () => state.settings, get settingsReady() { return state.ready; }, flushSettings: state.flush,
  setApiKey: (provider: string, value: string) => { state.settings = { ...state.settings, apiKeys: { ...state.settings.apiKeys, [provider]: value } }; },
  setSettings: (patch: object) => { state.settings = { ...state.settings, ...patch }; },
}));
vi.mock("./secrets", () => ({ loadSecretPresence: async () => {}, providerKeyId: (p: string) => `${p}-api-key` }));
import { migrateProviderKeys } from "./secretsMigrate";
const marker = "cipher-manager.secrets-migrated.v3";
beforeEach(() => {
  localStorage.clear();
  state.settings = { apiKeys: { anthropic: "fixture-value" }, asanaToken: "" };
  state.ready = Promise.resolve();
  state.flush.mockReset().mockResolvedValue(undefined);
  state.vault = {};
  state.setSecret.mockReset().mockImplementation(async (id: string, value: string) => { state.vault[id] = value; });
  state.presence.mockReset().mockImplementation(async () => Object.fromEntries(Object.keys(state.vault).map((id) => [id, true])));
});

it("waits for hydration and retries lingering keys despite an old success marker", async () => {
  let release!: () => void;
  state.ready = new Promise<void>((resolve) => { release = resolve; });
  localStorage.setItem(marker, "1");
  const migration = migrateProviderKeys();
  await Promise.resolve();
  expect(state.setSecret).not.toHaveBeenCalled();
  release();
  await migration;
  expect(state.setSecret).toHaveBeenCalledWith("anthropic-api-key", "fixture-value");
  expect(state.settings.apiKeys.anthropic).toBe("");
  expect(state.flush).toHaveBeenCalled();
  expect(localStorage.getItem(marker)).toBe("1");
});

it("retains unverified keys and retries after a vault failure", async () => {
  state.presence.mockResolvedValueOnce({}).mockResolvedValueOnce({});
  await expect(migrateProviderKeys()).rejects.toThrow("could not be secured");
  expect(state.settings.apiKeys.anthropic).toBe("fixture-value");
  expect(localStorage.getItem(marker)).toBeNull();
  await migrateProviderKeys();
  expect(state.settings.apiKeys.anthropic).toBe("");
});

it("preserves existing provider and simple vault credentials while clearing stale legacy fields", async () => {
  state.settings.asanaToken = "stale-asana-fixture";
  state.vault = { "anthropic-api-key": "new-provider-fixture", "asana-token": "new-asana-fixture" };
  await migrateProviderKeys();
  expect(state.setSecret).not.toHaveBeenCalled();
  expect(state.vault).toEqual({ "anthropic-api-key": "new-provider-fixture", "asana-token": "new-asana-fixture" });
  expect(state.settings.apiKeys.anthropic).toBe("");
  expect(state.settings.asanaToken).toBe("");
});

it("does not restore stale plaintext over a rotated credential after a failed settings flush", async () => {
  state.flush.mockRejectedValueOnce(new Error("disk full"));
  await expect(migrateProviderKeys()).rejects.toThrow("disk full");
  // A restart reloads the unsanitized settings, after a credential rotation.
  state.settings.apiKeys.anthropic = "fixture-value";
  state.vault["anthropic-api-key"] = "rotated-fixture";
  await migrateProviderKeys();
  expect(state.vault["anthropic-api-key"]).toBe("rotated-fixture");
  expect(state.setSecret).toHaveBeenCalledTimes(1);
  expect(state.settings.apiKeys.anthropic).toBe("");
});

it("retains plaintext and does not overwrite the vault when presence verification fails", async () => {
  state.presence.mockRejectedValueOnce(new Error("vault unavailable"));
  await expect(migrateProviderKeys()).rejects.toThrow("could not be secured");
  expect(state.setSecret).not.toHaveBeenCalled();
  expect(state.settings.apiKeys.anthropic).toBe("fixture-value");
});

it("does not mark migration complete until sanitized settings are saved", async () => {
  localStorage.setItem(marker, "1");
  state.flush.mockRejectedValueOnce(new Error("disk full"));
  await expect(migrateProviderKeys()).rejects.toThrow("disk full");
  expect(localStorage.getItem(marker)).toBeNull();
  await migrateProviderKeys();
  expect(localStorage.getItem(marker)).toBe("1");
});
