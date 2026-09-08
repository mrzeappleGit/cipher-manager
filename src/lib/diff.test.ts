import { describe, expect, it } from "vitest";
import { lineDiff } from "./diff";

describe("lineDiff", () => {
  it("marks added, removed, and unchanged lines", () => {
    const a = "one\ntwo\nthree";
    const b = "one\ntwo changed\nthree\nfour";
    const d = lineDiff(a, b);
    expect(d).toEqual([
      { t: "same", line: "one" },
      { t: "del", line: "two" },
      { t: "add", line: "two changed" },
      { t: "same", line: "three" },
      { t: "add", line: "four" },
    ]);
  });

  it("handles empty sides", () => {
    expect(lineDiff("", "a")).toEqual([{ t: "add", line: "a" }]);
    expect(lineDiff("a", "")).toEqual([{ t: "del", line: "a" }]);
  });
});
