// Inline answers for the command palette: arithmetic and unit conversion.
// The palette feeds this arbitrary typed text, so there is deliberately no
// eval anywhere — the tokenizer only admits numbers, operators and brackets,
// and anything it doesn't recognise returns null so the row simply hides.

export interface CalcResult {
  /** The answer, formatted for display (and for copying). */
  text: string;
  /** What was understood, echoed as the row's sub-label. */
  expr: string;
}

type Tok = { t: "num"; v: number } | { t: "op"; v: string };

const DIGIT = /[0-9]/;

function tokenize(s: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // Spaces and thousands separators carry no meaning.
    if (c === " " || c === "_" || c === ",") {
      i++;
      continue;
    }
    if (DIGIT.test(c) || c === ".") {
      // Separators are scanned as part of the number, so "1,920" stays one
      // token instead of splitting into two the parser can't join.
      let j = i;
      while (j < s.length && (DIGIT.test(s[j]) || ".,_".includes(s[j]))) j++;
      // Exponent form (1e6, 2.5e-3) — only when digits actually follow.
      if (s[j] === "e" || s[j] === "E") {
        let k = j + 1;
        if (s[k] === "+" || s[k] === "-") k++;
        if (k < s.length && DIGIT.test(s[k])) {
          while (k < s.length && DIGIT.test(s[k])) k++;
          j = k;
        }
      }
      const v = Number(s.slice(i, j).replace(/[,_]/g, ""));
      if (!Number.isFinite(v)) return null;
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if ("+-*/%^()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    return null; // a letter or symbol: not arithmetic, leave it alone
  }
  return out.length ? out : null;
}

/**
 * expr  := term (('+'|'-') term)*
 * term  := unary (('*'|'/'|'%') unary)*
 * unary := ('-'|'+') unary | power
 * power := atom ('^' unary)?          // right-associative
 * atom  := number | '(' expr ')'
 */
function parse(toks: Tok[]): number | null {
  let p = 0;

  function eat(v: string): boolean {
    const t = toks[p];
    if (t && t.t === "op" && t.v === v) {
      p++;
      return true;
    }
    return false;
  }

  function atom(): number | null {
    const t = toks[p];
    if (!t) return null;
    if (t.t === "num") {
      p++;
      return t.v;
    }
    if (t.v !== "(") return null;
    p++;
    const v = expr();
    return v !== null && eat(")") ? v : null;
  }

  function power(): number | null {
    const base = atom();
    if (base === null) return null;
    if (!eat("^")) return base;
    const e = unary();
    return e === null ? null : base ** e;
  }

  function unary(): number | null {
    if (eat("-")) {
      const v = unary();
      return v === null ? null : -v;
    }
    if (eat("+")) return unary();
    return power();
  }

  function term(): number | null {
    let a = unary();
    if (a === null) return null;
    for (;;) {
      const op = eat("*") ? "*" : eat("/") ? "/" : eat("%") ? "%" : "";
      if (!op) return a;
      const b = unary();
      if (b === null) return null;
      a = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
  }

  function expr(): number | null {
    let a = term();
    if (a === null) return null;
    for (;;) {
      const op = eat("+") ? "+" : eat("-") ? "-" : "";
      if (!op) return a;
      const b = term();
      if (b === null) return null;
      a = op === "+" ? a + b : a - b;
    }
  }

  const v = expr();
  return v !== null && p === toks.length && Number.isFinite(v) ? v : null;
}

/** Trim float noise: 6dp max, no trailing zeros, exponent form at the extremes. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return n.toExponential(4);
  return n
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

type Dim = "len" | "mass" | "data" | "time";

/** factor = how many base units one of these is. Bases: m, g, byte, second. */
const UNITS: Record<string, { d: Dim; f: number }> = {};

function unit(d: Dim, f: number, ...names: string[]) {
  for (const n of names) UNITS[n] = { d, f };
}

unit("len", 1e-9, "nm");
unit("len", 1e-6, "um", "µm");
unit("len", 0.001, "mm");
unit("len", 0.01, "cm");
unit("len", 1, "m", "metre", "metres", "meter", "meters");
unit("len", 1000, "km");
unit("len", 0.0254, "in", "inch", "inches");
unit("len", 0.3048, "ft", "foot", "feet");
unit("len", 0.9144, "yd", "yard", "yards");
unit("len", 1609.344, "mi", "mile", "miles");

unit("mass", 0.001, "mg");
unit("mass", 1, "g", "gram", "grams");
unit("mass", 1000, "kg");
unit("mass", 1e6, "t", "tonne", "tonnes");
unit("mass", 28.349523125, "oz", "ounce", "ounces");
unit("mass", 453.59237, "lb", "lbs", "pound", "pounds");
unit("mass", 6350.29318, "st", "stone");

// Binary throughout: in a dev tool "500 MB" means 500 × 1024².
unit("data", 1 / 8, "bit", "bits");
unit("data", 1, "b", "byte", "bytes");
unit("data", 1024, "kb", "kib");
unit("data", 1024 ** 2, "mb", "mib");
unit("data", 1024 ** 3, "gb", "gib");
unit("data", 1024 ** 4, "tb", "tib");

unit("time", 0.001, "ms");
unit("time", 1, "s", "sec", "secs", "second", "seconds");
unit("time", 60, "min", "mins", "minute", "minutes");
unit("time", 3600, "h", "hr", "hrs", "hour", "hours");
unit("time", 86400, "d", "day", "days");
unit("time", 604800, "week", "weeks");
unit("time", 31557600, "year", "years"); // Julian year (365.25d)

const TEMP: Record<string, "c" | "f" | "k"> = {
  c: "c", "°c": "c", celsius: "c", centigrade: "c",
  f: "f", "°f": "f", fahrenheit: "f",
  k: "k", kelvin: "k",
};

function toCelsius(v: number, from: "c" | "f" | "k"): number {
  return from === "c" ? v : from === "f" ? (v - 32) / 1.8 : v - 273.15;
}

function fromCelsius(v: number, to: "c" | "f" | "k"): number {
  return to === "c" ? v : to === "f" ? v * 1.8 + 32 : v + 273.15;
}

/** Greedy left side, so the *last* "in"/"to" splits — "5 m in in" works. */
const CONVERSION = /^(.*\S)\s+(?:in|to|as)\s+([a-zA-Zµ°]+)\s*$/i;
/** An expression followed by a unit, with or without a space between them. */
const VALUE_UNIT = /^(.+?)\s*([a-zA-Zµ°]+)$/;

function evaluate(src: string): number | null {
  const toks = tokenize(src);
  return toks ? parse(toks) : null;
}

function convert(left: string, toRaw: string): CalcResult | null {
  const m = VALUE_UNIT.exec(left.trim());
  if (!m) return null;
  const value = evaluate(m[1]);
  if (value === null) return null;
  const from = m[2].toLowerCase();
  const to = toRaw.toLowerCase();

  if (TEMP[from] && TEMP[to]) {
    const out = fromCelsius(toCelsius(value, TEMP[from]), TEMP[to]);
    return { text: `${fmt(out)} °${to.replace("°", "").toUpperCase()}`, expr: `${left.trim()} → ${toRaw}` };
  }
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b || a.d !== b.d) return null;
  return {
    text: `${fmt((value * a.f) / b.f)} ${toRaw}`,
    expr: `${left.trim()} → ${toRaw}`,
  };
}

/**
 * An inline answer for `input`, or null when it isn't a sum or a conversion.
 * Plain arithmetic needs both a digit and an operator, so ordinary searches
 * ("cipher-manager", "deck") never sprout a bogus answer row.
 */
export function calc(input: string): CalcResult | null {
  const raw = input.trim();
  if (!raw) return null;

  const conv = CONVERSION.exec(raw);
  if (conv) return convert(conv[1], conv[2]);

  if (!/[+\-*/%^]/.test(raw) || !/\d/.test(raw)) return null;
  const v = evaluate(raw);
  return v === null ? null : { text: fmt(v), expr: raw };
}
