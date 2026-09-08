import { describe, expect, it } from "vitest";
import { getSettings, setSettings, toggleScribeDisabledApp } from "./settings";

describe("scribe settings", () => {
  it("defaults the live loop and hotkeys to off", () => {
    // Opt-in: this installs a keyboard hook and claims two global shortcuts.
    expect(getSettings().scribeNib).toBe(false);
    expect(getSettings().scribeHotkeys).toBe(false);
    expect(getSettings().scribeEndpoint).toBe("");
  });

  it("defaults the rewrite style to formal", () => {
    expect(getSettings().scribeRewriteStyle).toBe("formal");
  });

  it("round-trips the per-app kill list", () => {
    setSettings({ scribeDisabledApps: ["notepad.exe"] });
    expect(getSettings().scribeDisabledApps).toEqual(["notepad.exe"]);
  });

  it("toggleScribeDisabledApp adds then removes an exe", () => {
    setSettings({ scribeDisabledApps: [] });
    toggleScribeDisabledApp("code.exe");
    expect(getSettings().scribeDisabledApps).toEqual(["code.exe"]);
    toggleScribeDisabledApp("code.exe");
    expect(getSettings().scribeDisabledApps).toEqual([]);
  });

  it("toggleScribeDisabledApp removes an existing entry case-insensitively", () => {
    setSettings({ scribeDisabledApps: ["code.exe"] });
    toggleScribeDisabledApp("CODE.EXE");
    expect(getSettings().scribeDisabledApps).toEqual([]);
  });
});

describe("publishing settings", () => {
  it("requires an explicit destination and opt-in", () => {
    expect(getSettings().sshHost).toBe("");
    expect(getSettings().scheduleRemotePath).toBe("");
    expect(getSettings().snapshotRemotePath).toBe("");
    expect(getSettings().cloudSyncEnabled).toBe(false);
  });

  it("retains explicit publishing and Scribe configuration", () => {
    const configured = {
      sshHost: "user@publish.example.com",
      scheduleRemotePath: "/srv/site/schedule.json",
      snapshotRemotePath: "/srv/private/index.html",
      scribeEndpoint: "https://scribe.example.com",
    };
    setSettings(configured);
    expect(getSettings()).toMatchObject(configured);
    setSettings({ sshHost: "", scheduleRemotePath: "", snapshotRemotePath: "", scribeEndpoint: "" });
  });
});
