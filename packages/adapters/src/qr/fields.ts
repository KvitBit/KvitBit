/** Field validation and text shaping shared by the SPAYD and EPC payload builders. */
import type { IssueCode } from "@kvitbit/domain";
import { Invalid } from "@kvitbit/domain";
import { BigDecimal, Result } from "effect";

export const invalid = (
  path: string | ReadonlyArray<string>,
  code: IssueCode,
  params?: Readonly<Record<string, string>>,
): Invalid =>
  new Invalid({
    issues: [
      {
        path: typeof path === "string" ? [path] : [...path],
        code,
        ...(params === undefined ? {} : { params }),
      },
    ],
  });

/** Removes spaces and uppercases, so "cz65 2010 ..." and "CZ652010..." compare equal. */
export const normalizeIban = (iban: string): string => iban.replace(/\s+/g, "").toUpperCase();

/** ISO 13616 shape plus the ISO 7064 mod 97-10 check digits. */
export const isValidIban = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
};

/** ISO 9362 BIC: 8 or 11 characters. */
export const isValidBic = (bic: string): boolean =>
  /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic);

export const validIban = (field: string, raw: string): Result.Result<string, Invalid> => {
  const iban = normalizeIban(raw);
  return isValidIban(iban)
    ? Result.succeed(iban)
    : Result.fail(invalid(field, "request.malformed"));
};

export const validBic = (
  field: string,
  raw: string | undefined,
): Result.Result<string | undefined, Invalid> => {
  if (raw === undefined || raw.trim() === "") return Result.succeed(undefined);
  const bic = raw.replace(/\s+/g, "").toUpperCase();
  return isValidBic(bic) ? Result.succeed(bic) : Result.fail(invalid(field, "request.malformed"));
};

/**
 * Formats a positive amount with exactly two decimals and a dot separator, rounding half away
 * from zero. Amounts outside `[min, max]` are `Invalid`.
 */
export const validAmount = (
  field: string,
  amount: BigDecimal.BigDecimal,
  min: string,
  max: string,
): Result.Result<string, Invalid> => {
  const rounded = BigDecimal.scale(
    BigDecimal.round(amount, { scale: 2, mode: "half-from-zero" }),
    2,
  );
  if (
    BigDecimal.isLessThan(rounded, BigDecimal.fromStringUnsafe(min)) ||
    BigDecimal.isGreaterThan(rounded, BigDecimal.fromStringUnsafe(max))
  ) {
    return Result.fail(invalid(field, "request.malformed", { min, max }));
  }
  const digits = rounded.value.toString().padStart(3, "0");
  return Result.succeed(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
};

/** Collapses whitespace and control characters (including line breaks) to single spaces. */
export const singleLine = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
  text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();

/**
 * Shortens `text` to the longest prefix whose `measure` fits `max`, preferring to cut at the
 * last space. A single overlong word is cut mid-word.
 */
export const truncateAtWord = (
  text: string,
  max: number,
  measure: (s: string) => number = (s) => [...s].length,
): string => {
  if (measure(text) <= max) return text;
  const chars = [...text];
  let n = Math.min(chars.length, max);
  while (n > 0) {
    const prefix = chars.slice(0, n + 1).join("");
    const space = prefix.lastIndexOf(" ");
    const cut = (space > 0 ? prefix.slice(0, space) : chars.slice(0, n).join("")).trimEnd();
    if (measure(cut) <= max) return cut;
    n -= 1;
  }
  return "";
};
