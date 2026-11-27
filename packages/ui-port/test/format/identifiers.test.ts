import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";

import {
  czechAccountToIban,
  formatCzechAccount,
  formatIban,
  ibanToCzechAccount,
  isValidIco,
  normalizeIco,
  parseCzechAccount,
  validateBic,
  validateCzechDic,
  validateEuVatId,
  validateIban,
  validateIco,
} from "../../src/format";
import { isMessageKey } from "../../src/i18n";

const code = <A>(r: Result.Result<A, { readonly code: string }>): string | undefined =>
  Result.isFailure(r) ? r.failure.code : undefined;
const ok = <A, E>(r: Result.Result<A, E>): A | undefined =>
  Result.isSuccess(r) ? r.success : undefined;

describe("IČO", () => {
  test("valid numbers incl. leading zeros and pasted spaces", () => {
    const ico = validateIco("27082440").pipe(ok);
    expect(ico).toBe("27082440");
    validateIco("25596641").pipe(ok, expect).toBe("25596641");
    validateIco(" 270 82 440 ").pipe(ok, expect).toBe("27082440");
  });

  test("short numbers are left-padded as ARES does", () => {
    expect(normalizeIco("19")).toBe("00000019");
    expect(isValidIco("19")).toBe(true);
  });

  test("check digit edge cases of (11 - sum mod 11) mod 10", () => {
    // 0000014: sum 1*3 + 4*2 = 11, remainder 0 → check digit 1
    expect(isValidIco("00000141")).toBe(true);
    expect(isValidIco("00000140")).toBe(false);
    // 0000006: sum 6*2 = 12, remainder 1 → check digit 0
    expect(isValidIco("00000060")).toBe(true);
    // 0000033: sum 9 + 6 = 15, remainder 4 → check digit 7
    expect(isValidIco("00000337")).toBe(true);
  });

  test("failures map to issue codes with copy", () => {
    validateIco("27082441").pipe(code, expect).toBe("ico.checksum");
    validateIco("123456789").pipe(code, expect).toBe("form.ico_format");
    validateIco("1234567a").pipe(code, expect).toBe("form.ico_format");
    validateIco("").pipe(code, expect).toBe("form.ico_format");
    expect(isMessageKey("issue.ico.checksum") && isMessageKey("issue.form.ico_format")).toBe(true);
  });
});

describe("DIČ and EU VAT IDs", () => {
  test("Czech DIČ: CZ + 8 to 10 digits, format only", () => {
    const dic = validateCzechDic("cz 27082440").pipe(ok);
    expect(dic).toBe("CZ27082440");
    // biome-ignore lint/security/noSecrets: The literal is public fixture data.
    validateCzechDic("CZ7103192745").pipe(ok, expect).toBe("CZ7103192745");
    validateCzechDic("CZ640903926").pipe(ok, expect).toBe("CZ640903926");
    validateCzechDic("CZ1234567").pipe(code, expect).toBe("form.dic_invalid");
    // biome-ignore lint/security/noSecrets: The literal is public fixture data.
    validateCzechDic("CZ12345678901").pipe(code, expect).toBe("form.dic_invalid");
    validateCzechDic("27082440").pipe(code, expect).toBe("form.dic_invalid");
    validateCzechDic("CZ2708244A").pipe(code, expect).toBe("form.dic_invalid");
  });

  test("EU VAT formats by country", () => {
    validateEuVatId("DE 123456789").pipe(ok, expect).toBe("DE123456789");
    validateEuVatId("ATU12345678").pipe(ok, expect).toBe("ATU12345678");
    // biome-ignore lint/security/noSecrets: The literal is public fixture data.
    validateEuVatId("NL123456789B01").pipe(ok, expect).toBe("NL123456789B01");
    validateEuVatId("GR123456789").pipe(ok, expect).toBe("EL123456789");
    validateEuVatId("SK2020273893").pipe(ok, expect).toBe("SK2020273893");
    validateEuVatId("CZ27082440").pipe(ok, expect).toBe("CZ27082440");
    const bad = validateEuVatId("DE12345678");
    bad.pipe(code, expect).toBe("form.vat_id_invalid");
    expect(Result.isFailure(bad) ? bad.failure.params : undefined).toEqual({ country: "DE" });
    validateEuVatId("US123456789").pipe(code, expect).toBe("form.vat_id_country_unknown");
    validateEuVatId("CZ123").pipe(code, expect).toBe("form.dic_invalid");
    // biome-ignore lint/security/noSecrets: The literal is public fixture data.
    validateEuVatId("SE556677889901").pipe(ok, expect).toBe("SE556677889901");
    // biome-ignore lint/security/noSecrets: The literal is public fixture data.
    validateEuVatId("SE556677889902").pipe(code, expect).toBe("form.vat_id_invalid");
    validateEuVatId("ESX1234567L").pipe(ok, expect).toBe("ESX1234567L");
    validateEuVatId("ES12345678Z").pipe(ok, expect).toBe("ES12345678Z");
    validateEuVatId("ES123456789").pipe(code, expect).toBe("form.vat_id_invalid");
  });
});

describe("bank accounts", () => {
  test("IBAN validation and print format", () => {
    validateIban("cz65 0800 0000 1920 0014 5399").pipe(ok, expect).toBe("CZ6508000000192000145399");
    validateIban("CZ6508000000192000145398").pipe(code, expect).toBe("form.iban_invalid");
    validateIban("CZ650800000019200014539").pipe(code, expect).toBe("form.iban_invalid"); // length
    validateIban("DE89370400440532013000").pipe(ok, expect).toBe("DE89370400440532013000");
    expect(formatIban("CZ6508000000192000145399")).toBe("CZ65 0800 0000 1920 0014 5399");
  });

  test("IBAN rejects reserved check digits and letters in a Czech BBAN (both pass mod 97)", () => {
    // 01 is congruent to the true check digits 98, so mod 97 alone would accept it.
    const iban = validateIban("CZ9808000000000000000013").pipe(ok);
    expect(iban).toBe("CZ9808000000000000000013");
    validateIban("CZ0108000000000000000013").pipe(code, expect).toBe("form.iban_invalid");
    // Correct mod-97 check digits for a BBAN with letters.
    validateIban("CZ62080000001920001453AB").pipe(code, expect).toBe("form.iban_invalid");
  });

  test("IBAN to Czech account also applies the domestic mod-11 rule", () => {
    validateIban("CZ9208000000192000145398").pipe(ok, expect).toBe("CZ9208000000192000145398");
    expect(ibanToCzechAccount("CZ9208000000192000145398")).toBeUndefined();
    expect(ibanToCzechAccount("CZ6508000000192000145398")).toBeUndefined();
  });

  test("Czech account number mod 11, IBAN round trip", () => {
    const parsed = parseCzechAccount("19-2000145399/0800");
    const account = ok(parsed);
    expect(account).toEqual({ prefix: "19", number: "2000145399", bankCode: "0800" });
    if (account === undefined) throw new Error("unreachable");
    expect(czechAccountToIban(account)).toBe("CZ6508000000192000145399");
    expect(ibanToCzechAccount("CZ65 0800 0000 1920 0014 5399")).toEqual(account);
    expect(formatCzechAccount(account)).toBe("19-2000145399/0800");
    parseCzechAccount("19-2000145398/0800").pipe(code, expect).toBe("form.bank_account_invalid");
    parseCzechAccount("2000145399").pipe(code, expect).toBe("form.bank_account_invalid");
    expect(ibanToCzechAccount("DE89370400440532013000")).toBeUndefined();
  });

  test("BIC", () => {
    const bic = validateBic("GIBACZPX").pipe(ok);
    expect(bic).toBe("GIBACZPX");
    validateBic("komb czpp xxx").pipe(ok, expect).toBe("KOMBCZPPXXX");
    validateBic("KOMB1").pipe(code, expect).toBe("form.bic_invalid");
  });
});
