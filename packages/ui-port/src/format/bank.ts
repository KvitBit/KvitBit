import { Result } from "effect";
import { type FormatIssue, issue } from "./shared";

/** IBAN lengths for the countries Czech businesses bank with most; others get 15-34. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  UA: 29,
};

/** Uppercases and removes every whitespace character. */
export const normalizeIban = (input: string): string => input.replace(/\s/g, "").toUpperCase();

/** ISO 13616 mod-97 of the rearranged IBAN, computed in chunks (no bigint needed). */
const mod97 = (iban: string): number => {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
};

export const validateIban = (input: string): Result.Result<string, FormatIssue> => {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return Result.fail(issue("form.iban_invalid"));
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) {
    return Result.fail(issue("form.iban_invalid"));
  }
  return mod97(iban) === 1 ? Result.succeed(iban) : Result.fail(issue("form.iban_invalid"));
};

/** Print form: groups of four, `CZ65 0800 0000 1920 0014 5399`. */
export const formatIban = (input: string): string =>
  normalizeIban(input).replace(/(.{4})(?=.)/g, "$1 ");

export const validateBic = (input: string): Result.Result<string, FormatIssue> => {
  const bic = normalizeIban(input);
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)
    ? Result.succeed(bic)
    : Result.fail(issue("form.bic_invalid"));
};

/** Czech domestic account `prefix-number/bankCode` (prefix optional). */
export interface CzechAccount {
  readonly prefix: string; // up to 6 digits, "" when absent
  readonly number: string; // 2-10 digits
  readonly bankCode: string; // 4 digits
}

const weightedMod11 = (digits: string, weights: ReadonlyArray<number>): boolean => {
  const padded = digits.padStart(weights.length, "0");
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(padded[i]) * (weights[i] ?? 0);
  return sum % 11 === 0;
};

/** Parses and checks the CNB mod-11 rule for prefix and number (Vyhláška 169/2011 Sb.). */
export const parseCzechAccount = (input: string): Result.Result<CzechAccount, FormatIssue> => {
  const m = /^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/.exec(input.replace(/\s/g, ""));
  if (m === null) return Result.fail(issue("form.bank_account_invalid"));
  const prefix = (m[1] ?? "").replace(/^0+/, "");
  const number = (m[2] ?? "").replace(/^0+(?=\d{2})/, "");
  const bankCode = m[3] ?? "";
  const prefixOk = prefix === "" || weightedMod11(prefix, [10, 5, 8, 4, 2, 1]);
  const numberOk = /[1-9]/.test(number) && weightedMod11(number, [6, 3, 7, 9, 10, 5, 8, 4, 2, 1]);
  return prefixOk && numberOk
    ? Result.succeed({ prefix, number, bankCode })
    : Result.fail(issue("form.bank_account_invalid"));
};

export const formatCzechAccount = (account: CzechAccount): string =>
  `${account.prefix === "" ? "" : `${account.prefix}-`}${account.number}/${account.bankCode}`;

/** Czech account to IBAN: `CZkk` + bank code + 6-digit prefix + 10-digit number. */
export const czechAccountToIban = (account: CzechAccount): string => {
  const bban =
    account.bankCode + account.prefix.padStart(6, "0") + account.number.padStart(10, "0");
  const check = 98 - mod97(`CZ00${bban}`);
  return `CZ${String(check).padStart(2, "0")}${bban}`;
};

/** IBAN of a Czech bank back to the domestic form; undefined for non-CZ IBANs. */
export const ibanToCzechAccount = (input: string): CzechAccount | undefined => {
  const iban = normalizeIban(input);
  if (!/^CZ\d{22}$/.test(iban)) return undefined;
  const prefix = iban.slice(8, 14).replace(/^0+/, "");
  const number = iban.slice(14).replace(/^0+(?=\d{2})/, "");
  return { prefix, number, bankCode: iban.slice(4, 8) };
};
