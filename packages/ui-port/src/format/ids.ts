import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Str from "effect/String";

import { compact, type FormatIssue, issue } from "./shared";

const CZECH_DIC = /^\d{1,7}$/;
const SHORT_ICO = /^\d{8}$/;
const FULL_ICO = /^CZ\d{8,10}$/;
const VAT_COUNTRY = /^[A-Z]{2}$/;

/** IČO check digit: weights 8..2 on the first seven digits, `(11 - sum mod 11) mod 10`. */
const icoCheckDigit = (digits: string): number => {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * (8 - i);
  return (11 - (sum % 11)) % 10;
};

/** Strips separators and left-pads short numeric IČO to 8 digits (ARES drops leading zeros). */
export const normalizeIco = (input: string): string => {
  const c = compact(input);
  return CZECH_DIC.test(c) ? Fn.pipe(c, Str.padStart(8, "0")) : c;
};

export const isValidIco = (input: string): boolean => Result.isSuccess(validateIco(input));

/** `form.ico_format` for anything but up to 8 digits, `ico.checksum` for a wrong check digit. */
export const validateIco = (input: string): Result.Result<string, FormatIssue> => {
  const ico = normalizeIco(input);
  if (!SHORT_ICO.test(ico)) return Result.fail(issue("form.ico_format"));
  return icoCheckDigit(ico) === Number(ico[7])
    ? Result.succeed(ico)
    : Result.fail(issue("ico.checksum"));
};

/** Uppercases and strips separators: `cz 123 456 78` → `CZ12345678`. Greek `GR` becomes `EL`. */
export const normalizeVatId = (input: string): string => {
  const c = Str.toUpperCase(compact(input));
  return Fn.pipe(c, Str.startsWith("GR")) ? `EL${Fn.pipe(c, Str.slice(2))}` : c;
};

/**
 * Czech DIČ format: `CZ` + 8 digits (legal entities, from the IČO), 9 or 10 digits (natural
 * persons, from the birth number or a special number). Only the format is checked: the tax
 * office assigns DIČ, so no checksum is a reliable rule. Fails with `form.dic_invalid`.
 */
export const validateCzechDic = (input: string): Result.Result<string, FormatIssue> => {
  const dic = normalizeVatId(input);
  return FULL_ICO.test(dic) ? Result.succeed(dic) : Result.fail(issue("form.dic_invalid"));
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
  ES: /^([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])$/,
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
  SE: /^\d{10}01$/,
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
  const country = Fn.pipe(id, Str.slice(0, 2));
  const format = EU_VAT_FORMATS[country];
  if (!VAT_COUNTRY.test(country) || format === undefined) {
    return Result.fail(issue("form.vat_id_country_unknown"));
  }
  if (country === "CZ") return validateCzechDic(id);
  return format.test(Fn.pipe(id, Str.slice(2)))
    ? Result.succeed(id)
    : Result.fail(issue("form.vat_id_invalid", { country }));
};
