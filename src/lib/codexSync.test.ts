import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sync: vi.fn(async () => ({})), settings: { ccxStateUrl: "" } }));
vi.mock("../api", () => ({ isTauri: () => true, api: { codexSync: mocks.sync } }));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));
import { codexAutoSync } from "./codexSync";

it("keeps sync off without an endpoint and forwards only the configured URL", async () => {
  localStorage.clear();
  await codexAutoSync("C:\\vault");
  expect(mocks.sync).not.toHaveBeenCalled();
  mocks.settings.ccxStateUrl = "https://sync.example.com/ccx/state/";
  await codexAutoSync("C:\\vault");
  expect(mocks.sync).toHaveBeenCalledWith("C:\\vault\\output\\codex", mocks.settings.ccxStateUrl);
  await codexAutoSync("C:\\vault");
  expect(mocks.sync).toHaveBeenCalledOnce();
});
