import { describe, expect, it } from "vitest";
import { disableAppInSettings, isUnambiguous, REWRITE_STYLES } from "./scribe";
import { getSettings, setSettings } from "./settings";
import type { Issue } from "../types";

const issue = (kind: Issue["kind"], replacements: string[]): Issue => ({
  offset: 0,
  length: 1,
  message: "",
  replacements,
  kind,
});

describe("isUnambiguous", () => {
  it("a spelling issue with replacements is unambiguous", () => {
    expect(isUnambiguous(issue("spelling", ["teh"]))).toBe(true);
  });

  it("a style issue with replacements is not unambiguous", () => {
    expect(isUnambiguous(issue("style", ["concise"]))).toBe(false);
  });

  it("a grammar issue with no replacements is not unambiguous", () => {
    expect(isUnambiguous(issue("grammar", []))).toBe(false);
  });

  // Rust's rule is a blacklist (kind != "style"), and the likeliest drift is a
  // whitelist (kind === "spelling"), which every case above still passes.
  it("a grammar issue with replacements is unambiguous", () => {
    expect(isUnambiguous(issue("grammar", ["their"]))).toBe(true);
  });
});

describe("REWRITE_STYLES", () => {
  // Rust has its own copy in scribe/mod.rs and REJECTS anything outside it, so
  // a value added on one side only makes the panel's chip fail at the command
  // boundary. Keep this list in lockstep with that one.
  it("matches the wire values Rust accepts", () => {
    expect(REWRITE_STYLES.map((s) => s.value)).toEqual([
      "formal",
      "casual",
      "concise",
      "expand",
      "leet",
      "prompt",
    ]);
  });

  // Dropped by the fold-in and put back: the standalone app and the extension
  // both shipped it, and the proxy answers to it.
  it("offers the prompt-improver the standalone app had", () => {
    expect(REWRITE_STYLES.find((s) => s.value === "prompt")?.label).toBe("Improve prompt");
  });

  it("never sends a display label as a wire value", () => {
    // "L33t" is the label; "leet" is what the endpoint takes.
    for (const s of REWRITE_STYLES) expect(s.value).toBe(s.value.toLowerCase());
    expect(REWRITE_STYLES.find((s) => s.label === "L33t")?.value).toBe("leet");
  });
});

describe("disableAppInSettings", () => {
  it("appends a new exe to the disabled list", () => {
    setSettings({ scribeDisabledApps: [] });
    disableAppInSettings("notepad.exe");
    expect(getSettings().scribeDisabledApps).toEqual(["notepad.exe"]);
  });

  it("does not duplicate an exe already on the list", () => {
    setSettings({ scribeDisabledApps: ["notepad.exe"] });
    disableAppInSettings("notepad.exe");
    expect(getSettings().scribeDisabledApps).toEqual(["notepad.exe"]);
  });
});
