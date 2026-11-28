/**
 * Exhaustive checks of MoneyMath (src/money.ts) against plain BigInt arithmetic: half away from
 * zero over every rounding residue at every minor-unit scale, the minor-unit table over every
 * three-letter code, and add/subtract/negate laws over a bounded grid. Every domain is enumerated
 * in full and its size is asserted. Guarded by .agents/skills/verify-money-access.
 */
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { CurrencyCode, type Money, MoneyMath } from "../src/index";

const code = CurrencyCode.make;
const isCurrencyMismatch = Schema.is(Schema.instanceOf(MoneyMath.CurrencyMismatch));
const CZK = code("CZK");
const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error("expected success");
  return r.success;
};
const moneyOf = (value: bigint, scale: number, currency = CZK): Money =>
  MoneyMath.make(BigDecimal.make(value, scale), currency);
/** `value / 10^scale` as an exact BigDecimal, for equality checks. */
const dec = (value: bigint, scale: number) => BigDecimal.make(value, scale);

/** Oracle: `value / 10^drop` rounded half away from zero, in BigInt. */
const roundHalfAway = (value: bigint, drop: number): bigint => {
  if (drop <= 0) return value * 10n ** BigInt(-drop);
  const unit = 10n ** BigInt(drop);
  const magnitude = value < 0n ? -value : value;
  const q: bigint = magnitude / unit;
  const r = magnitude % unit;
  const rounded: bigint = 2n * r >= unit ? q + 1n : q;
  return value < 0n ? -rounded : rounded;
};

/**
 * ISO 4217 minor units that differ from 2 (ISO 4217 list one, current funds and currencies),
 * written out independently of src/money.ts. Every other code, including unknown ones, is 2
 * (the documented product fallback).
 */
const ISO_SCALE: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};
/** One currency per minor-unit scale that occurs. */
const BY_SCALE: ReadonlyArray<readonly [CurrencyCode, number]> = [
  [code("JPY"), 0],
  [CZK, 2],
  [code("KWD"), 3],
  [code("CLF"), 4],
];

describe("minor units: every three-letter code", () => {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const codes: Array<CurrencyCode> = [];
  for (const a of LETTERS)
    for (const b of LETTERS) for (const c of LETTERS) codes.push(code(`${a}${b}${c}`));

  test("minorUnitScale matches ISO 4217 with the 2-decimal fallback", () => {
    expect(codes.length).toBe(17_576);
    const wrong = Arr.filter(codes, (c) => MoneyMath.minorUnitScale(c) !== (ISO_SCALE[c] ?? 2));
    expect(wrong).toEqual([]);
  });

  test("fromMinorUnits and toMinorUnits round-trip for every code and units in -1000..1000", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const c of codes) {
      const scale = ISO_SCALE[c] ?? 2;
      for (const units of [-1000n, -101n, -1n, 0n, 1n, 99n, 1000n]) {
        checked++;
        const money = MoneyMath.fromMinorUnits(units, c);
        if (!BigDecimal.equals(money.amount, dec(units, scale)) || money.currency !== c) {
          wrong.push(`${c} fromMinorUnits(${units})`);
        }
        if (MoneyMath.toMinorUnits(money) !== units) wrong.push(`${c} toMinorUnits(${units})`);
      }
    }
    expect(checked).toBe(17_576 * 7);
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe("round: half away from zero over the full residue space", () => {
  // Whole parts of the rounded result, in minor units at the target scale, including a value
  // past 2^53 so float shortcuts would show.
  const beyondSafeInteger: bigint = 2n ** 60n;
  const largeWhole = beyondSafeInteger + 7n;
  const WHOLES = [0n, 1n, 9n, 10n, 12_345n, largeWhole];
  // Extra digits below the minor unit: every residue 0 .. 10^extra - 1.
  const EXTRA = [1, 2, 3];

  test("round, default scale and toMinorUnits equal the BigInt oracle, sign symmetric", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const [currency, scale] of BY_SCALE) {
      for (const extra of EXTRA) {
        const unit = 10n ** BigInt(extra);
        for (const whole of WHOLES) {
          const scaledWhole: bigint = whole * unit;
          for (let r = 0n; r < unit; r++) {
            for (const sign of [1n, -1n]) {
              checked++;
              const value = sign * (scaledWhole + r);
              const money = moneyOf(value, scale + extra, currency);
              const expected = roundHalfAway(value, extra);
              const rounded = MoneyMath.round(money);
              if (rounded.currency !== currency) wrong.push(`${currency} currency lost`);
              if (!BigDecimal.equals(rounded.amount, dec(expected, scale))) {
                wrong.push(`${currency} round(${BigDecimal.format(money.amount)})`);
              }
              if (!BigDecimal.equals(MoneyMath.round(money, scale).amount, rounded.amount)) {
                wrong.push(`${currency} explicit scale differs at ${value}`);
              }
              if (MoneyMath.toMinorUnits(money) !== expected) {
                wrong.push(`${currency} toMinorUnits(${BigDecimal.format(money.amount)})`);
              }
              // Sign symmetry: round(-x) = -round(x).
              const mirrored = MoneyMath.round(MoneyMath.negate(money));
              if (!BigDecimal.equals(mirrored.amount, BigDecimal.negate(rounded.amount))) {
                wrong.push(`${currency} round(-x) != -round(x) at ${value}`);
              }
            }
          }
        }
      }
    }
    // Fixed total (4 scales × 6 whole parts × 1,110 residues × 2 signs), and at least one whole
    // part past 2^53, so neither the grid nor the float-hostile case can shrink silently.
    expect(checked).toBe(53_280);
    expect(Arr.some(WHOLES, (w) => w > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("round at an explicit scale other than the currency's: every residue of 1 and 2 dropped digits", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const target of [0, 1, 2, 3, 4, 6]) {
      for (const extra of [1, 2]) {
        const unit = 10n ** BigInt(extra);
        for (const whole of [0n, 3n, largeWhole]) {
          const scaledWhole: bigint = whole * unit;
          for (let r = 0n; r < unit; r++) {
            for (const sign of [1n, -1n]) {
              checked++;
              const value = sign * (scaledWhole + r);
              const rounded = MoneyMath.round(moneyOf(value, target + extra), target);
              if (
                rounded.currency !== CZK ||
                !BigDecimal.equals(rounded.amount, dec(roundHalfAway(value, extra), target))
              ) {
                wrong.push(`round(${value}e-${target + extra}, ${target})`);
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(6 * 3 * (10 + 100) * 2);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("amounts already at or below the minor unit's precision are unchanged", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const [currency, scale] of BY_SCALE) {
      for (let s = 0; s <= scale; s++) {
        for (let v = -200n; v <= 200n; v++) {
          checked++;
          const money = moneyOf(v, s, currency);
          if (!BigDecimal.equals(MoneyMath.round(money).amount, money.amount)) {
            wrong.push(`${currency} ${BigDecimal.format(money.amount)}`);
          }
          if (MoneyMath.toMinorUnits(money) !== roundHalfAway(v, s - scale)) {
            wrong.push(`${currency} toMinorUnits(${BigDecimal.format(money.amount)})`);
          }
        }
      }
    }
    expect(checked).toBe((1 + 3 + 4 + 5) * 401);
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe("arithmetic laws over a bounded grid", () => {
  // Every v / 10^s with v in -12..12 and s in {0, 1, 2, 3}: mixed scales on purpose.
  const GRID: Array<readonly [bigint, number]> = [];
  for (const s of [0, 1, 2, 3]) for (let v = -12n; v <= 12n; v++) GRID.push([v, s]);
  /** The value at scale 3 (the grid's finest), for exact BigInt comparison. */
  const at3 = ([v, s]: readonly [bigint, number]) => v * 10n ** BigInt(3 - s);
  const asMoney = (g: readonly [bigint, number]) => moneyOf(g[0], g[1]);

  test("add, subtract, negate, compare and equals agree with BigInt on every pair", () => {
    expect(GRID.length).toBe(100);
    let checked = 0;
    const wrong: Array<string> = [];
    for (const a of GRID) {
      const ma = asMoney(a);
      if (!BigDecimal.equals(MoneyMath.negate(MoneyMath.negate(ma)).amount, ma.amount)) {
        wrong.push(`--${at3(a)}`);
      }
      if (!MoneyMath.add(ma, MoneyMath.negate(ma)).pipe(ok, MoneyMath.isZero))
        wrong.push(`x+-x ${at3(a)}`);
      if (!MoneyMath.equals(ok(MoneyMath.add(ma, MoneyMath.zero(CZK))), ma))
        wrong.push(`x+0 ${at3(a)}`);
      if (MoneyMath.isNegative(ma) !== at3(a) < 0n) wrong.push(`isNegative ${at3(a)}`);
      if (MoneyMath.isZero(ma) !== (at3(a) === 0n)) wrong.push(`isZero ${at3(a)}`);
      for (const b of GRID) {
        checked++;
        const mb = asMoney(b);
        const sum = ok(MoneyMath.add(ma, mb));
        const diff = ok(MoneyMath.subtract(ma, mb));
        if (!BigDecimal.equals(sum.amount, dec(at3(a) + at3(b), 3)))
          wrong.push(`${at3(a)}+${at3(b)}`);
        if (!BigDecimal.equals(diff.amount, dec(at3(a) - at3(b), 3)))
          wrong.push(`${at3(a)}-${at3(b)}`);
        if (!MoneyMath.equals(sum, ok(MoneyMath.add(mb, ma))))
          wrong.push(`commute ${at3(a)} ${at3(b)}`);
        if (!MoneyMath.equals(diff, ok(MoneyMath.add(ma, MoneyMath.negate(mb))))) {
          wrong.push(`a-b != a+-b ${at3(a)} ${at3(b)}`);
        }
        const order = at3(a) < at3(b) ? -1 : at3(a) > at3(b) ? 1 : 0;
        if (ok(MoneyMath.compare(ma, mb)) !== order) wrong.push(`compare ${at3(a)} ${at3(b)}`);
        if (MoneyMath.equals(ma, mb) !== (order === 0)) wrong.push(`equals ${at3(a)} ${at3(b)}`);
      }
    }
    expect(checked).toBe(100 * 100);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("add is associative and sum equals the BigInt fold on every triple", () => {
    const small = Arr.filter(GRID, ([v, s]) => v >= -4n && v <= 4n && (s === 0 || s === 3));
    expect(small.length).toBe(18);
    let checked = 0;
    const wrong: Array<string> = [];
    for (const a of small) {
      for (const b of small) {
        for (const c of small) {
          checked++;
          const [ma, mb, mc] = [asMoney(a), asMoney(b), asMoney(c)];
          const left = ok(MoneyMath.add(ok(MoneyMath.add(ma, mb)), mc));
          const right = ok(MoneyMath.add(ma, ok(MoneyMath.add(mb, mc))));
          const total = ok(MoneyMath.sum(CZK, [ma, mb, mc]));
          const expected = dec(at3(a) + at3(b) + at3(c), 3);
          if (!MoneyMath.equals(left, right)) wrong.push(`assoc ${at3(a)} ${at3(b)} ${at3(c)}`);
          if (!BigDecimal.equals(total.amount, expected))
            wrong.push(`sum ${at3(a)} ${at3(b)} ${at3(c)}`);
        }
      }
    }
    expect(checked).toBe(18 ** 3);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("every operation on two different currencies fails with CurrencyMismatch{expected, actual}", () => {
    const currencies = [CZK, code("EUR"), code("JPY"), code("KWD"), code("CLF"), code("XYZ")];
    let checked = 0;
    const wrong: Array<string> = [];
    for (const x of currencies) {
      for (const y of currencies) {
        if (x === y) continue;
        checked++;
        const a = moneyOf(1n, 0, x);
        const b = moneyOf(1n, 0, y);
        const results: ReadonlyArray<Result.Result<unknown, MoneyMath.CurrencyMismatch>> = [
          MoneyMath.add(a, b),
          MoneyMath.subtract(a, b),
          MoneyMath.compare(a, b),
          MoneyMath.sum(x, [a, b]),
        ];
        for (const r of results) {
          if (
            !(Result.isFailure(r) && isCurrencyMismatch(r.failure)) ||
            r.failure.expected !== x ||
            r.failure.actual !== y
          ) {
            wrong.push(`${x} vs ${y}`);
          }
        }
        if (MoneyMath.equals(a, b)) wrong.push(`equals ${x} ${y}`);
      }
    }
    expect(checked).toBe(30);
    expect(wrong).toEqual([]);
  });
});
