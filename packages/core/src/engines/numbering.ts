/**
 * Numbering (core-ports 5.2): Numbering Series patterns.
 *
 * Grammar: a pattern is a sequence of tokens. `YYYY` (4-digit year), `YY` (2-digit year), `MM`
 * (2-digit month), a run of N (the counter, zero-padded to the run's width) and literal text.
 * The pattern splits into words: maximal runs of ASCII letters. A word made only of the letters
 * Y, M and N is tokens (`YYMMNNN`, `NNNN`); any other word is literal text (`INV`, `FAKTURA`,
 * `MONTH`), as is everything that is not a letter (digits, `-`, `/`, ...). Inside a token word
 * a run of Y must be 2 or 4 long and a run of M exactly 2.
 * Validity: exactly one counter run; MM needs a year token (else numbers would repeat across
 * years); rendered at the counter's width, the number is 1 to 20 characters; no whitespace at
 * the ends and no control characters.
 * Reset: the finest date token (MM -> monthly, YYYY/YY -> yearly, none -> never). Period keys:
 * "2026", "2026-11", "all".
 * A counter past its width renders with more digits (NNN, 1000 -> "1000"), never truncated:
 * the 20-character limit is checked at the pattern's width and for a configured next counter
 * (`fitsLength`), while organic growth past the width widens the number rather than stopping
 * issuance.
 */
import type { IsoDate } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Result } from "effect";
import { parseIsoDate } from "./calendar";

export type PatternToken =
  | { readonly _tag: "Year4" }
  | { readonly _tag: "Year2" }
  | { readonly _tag: "Month" }
  | { readonly _tag: "Counter"; readonly width: number }
  | { readonly _tag: "Literal"; readonly text: string };

export interface NumberPattern {
  readonly tokens: ReadonlyArray<PatternToken>;
  readonly reset: "yearly" | "monthly" | "never";
}

export const MAX_NUMBER_LENGTH = 20;

export type PatternError =
  | "empty"
  | "counter_missing"
  | "counter_repeated"
  | "year_run"
  | "month_run"
  | "month_without_year"
  | "too_long"
  | "whitespace_edge"
  | "control_character";

const patternInvalid = (reason: PatternError, path: string = "pattern") =>
  new Invalid({
    issues: [{ path: [path], code: "numbering.pattern_invalid", params: { reason } }],
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

const renderedLength = (tokens: ReadonlyArray<PatternToken>): number =>
  tokens.reduce(
    (n, t) =>
      n +
      (t._tag === "Year4"
        ? 4
        : t._tag === "Literal"
          ? t.text.length
          : t._tag === "Counter"
            ? t.width
            : 2),
    0,
  );

export const parsePattern = (pattern: string): Result.Result<NumberPattern, Invalid> => {
  if (pattern.length === 0) return Result.fail(patternInvalid("empty"));
  if (CONTROL.test(pattern)) return Result.fail(patternInvalid("control_character"));
  if (pattern.trim() !== pattern) return Result.fail(patternInvalid("whitespace_edge"));
  const tokens: Array<PatternToken> = [];
  let literal = "";
  const flush = () => {
    if (literal) tokens.push({ _tag: "Literal", text: literal });
    literal = "";
  };
  for (const word of pattern.match(/[A-Za-z]+|[^A-Za-z]+/g) ?? []) {
    if (!/^[YMN]+$/.test(word)) {
      literal += word;
      continue;
    }
    flush();
    for (let i = 0; i < word.length; ) {
      const ch = word.charAt(i);
      let run = 1;
      while (word.charAt(i + run) === ch) run++;
      if (ch === "N") tokens.push({ _tag: "Counter", width: run });
      else if (ch === "M") {
        if (run !== 2) return Result.fail(patternInvalid("month_run"));
        tokens.push({ _tag: "Month" });
      } else if (run === 4) tokens.push({ _tag: "Year4" });
      else if (run === 2) tokens.push({ _tag: "Year2" });
      else return Result.fail(patternInvalid("year_run"));
      i += run;
    }
  }
  flush();
  const counters = tokens.filter((t) => t._tag === "Counter").length;
  if (counters === 0) return Result.fail(patternInvalid("counter_missing"));
  if (counters > 1) return Result.fail(patternInvalid("counter_repeated"));
  const hasYear = tokens.some((t) => t._tag === "Year4" || t._tag === "Year2");
  const hasMonth = tokens.some((t) => t._tag === "Month");
  if (hasMonth && !hasYear) return Result.fail(patternInvalid("month_without_year"));
  if (renderedLength(tokens) > MAX_NUMBER_LENGTH) return Result.fail(patternInvalid("too_long"));
  return Result.succeed({ tokens, reset: hasMonth ? "monthly" : hasYear ? "yearly" : "never" });
};

/** Counter partition for a date: "2026" (yearly), "2026-11" (monthly) or "all" (never). */
export const periodKey = (pattern: NumberPattern, issuedOn: IsoDate): string => {
  if (pattern.reset === "never") return "all";
  const { year, month } = parseIsoDate(issuedOn);
  const y = String(year).padStart(4, "0");
  return pattern.reset === "yearly" ? y : `${y}-${String(month).padStart(2, "0")}`;
};

/** Renders the number for a 1-based counter; a counter below 1 or fractional is a defect. */
export const format = (pattern: NumberPattern, issuedOn: IsoDate, counter: number): string => {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new Error(`Numbering.format: counter must be a positive integer, got ${counter}`);
  }
  const { year, month } = parseIsoDate(issuedOn);
  const y = String(year).padStart(4, "0");
  return pattern.tokens
    .map((t) => {
      switch (t._tag) {
        case "Year4":
          return y;
        case "Year2":
          return y.slice(-2);
        case "Month":
          return String(month).padStart(2, "0");
        case "Counter":
          return String(counter).padStart(t.width, "0");
        default:
          return t.text;
      }
    })
    .join("");
};

/** Whether the number for `counter` on `date` is at most 20 characters (configure-time check). */
export const fitsLength = (pattern: NumberPattern, date: IsoDate, counter: number): boolean =>
  format(pattern, date, counter).length <= MAX_NUMBER_LENGTH;

/** Digits of the number, the last 10, for the variable symbol; null when it has no digits. */
export const variableSymbol = (number: string): string | null => {
  const digits = number.replace(/\D/g, "");
  return digits.length === 0 ? null : digits.slice(-10);
};

/**
 * Lower-than-used guard (rule W3): a series edit may raise the next counter of the current
 * period, never lower it. Every counter value below `currentNext` was issued or skipped as
 * reserved, so `requested < currentNext` fails with
 * `Invalid{nextNumber, numbering.pattern_invalid, {reason: "below_used", minimum}}`.
 */
export const checkNextCounter = (
  currentNext: number,
  requested: number,
): Result.Result<number, Invalid> => {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return Result.fail(
      new Invalid({
        issues: [
          {
            path: ["nextNumber"],
            code: "numbering.pattern_invalid",
            params: { reason: "not_positive" },
          },
        ],
      }),
    );
  }
  return requested < currentNext
    ? Result.fail(
        new Invalid({
          issues: [
            {
              path: ["nextNumber"],
              code: "numbering.pattern_invalid",
              params: { reason: "below_used", minimum: String(currentNext) },
            },
          ],
        }),
      )
    : Result.succeed(requested);
};

/**
 * A manually chosen document number (rule D4): trimmed, 1 to 20 characters, no control
 * characters. Uniqueness is the reservation's job.
 */
export const checkManualNumber = (number: string): Result.Result<string, Invalid> => {
  const trimmed = number.trim();
  return trimmed.length === 0 || trimmed.length > MAX_NUMBER_LENGTH || CONTROL.test(trimmed)
    ? Result.fail(
        patternInvalid(
          trimmed.length === 0
            ? "empty"
            : trimmed.length > MAX_NUMBER_LENGTH
              ? "too_long"
              : "control_character",
          "number",
        ),
      )
    : Result.succeed(trimmed);
};

export const Numbering = {
  parsePattern,
  periodKey,
  format,
  variableSymbol,
  checkNextCounter,
  checkManualNumber,
  fitsLength,
} as const;
