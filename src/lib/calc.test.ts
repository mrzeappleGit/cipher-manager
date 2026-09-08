import { describe, expect, it } from "vitest";
import { calc, fmt } from "./calc";

const text = (s: string) => calc(s)?.text ?? null;

describe("arithmetic", () => {
  it("applies precedence and associativity", () => {
    expect(text("2+3*4")).toBe("14");
    expect(text("(2+3)*4")).toBe("20");
    expect(text("10-2-3")).toBe("5"); // left-assoc, not 11
    expect(text("100/5/2")).toBe("10");
    expect(text("2^3^2")).toBe("512"); // right-assoc, not 64
    expect(text("-2^2")).toBe("-4");
    expect(text("2^-1")).toBe("0.5");
    expect(text("10%3")).toBe("1");
  });

  it("handles the number forms people actually type", () => {
    expect(text("1,920 * 0.6")).toBe("1152");
    expect(text("1_000+1")).toBe("1001");
    expect(text("2.5e3+1")).toBe("2501");
    expect(text(".5*4")).toBe("2");
  });

  it("stays silent on anything that isn't a sum", () => {
    // Ordinary palette searches must not sprout an answer row.
    expect(calc("cipher-manager")).toBeNull();
    expect(calc("deck")).toBeNull();
    expect(calc("gpt-4o")).toBeNull();
    expect(calc("42")).toBeNull(); // a bare number is not an answer
    expect(calc("")).toBeNull();
    expect(calc("  ")).toBeNull();
  });

  it("rejects malformed expressions instead of guessing", () => {
    expect(calc("2+")).toBeNull();
    expect(calc("(2+3")).toBeNull();
    expect(calc("2+3)")).toBeNull();
    expect(calc("2 3 +")).toBeNull();
    expect(calc("1/0")).toBeNull(); // Infinity is not a useful answer
  });
});

describe("unit conversion", () => {
  it("converts within a dimension", () => {
    expect(text("5 km in mi")).toBe("3.106856 mi");
    expect(text("12 inches to cm")).toBe("30.48 cm");
    expect(text("1 GB in MB")).toBe("1024 MB");
    expect(text("90 min in h")).toBe("1.5 h");
    expect(text("1 lb in g")).toBe("453.59237 g");
    expect(text("2kg in lb")).toBe("4.409245 lb"); // no space needed
  });

  it("converts temperature through its offsets", () => {
    expect(text("100 c in f")).toBe("212 °F");
    expect(text("32 f to c")).toBe("0 °C");
    expect(text("0 c in k")).toBe("273.15 °K");
  });

  it("splits on the last separator so 'in' works as a unit", () => {
    expect(text("5 m in in")).toBe("196.850394 in");
  });

  it("evaluates the left-hand side first", () => {
    expect(text("2*3 km in m")).toBe("6000 m");
  });

  it("refuses mismatched or unknown units", () => {
    expect(calc("5 km in kg")).toBeNull();
    expect(calc("5 bananas in kg")).toBeNull();
    expect(calc("5 km in")).toBeNull();
    // "X in Y" phrasing that isn't a conversion must not produce an answer.
    expect(calc("meeting in london")).toBeNull();
  });
});

describe("formatting", () => {
  it("trims float noise without eating real digits", () => {
    expect(fmt(1152)).toBe("1152");
    expect(fmt(100)).toBe("100"); // not "1"
    expect(fmt(0.5)).toBe("0.5");
    expect(fmt(1 / 3)).toBe("0.333333");
    expect(fmt(0.1 + 0.2)).toBe("0.3");
    expect(fmt(1e20)).toBe("1.0000e+20");
  });
});
