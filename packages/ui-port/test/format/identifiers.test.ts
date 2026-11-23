import { describe, expect, test } from "bun:test";
import { Result } from "effect";
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
    expect(ok(validateIco("27082440"))).toBe("27082440");
    expect(ok(validateIco("25596641"))).toBe("25596641");
    expect(ok(validateIco(" 270 82 440 "))).toBe("27082440");
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
    expect(code(validateIco("27082441"))).toBe("ico.checksum");
    expect(code(validateIco("123456789"))).toBe("form.ico_format");
    expect(code(validateIco("1234567a"))).toBe("form.ico_format");
    expect(code(validateIco(""))).toBe("form.ico_format");
    expect(isMessageKey("issue.ico.checksum") && isMessageKey("issue.form.ico_format")).toBe(true);
  });
});

describe("DIČ and EU VAT IDs", () => {
  test("Czech DIČ: CZ + 8 to 10 digits, format only", () => {
    expect(ok(validateCzechDic("cz 27082440"))).toBe("CZ27082440");
    expect(ok(validateCzechDic("CZ7103192745"))).toBe("CZ7103192745");
    expect(ok(validateCzechDic("CZ640903926"))).toBe("CZ640903926");
    expect(code(validateCzechDic("CZ1234567"))).toBe("form.dic_invalid");
    expect(code(validateCzechDic("CZ12345678901"))).toBe("form.dic_invalid");
    expect(code(validateCzechDic("27082440"))).toBe("form.dic_invalid");
    expect(code(validateCzechDic("CZ2708244A"))).toBe("form.dic_invalid");
  });

  test("EU VAT formats by country", () => {
    expect(ok(validateEuVatId("DE 123456789"))).toBe("DE123456789");
    expect(ok(validateEuVatId("ATU12345678"))).toBe("ATU12345678");
    expect(ok(validateEuVatId("NL123456789B01"))).toBe("NL123456789B01");
    expect(ok(validateEuVatId("GR123456789"))).toBe("EL123456789");
    expect(ok(validateEuVatId("SK2020273893"))).toBe("SK2020273893");
    expect(ok(validateEuVatId("CZ27082440"))).toBe("CZ27082440");
    const bad = validateEuVatId("DE12345678");
    expect(code(bad)).toBe("form.vat_id_invalid");
    expect(Result.isFailure(bad) ? bad.failure.params : undefined).toEqual({ country: "DE" });
    expect(code(validateEuVatId("US123456789"))).toBe("form.vat_id_country_unknown");
    expect(code(validateEuVatId("CZ123"))).toBe("form.dic_invalid");
    expect(ok(validateEuVatId("SE556677889901"))).toBe("SE556677889901");
    expect(code(validateEuVatId("SE556677889902"))).toBe("form.vat_id_invalid");
    expect(ok(validateEuVatId("ESX1234567L"))).toBe("ESX1234567L");
    expect(ok(validateEuVatId("ES12345678Z"))).toBe("ES12345678Z");
    expect(code(validateEuVatId("ES123456789"))).toBe("form.vat_id_invalid");
  });
});

describe("bank accounts", () => {
  test("IBAN validation and print format", () => {
    expect(ok(validateIban("cz65 0800 0000 1920 0014 5399"))).toBe("CZ6508000000192000145399");
    expect(code(validateIban("CZ6508000000192000145398"))).toBe("form.iban_invalid");
    expect(code(validateIban("CZ650800000019200014539"))).toBe("form.iban_invalid"); // length
    expect(ok(validateIban("DE89370400440532013000"))).toBe("DE89370400440532013000");
    expect(formatIban("CZ6508000000192000145399")).toBe("CZ65 0800 0000 1920 0014 5399");
  });

  test("IBAN rejects reserved check digits and letters in a Czech BBAN (both pass mod 97)", () => {
    // 01 is congruent to the true check digits 98, so mod 97 alone would accept it.
    expect(ok(validateIban("CZ9808000000000000000013"))).toBe("CZ9808000000000000000013");
    expect(code(validateIban("CZ0108000000000000000013"))).toBe("form.iban_invalid");
    // Correct mod-97 check digits for a BBAN with letters.
    expect(code(validateIban("CZ62080000001920001453AB"))).toBe("form.iban_invalid");
  });

  test("IBAN to Czech account also applies the domestic mod-11 rule", () => {
    expect(ok(validateIban("CZ9208000000192000145398"))).toBe("CZ9208000000192000145398");
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
    expect(code(parseCzechAccount("19-2000145398/0800"))).toBe("form.bank_account_invalid");
    expect(code(parseCzechAccount("2000145399"))).toBe("form.bank_account_invalid");
    expect(ibanToCzechAccount("DE89370400440532013000")).toBeUndefined();
  });

  test("BIC", () => {
    expect(ok(validateBic("GIBACZPX"))).toBe("GIBACZPX");
    expect(ok(validateBic("komb czpp xxx"))).toBe("KOMBCZPPXXX");
    expect(code(validateBic("KOMB1"))).toBe("form.bic_invalid");
  });
});
