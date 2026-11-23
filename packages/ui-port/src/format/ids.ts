import { Result } from "effect";
import { compact, type FormatIssue, issue } from "./shared";

/** IČO check digit: weights 8..2 on the first seven digits, `(11 - sum mod 11) mod 10`. */
const icoCheckDigit = (digits: string): number => {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * (8 - i);
  return (11 - (sum % 11)) % 10;
};

/** Strips separators and left-pads short numeric IČO to 8 digits (ARES drops leading zeros). */
export const normalizeIco = (input: string): string => {
  const c = compact(input);
  return /^\d{1,7}$/.test(c) ? c.padStart(8, "0") : c;
};

export const isValidIco = (input: string): boolean => Result.isSuccess(validateIco(input));

/** `form.ico_format` for anything but up to 8 digits, `ico.checksum` for a wrong check digit. */
export const validateIco = (input: string): Result.Result<string, FormatIssue> => {
  const ico = normalizeIco(input);
  if (!/^\d{8}$/.test(ico)) return Result.fail(issue("form.ico_format"));
  return icoCheckDigit(ico) === Number(ico[7])
    ? Result.succeed(ico)
    : Result.fail(issue("ico.checksum"));
};

/** Uppercases and strips separators: `cz 123 456 78` → `CZ12345678`. Greek `GR` becomes `EL`. */
export const normalizeVatId = (input: string): string => {
  const c = compact(input).toUpperCase();
  return c.startsWith("GR") ? `EL${c.slice(2)}` : c;
};

/** Rodné číslo used as DIČ: 10 digits divisible by 11 (or the pre-1985 remainder-10 rule). */
const isValidBirthNumber = (digits: string): boolean => {
  const n = BigInt(digits);
  if (n % 11n === 0n) return true;
  return BigInt(digits.slice(0, 9)) % 11n === 10n && digits[9] === "0";
};

/**
 * Czech DIČ: `CZ` + 8 digits (IČO with its checksum), 9 digits (older birth numbers and
 * special 6xx numbers) or 10 digits (birth number, mod 11). Fails with `form.dic_invalid`.
 */
export const validateCzechDic = (input: string): Result.Result<string, FormatIssue> => {
  const dic = normalizeVatId(input);
  const m = /^CZ(\d{8,10})$/.exec(dic);
  const digits = m?.[1];
  if (digits === undefined) return Result.fail(issue("form.dic_invalid"));
  if (digits.length === 8 && icoCheckDigit(digits) !== Number(digits[7])) {
    return Result.fail(issue("form.dic_invalid"));
  }
  if (digits.length === 10 && !isValidBirthNumber(digits)) {
    return Result.fail(issue("form.dic_invalid"));
  }
  return Result.succeed(dic);
};

/** VIES number formats after the two-letter prefix (EU member states plus XI). */
export const EU_VAT_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^[1-9]\d{1,9}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/**
 * EU VAT ID format check (no VIES call). Unknown prefix: `form.vat_id_country_unknown`;
 * wrong body: `form.vat_id_invalid` with `{ country }`; CZ uses the Czech DIČ rules.
 */
export const validateEuVatId = (input: string): Result.Result<string, FormatIssue> => {
  const id = normalizeVatId(input);
  const country = id.slice(0, 2);
  const format = EU_VAT_FORMATS[country];
  if (!/^[A-Z]{2}$/.test(country) || format === undefined) {
    return Result.fail(issue("form.vat_id_country_unknown"));
  }
  if (country === "CZ") return validateCzechDic(id);
  return format.test(id.slice(2))
    ? Result.succeed(id)
    : Result.fail(issue("form.vat_id_invalid", { country }));
};
