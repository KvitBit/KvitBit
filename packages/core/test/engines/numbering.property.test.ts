/**
 * Numbering patterns against an independent grammar oracle (skill `verify-vat-numbering-math`).
 *
 * - "verification": every pattern string up to 6 characters over a 7-letter alphabet.
 * - "property": seeded generated patterns, dates and counters. Sampled, so it is not a proof.
 *   A failure prints the seed.
 */

import { describe, expect, test } from "bun:test";
import { IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Formatter from "effect/Formatter";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as EffectString from "effect/String";
import {
  checkNextCounter,
  fitsLength,
  format,
  MAX_COUNTER,
  MAX_NUMBER_LENGTH,
  type NumberPattern,
  type PatternToken,
  parsePattern,
  periodKey,
} from "../../src/engines/numbering";
import { rng } from "./random";

/** The spec's limits (core-ports 5.2 / the numbering.ts header), pinned apart from the engine. */
const SPEC_MAX_LENGTH = 20;
/** Postgres integer counters store `sequence + 1`: the largest allocatable counter is 2^31 - 2. */
const SPEC_MAX_COUNTER = 2 ** 31 - 2;

// Oracle: a character-by-character scanner, written apart from the engine's regex split. ------

type OracleResult =
  | { readonly ok: true; readonly tokens: ReadonlyArray<PatternToken>; readonly reset: string }
  | { readonly ok: false; readonly reason: string };

const isLetter = (ch: string) => (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
const isControl = (ch: string) =>
  Option.getOrElse(EffectString.charCodeAt(ch, 0), () => Number.NaN) < 0x20 ||
  Option.getOrElse(EffectString.charCodeAt(ch, 0), () => Number.NaN) === 0x7f;
const WHITESPACE = /\s/;
const isSpace = (ch: string) => WHITESPACE.test(ch);

const oracleParse = (p: string): OracleResult => {
  if (p.length === 0) return { ok: false, reason: "empty" };
  for (const ch of p) if (isControl(ch)) return { ok: false, reason: "control_character" };
  if (
    isSpace(Option.getOrElse(EffectString.charAt(p, 0), () => "")) ||
    isSpace(Option.getOrElse(EffectString.charAt(p, p.length - 1), () => ""))
  ) {
    return { ok: false, reason: "whitespace_edge" };
  }
  const tokens: Array<PatternToken> = [];
  const literal = (text: string) => {
    const last = tokens.at(-1);
    if (last?._tag === "Literal")
      tokens[tokens.length - 1] = { _tag: "Literal", text: last.text + text };
    else tokens.push({ _tag: "Literal", text });
  };
  let i = 0;
  while (i < p.length) {
    if (!isLetter(Option.getOrElse(EffectString.charAt(p, i), () => ""))) {
      literal(Option.getOrElse(EffectString.charAt(p, i), () => ""));
      i++;
      continue;
    }
    let j = i;
    while (j < p.length && isLetter(Option.getOrElse(EffectString.charAt(p, j), () => ""))) j++;
    const word = EffectString.slice(i, j)(p);
    if (EffectArray.some(Array.from(word), (c) => c !== "Y" && c !== "M" && c !== "N")) {
      literal(word);
    } else {
      let k = 0;
      while (k < word.length) {
        let run = 1;
        while (
          Option.getOrElse(EffectString.charAt(word, k + run), () => "") ===
          Option.getOrElse(EffectString.charAt(word, k), () => "")
        )
          run++;
        const c = Option.getOrElse(EffectString.charAt(word, k), () => "");
        if (c === "N") tokens.push({ _tag: "Counter", width: run });
        else if (c === "M") {
          if (run !== 2) return { ok: false, reason: "month_run" };
          tokens.push({ _tag: "Month" });
        } else if (run === 2 || run === 4) tokens.push({ _tag: run === 4 ? "Year4" : "Year2" });
        else return { ok: false, reason: "year_run" };
        k += run;
      }
    }
    i = j;
  }
  const counters = EffectArray.filter(tokens, (t) => t._tag === "Counter").length;
  if (counters === 0) return { ok: false, reason: "counter_missing" };
  if (counters > 1) return { ok: false, reason: "counter_repeated" };
  const year = EffectArray.some(tokens, (t) => t._tag === "Year2" || t._tag === "Year4");
  const month = EffectArray.some(tokens, (t) => t._tag === "Month");
  if (month && !year) return { ok: false, reason: "month_without_year" };
  if (oracleRender(tokens, 2026, 1, 1).length > SPEC_MAX_LENGTH)
    return { ok: false, reason: "too_long" };
  return { ok: true, tokens, reset: month ? "monthly" : year ? "yearly" : "never" };
};

/** The number as the grammar defines it; a counter is at least its run's width. */
const oracleRender = (
  tokens: ReadonlyArray<PatternToken>,
  year: number,
  month: number,
  counter: number,
): string => {
  const pad = (n: number, w: number) => {
    let s = String(n);
    while (s.length < w) s = `0${s}`;
    return s;
  };
  let out = "";
  for (const t of tokens) {
    if (t._tag === "Year4") out += pad(year, 4);
    else if (t._tag === "Year2") out += pad(year % 100, 2);
    else if (t._tag === "Month") out += pad(month, 2);
    else if (t._tag === "Counter") out += pad(counter, t.width);
    else out += t.text;
  }
  return out;
};

/**
 * Reads a number back: tokens before the counter sit at fixed offsets from the start, those
 * after it at fixed offsets from the end, so the counter is what is left in between.
 */
const decode = (tokens: ReadonlyArray<PatternToken>, number: string) => {
  const width = (t: PatternToken) =>
    t._tag === "Year4" ? 4 : t._tag === "Literal" ? t.text.length : t._tag === "Counter" ? 0 : 2;
  const at = Option.getOrElse(
    EffectArray.findFirstIndex(tokens, (t) => t._tag === "Counter"),
    () => -1,
  );
  const prefix = EffectArray.reduce(tokens.slice(0, at), 0, (n, t) => n + width(t));
  const suffix = EffectArray.reduce(tokens.slice(at + 1), 0, (n, t) => n + width(t));
  const fields: Array<string> = [];
  let pos = 0;
  for (const t of tokens.slice(0, at)) {
    if (t._tag !== "Literal") fields.push(EffectString.slice(pos, pos + width(t))(number));
    pos += width(t);
  }
  pos = number.length - suffix;
  for (const t of tokens.slice(at + 1)) {
    if (t._tag !== "Literal") fields.push(EffectString.slice(pos, pos + width(t))(number));
    pos += width(t);
  }
  return { counter: Number(EffectString.slice(prefix, number.length - suffix)(number)), fields };
};

const iso = (y: number, m: number, d: number) =>
  IsoDate.make(
    `${EffectString.padStart(4, "0")(String(y))}-${EffectString.padStart(2, "0")(String(m))}-${EffectString.padStart(2, "0")(String(d))}`,
  );

const forSeeds = (count: number, base: number, body: (seed: number) => void) => {
  for (let i = 0; i < count; i++) {
    const seed = base + i * 7919;
    try {
      body(seed);
    } catch (e) {
      throw new Error(`seed=${seed}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  return count;
};

const engineParse = (p: string): OracleResult => {
  const r = parsePattern(p);
  if (Result.isSuccess(r)) return { ok: true, tokens: r.success.tokens, reset: r.success.reset };
  const issue = r.failure.issues[0];
  return { ok: false, reason: String(issue?.params?.reason) };
};

const PIECES = [
  "YYYY",
  "YY",
  "MM",
  "N",
  "NN",
  "NNN",
  "NNNN",
  "NNNNNN",
  "Y",
  "YYY",
  "M",
  "MMM",
  "YYMMNNN",
  "INV",
  "FA",
  "MONTH",
  "yy",
  "nn",
  "-",
  "/",
  "_",
  ".",
  " ",
  "0",
  "26",
  "Ý",
  "\t",
  "\u007f",
];
const genPattern = (r: ReturnType<typeof rng>) =>
  EffectArray.join(
    Array.from({ length: r.int(1, 6) }, () => r.pick(PIECES)),
    "",
  );
/**
 * A pattern the oracle accepts (bounded retries, never judged by the engine), then parsed by the
 * engine: an engine rejection fails at once with the pattern.
 */
const genValid = (r: ReturnType<typeof rng>): { source: string; pattern: NumberPattern } => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const source = genPattern(r);
    if (!oracleParse(source).ok) continue;
    const parsed = parsePattern(source);
    if (Result.isFailure(parsed)) {
      throw new Error(
        `engine rejects ${Formatter.format(source)}: ${Formatter.format(engineParse(source))}`,
      );
    }
    return { source, pattern: parsed.success };
  }
  throw new Error("generator: no valid pattern in 500 attempts");
};
const genDate = (r: ReturnType<typeof rng>) => ({
  y: r.int(1900, 2199),
  m: r.int(1, 12),
  d: r.int(1, 28),
});
const genCounter = (r: ReturnType<typeof rng>) =>
  r.pick([
    () => r.int(1, 9),
    () => r.int(1, 99_999),
    () => r.int(1, SPEC_MAX_COUNTER),
    () => SPEC_MAX_COUNTER,
  ])();

// 3a. Exhaustive grammar ----------------------------------------------------------------------

describe("Numbering grammar (verification: every pattern up to 6 chars over Y M N a 1 - space)", () => {
  test("parsePattern equals the oracle (tokens, reset or reason); format equals the oracle render", () => {
    const alphabet = ["Y", "M", "N", "a", "1", "-", " "];
    let checked = 0;
    let valid = 0;
    const date = IsoDate.make("2026-03-15");
    const visit = (p: string) => {
      const got = engineParse(p);
      const want = oracleParse(p);
      if (!Bun.deepEquals(got, want)) {
        throw new Error(
          `${Formatter.format(p)}: engine ${Formatter.format(got)}, oracle ${Formatter.format(want)}`,
        );
      }
      if (got.ok) {
        const pattern = Result.getOrThrow(parsePattern(p));
        for (const c of [1, 10, 12_345]) {
          const n = format(pattern, date, c);
          if (n !== oracleRender(got.tokens, 2026, 3, c))
            throw new Error(`format(${p}, ${c}) = ${n}`);
        }
        valid++;
      }
      checked++;
    };
    const walk = (prefix: string) => {
      visit(prefix);
      if (prefix.length < 6) for (const ch of alphabet) walk(prefix + ch);
    };
    walk("");
    expect(checked).toBe((7 ** 7 - 1) / 6);
    expect(valid).toBeGreaterThan(1000);
  }, 60_000);
});

// 3b. Generated patterns, dates and counters ----------------------------------------------

describe("Numbering patterns (property: seeded)", () => {
  test("generated patterns parse like the oracle, including rejections (2,000 patterns)", () => {
    const checked = forSeeds(2000, 0x4e4e, (seed) => {
      const p = genPattern(rng(seed));
      const got = engineParse(p);
      const want = oracleParse(p);
      if (Formatter.format(got) !== Formatter.format(want)) {
        throw new Error(
          `${Formatter.format(p)}: engine ${Formatter.format(got)}, oracle ${Formatter.format(want)}`,
        );
      }
    });
    expect(checked).toBe(2_000);
  });

  test("format round-trips: the counter and date fields read back; never truncated; limits (500 x 20)", () => {
    forSeeds(500, 0x5f5f, (seed) => {
      const r = rng(seed);
      const { source, pattern } = genValid(r);
      expect([source, oracleRender(pattern.tokens, 2026, 1, 1).length <= SPEC_MAX_LENGTH]).toEqual([
        source,
        true,
      ]);
      for (let k = 0; k < 20; k++) {
        const { y, m, d } = genDate(r);
        const c = genCounter(r);
        const n = format(pattern, iso(y, m, d), c);
        if (n !== oracleRender(pattern.tokens, y, m, c))
          throw new Error(`${source} ${y}-${m} ${c}: ${n}`);
        const back = decode(pattern.tokens, n);
        if (back.counter !== c)
          throw new Error(`${source}: ${n} reads back counter ${back.counter}, not ${c}`);
        const fields = EffectArray.flatMap(pattern.tokens, (t) =>
          t._tag === "Year4"
            ? [EffectString.padStart(4, "0")(String(y))]
            : t._tag === "Year2"
              ? [EffectString.padStart(2, "0")(String(y % 100))]
              : t._tag === "Month"
                ? [EffectString.padStart(2, "0")(String(m))]
                : [],
        );
        if (EffectArray.join(back.fields, "|") !== EffectArray.join(fields, "|"))
          throw new Error(`${source}: ${n} reads back date fields ${back.fields}, not ${fields}`);
        if (fitsLength(pattern, iso(y, m, d), c) !== n.length <= SPEC_MAX_LENGTH) {
          throw new Error(`${source}: fitsLength(${c}) disagrees with length ${n.length}`);
        }
      }
      for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => format(pattern, IsoDate.make("2026-01-01"), bad)).toThrow();
      }
    });
  });

  test("periodKey: same key => same number for the same counter; distinct counters => distinct numbers (500 x 30)", () => {
    forSeeds(500, 0x6a6a, (seed) => {
      const r = rng(seed);
      const { source, pattern } = genValid(r);
      for (let k = 0; k < 30; k++) {
        const a = genDate(r);
        // A second date in the same period: same year (yearly), same month too (monthly).
        const b = {
          y: pattern.reset === "never" ? r.int(1900, 2199) : a.y,
          m:
            pattern.reset === "monthly"
              ? a.m
              : pattern.reset === "never"
                ? r.int(1, 12)
                : r.int(1, 12),
          d: r.int(1, 28),
        };
        const da = iso(a.y, a.m, a.d);
        const db = iso(b.y, b.m, b.d);
        const key =
          pattern.reset === "never"
            ? "all"
            : pattern.reset === "yearly"
              ? EffectString.padStart(4, "0")(String(a.y))
              : `${EffectString.padStart(4, "0")(String(a.y))}-${EffectString.padStart(2, "0")(String(a.m))}`;
        expect([source, periodKey(pattern, da)]).toEqual([source, key]);
        expect([source, periodKey(pattern, db)]).toEqual([source, key]);
        const c1 = genCounter(r);
        const c2 = r.next() < 0.3 ? c1 : genCounter(r);
        const n1 = format(pattern, da, c1);
        const n2 = format(pattern, db, c2);
        if ((n1 === n2) !== (c1 === c2))
          throw new Error(`${source} ${key}: ${c1}->${n1}, ${c2}->${n2}`);
      }
    });
  });

  test("across periods numbers collide only for YY-only patterns 100 years apart (500 x 30)", () => {
    const checked = forSeeds(500, 0x7b7b, (seed) => {
      const r = rng(seed);
      const { source, pattern } = genValid(r);
      const year4 = EffectArray.some(pattern.tokens, (t) => t._tag === "Year4");
      for (let k = 0; k < 30; k++) {
        const a = genDate(r);
        // Bias toward the colliding case: same month, 100 years apart.
        const b =
          r.next() < 0.4 ? { y: a.y + (a.y < 2100 ? 100 : -100), m: a.m, d: a.d } : genDate(r);
        const ka = periodKey(pattern, iso(a.y, a.m, a.d));
        const kb = periodKey(pattern, iso(b.y, b.m, b.d));
        if (ka === kb) continue;
        const c = genCounter(r);
        const c2 = r.next() < 0.5 ? c : genCounter(r);
        const n1 = format(pattern, iso(a.y, a.m, a.d), c);
        const n2 = format(pattern, iso(b.y, b.m, b.d), c2);
        const expected =
          !year4 &&
          c === c2 &&
          a.y % 100 === b.y % 100 &&
          (pattern.reset !== "monthly" || a.m === b.m);
        if ((n1 === n2) !== expected)
          throw new Error(`${source}: ${ka}/${c} -> ${n1}, ${kb}/${c2} -> ${n2}`);
      }
    });
    expect(checked).toBe(500);
  });

  test("the documented cross-period collision: YY-NNN in 2026 and 2126", () => {
    const pattern = Result.getOrThrow(parsePattern("YY-NNN"));
    expect(format(pattern, IsoDate.make("2026-01-05"), 1)).toBe("26-001");
    expect(format(pattern, IsoDate.make("2126-01-05"), 1)).toBe("26-001");
    expect(periodKey(pattern, IsoDate.make("2026-01-05"))).not.toBe(
      periodKey(pattern, IsoDate.make("2126-01-05")),
    );
  });

  test("field limits at the boundary: 20 characters pass, 21 fail, also when the counter outgrows its width", () => {
    expect(MAX_NUMBER_LENGTH).toBe(SPEC_MAX_LENGTH);
    expect(MAX_COUNTER).toBe(SPEC_MAX_COUNTER);
    for (const length of [19, 20, 21]) {
      for (let width = 1; width <= 10; width++) {
        // Digits are literal text, so "1111NNN" is a literal and a 3-wide counter.
        const source = `${EffectString.repeat(length - width)("1")}${EffectString.repeat(width)("N")}`;
        const parsed = parsePattern(source);
        expect([source, Result.isSuccess(parsed)]).toEqual([source, length <= SPEC_MAX_LENGTH]);
        if (Result.isFailure(parsed)) {
          if (parsed.failure.issues[0]?.params?.reason !== "too_long") {
            throw new Error(`${source}: expected the too_long rejection`, {
              cause: parsed.failure,
            });
          }
          continue;
        }
        const date = IsoDate.make("2026-05-01");
        const atWidth = 10 ** width - 1;
        expect([source, fitsLength(parsed.success, date, atWidth)]).toEqual([source, true]);
        // One more digit than the run: the number grows by one character, never truncated.
        const grown = format(parsed.success, date, atWidth + 1);
        expect([source, grown.length]).toEqual([source, length + 1]);
        expect([source, fitsLength(parsed.success, date, atWidth + 1)]).toEqual([
          source,
          length + 1 <= SPEC_MAX_LENGTH,
        ]);
      }
    }
    const largest = checkNextCounter(1, SPEC_MAX_COUNTER).pipe(Result.isSuccess);
    const overflow = checkNextCounter(1, SPEC_MAX_COUNTER + 1).pipe(Result.isFailure);
    expect(largest).toBe(true);
    expect(overflow).toBe(true);
  });
});
