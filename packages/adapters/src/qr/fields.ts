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

/**
 * Registered BBAN formats for every country in the SWIFT IBAN registry, in its notation
 * (n digits, a upper-case letters, c alphanumerics). The IBAN length is 4 plus the BBAN length.
 * A country not listed here is rejected.
 */
const BBAN_FORMATS: Readonly<Record<string, string>> = {
  AD: "8n12c",
  AE: "19n",
  AL: "8n16c",
  AT: "16n",
  AZ: "4a20c",
  BA: "16n",
  BE: "12n",
  BG: "4a6n8c",
  BH: "4a14c",
  BI: "23n",
  BR: "8c15n2c",
  BY: "4c4n16c",
  CH: "5n12c",
  CR: "18n",
  CY: "8n16c",
  CZ: "20n",
  DE: "18n",
  DJ: "23n",
  DK: "14n",
  DO: "4c20n",
  EE: "16n",
  EG: "25n",
  ES: "20n",
  FI: "14n",
  FK: "2a12n",
  FO: "14n",
  FR: "10n11c2n",
  GB: "4a14n",
  GE: "2a16n",
  GI: "4a15c",
  GL: "14n",
  GR: "7n16c",
  GT: "24c",
  HN: "4a20n",
  HR: "17n",
  HU: "24n",
  IE: "4a14n",
  IL: "19n",
  IQ: "4a15n",
  IS: "22n",
  IT: "1a10n12c",
  JO: "4a4n18c",
  KW: "4a22c",
  KZ: "3n13c",
  LB: "4n20c",
  LC: "4a24c",
  LI: "5n12c",
  LT: "16n",
  LU: "3n13c",
  LV: "4a13c",
  LY: "21n",
  MC: "10n11c2n",
  MD: "20c",
  ME: "18n",
  MK: "3n10c2n",
  MN: "16n",
  MR: "23n",
  MT: "4a5n18c",
  MU: "4a19n3a",
  NI: "4a20n",
  NL: "4a10n",
  NO: "11n",
  OM: "3n16c",
  PK: "4a16c",
  PL: "24n",
  PS: "4a21c",
  PT: "21n",
  QA: "4a21c",
  RO: "4a16c",
  RS: "18n",
  RU: "14n15c",
  SA: "2n18c",
  SC: "4a20n3a",
  SD: "14n",
  SE: "20n",
  SI: "15n",
  SK: "20n",
  SM: "1a10n12c",
  SO: "19n",
  ST: "21n",
  SV: "4a20n",
  TL: "19n",
  TN: "20n",
  TR: "6n16c",
  UA: "6n19c",
  VA: "18n",
  VG: "4a16n",
  XK: "16n",
  YE: "4a4n18c",
};

const CLASS: Readonly<Record<string, string>> = { n: "\\d", a: "[A-Z]", c: "[A-Z0-9]" };
const BBAN_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  Object.entries(BBAN_FORMATS).map(([country, format]) => [
    country,
    new RegExp(
      `^${[...format.matchAll(/(\d+)([nac])/g)].map((m) => `${CLASS[m[2] ?? "c"]}{${m[1]}}`).join("")}$`,
    ),
  ]),
);

/** EEA countries, where EPC069-12 version 002 lets the BIC be omitted. */
export const EEA_COUNTRIES: ReadonlySet<string> = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(
    " ",
  ),
);

/** ISO 13616: registered BBAN format (which fixes the length), then the mod 97-10 check digits. */
export const isValidIban = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const bban = BBAN_PATTERNS.get(iban.slice(0, 2));
  if (bban === undefined || !bban.test(iban.slice(4))) return false;
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
