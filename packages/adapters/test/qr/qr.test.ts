import { describe, expect, test } from "bun:test";
import type { Invalid, IsoDate } from "@kvitbit/domain";
import { BigDecimal, Result } from "effect";
import QRCode from "qrcode";
import { epc, forDocument, isValidIban, type QrSource, spayd, toSvg } from "../../src/qr";

const bd = BigDecimal.fromStringUnsafe;
const CZ_IBAN = "CZ6508000000192000145399";
const ok = <A>(r: Result.Result<A, Invalid>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`);
  return r.success;
};
const issue = <A>(r: Result.Result<A, Invalid>) => {
  if (Result.isSuccess(r)) throw new Error(`expected Invalid, got ${JSON.stringify(r.success)}`);
  return r.failure.issues[0];
};

describe("spayd", () => {
  test("minimal payload: header, ACC, AM with two decimals, CC", () => {
    expect(ok(spayd({ iban: CZ_IBAN, amount: bd("480.5") }))).toBe(
      "SPD*1.0*ACC:CZ6508000000192000145399*AM:480.50*CC:CZK",
    );
  });

  test("known vector with BIC, VS, KS, due date, message and recipient", () => {
    expect(
      ok(
        spayd({
          iban: "cz65 0800 0000 1920 0014 5399",
          bic: "gibaczpx",
          amount: bd("58100"),
          variableSymbol: "20260042",
          constantSymbol: "0308",
          dueOn: "2026-11-16" as IsoDate,
          message: "Faktura 2026-0042",
          recipientName: "Ateliér Kalný s.r.o.",
        }),
      ),
    ).toBe(
      "SPD*1.0*ACC:CZ6508000000192000145399+GIBACZPX*AM:58100.00*CC:CZK*DT:20261116*MSG:FAKTURA 2026-0042*RN:ATELIÉR KALNÝ S.R.O.*X-VS:20260042*X-KS:0308",
    );
  });

  test("escapes * as %2A and % as %25 inside values, never in separators", () => {
    const s = ok(spayd({ iban: CZ_IBAN, amount: bd("1"), message: "50% sleva * akce" }));
    expect(s).toBe("SPD*1.0*ACC:CZ6508000000192000145399*AM:1.00*CC:CZK*MSG:50%25 SLEVA %2A AKCE");
    expect(s.split("*")).toHaveLength(6);
  });

  test("collapses line breaks and control characters", () => {
    const s = ok(spayd({ iban: CZ_IBAN, amount: bd("1"), message: "a\nb\t\u0007c" }));
    expect(s.endsWith("*MSG:A B C")).toBe(true);
  });

  test("truncates overlong message (60) and recipient (35) at a word boundary", () => {
    const message = "Platba za grafické práce a tiskovou přípravu odborné publikace dle objednávky";
    const name = "Velmi dlouhý název společnosti pro testování s.r.o.";
    const s = ok(spayd({ iban: CZ_IBAN, amount: bd("1"), message, recipientName: name }));
    const msg = /MSG:([^*]*)/.exec(s)?.[1] ?? "";
    const rn = /RN:([^*]*)/.exec(s)?.[1] ?? "";
    expect(msg).toBe("PLATBA ZA GRAFICKÉ PRÁCE A TISKOVOU PŘÍPRAVU ODBORNÉ");
    expect(msg.length).toBeLessThanOrEqual(60);
    expect(rn).toBe("VELMI DLOUHÝ NÁZEV SPOLEČNOSTI PRO");
    expect(rn.length).toBeLessThanOrEqual(35);
  });

  test("truncation counts escapes, so the escaped value still fits", () => {
    const s = ok(spayd({ iban: CZ_IBAN, amount: bd("1"), message: "*".repeat(30) }));
    const msg = /MSG:(.*)$/.exec(s)?.[1] ?? "";
    expect(msg).toBe("%2A".repeat(20));
  });

  test("rounds amount half away from zero; rejects zero, negative and above 9,999,999.99", () => {
    expect(ok(spayd({ iban: CZ_IBAN, amount: bd("10.005") }))).toContain("*AM:10.01*");
    expect(issue(spayd({ iban: CZ_IBAN, amount: bd("0") }))?.path).toEqual(["amount"]);
    expect(issue(spayd({ iban: CZ_IBAN, amount: bd("-5") }))?.path).toEqual(["amount"]);
    expect(issue(spayd({ iban: CZ_IBAN, amount: bd("10000000") }))?.path).toEqual(["amount"]);
    expect(ok(spayd({ iban: CZ_IBAN, amount: bd("9999999.99") }))).toContain("*AM:9999999.99*");
  });

  test("invalid IBAN checksum, BIC or symbols are Invalid", () => {
    expect(issue(spayd({ iban: "CZ6508000000192000145398", amount: bd("1") }))).toEqual({
      path: ["iban"],
      code: "request.malformed",
    });
    expect(issue(spayd({ iban: CZ_IBAN, bic: "XX", amount: bd("1") }))?.path).toEqual(["bic"]);
    expect(issue(spayd({ iban: CZ_IBAN, amount: bd("1"), variableSymbol: "12345678901" }))).toEqual(
      { path: ["variableSymbol"], code: "qr.field_too_long", params: { max: "10" } },
    );
    expect(issue(spayd({ iban: CZ_IBAN, amount: bd("1"), variableSymbol: "12a" }))?.code).toBe(
      "request.malformed",
    );
  });
});

describe("epc", () => {
  const base = {
    iban: "DE89 3704 0044 0532 0130 00",
    beneficiaryName: "Ateliér Kalný s.r.o.",
    amount: bd("1960"),
  };

  test("line structure: BCD/002/1/SCT/BIC/name/IBAN/amount/purpose/reference/text", () => {
    const p = ok(epc({ ...base, bic: "COBADEFFXXX", remittance: { text: "Invoice 2026-0042" } }));
    expect(p.split("\n")).toEqual([
      "BCD",
      "002",
      "1",
      "SCT",
      "COBADEFFXXX",
      "Ateliér Kalný s.r.o.",
      "DE89370400440532013000",
      "EUR1960.00",
      "",
      "",
      "Invoice 2026-0042",
    ]);
  });

  test("BIC optional in 002; structured reference drops trailing empty text line", () => {
    const p = ok(epc({ ...base, remittance: { reference: "RF18 5390 0754 7034" } }));
    expect(p).toBe(
      "BCD\n002\n1\nSCT\n\nAteliér Kalný s.r.o.\nDE89370400440532013000\nEUR1960.00\n\nRF18539007547034",
    );
  });

  test("limits: name 70 and text 140 truncate, reference over 35 and amount range reject", () => {
    const long = ok(
      epc({
        ...base,
        beneficiaryName: `${"Name ".repeat(20)}`,
        remittance: { text: "x ".repeat(100) },
      }),
    ).split("\n");
    expect([...(long[5] ?? "")].length).toBeLessThanOrEqual(70);
    expect((long[10] ?? "").length).toBeLessThanOrEqual(140);
    expect(issue(epc({ ...base, remittance: { reference: "R".repeat(36) } }))).toEqual({
      path: ["remittance", "reference"],
      code: "qr.field_too_long",
      params: { max: "35" },
    });
    expect(issue(epc({ ...base, amount: bd("0.001"), remittance: { text: "" } }))?.path).toEqual([
      "amount",
    ]);
    expect(
      issue(epc({ ...base, amount: bd("1000000000"), remittance: { text: "" } }))?.path,
    ).toEqual(["amount"]);
    expect(ok(epc({ ...base, amount: bd("0.01"), remittance: { text: "" } }))).toContain(
      "\nEUR0.01",
    );
  });

  test("whole payload stays within 331 bytes; empty name and bad IBAN are Invalid", () => {
    const p = ok(
      epc({
        ...base,
        bic: "COBADEFFXXX",
        beneficiaryName: "Ž".repeat(70),
        remittance: { text: "Ř".repeat(140) },
      }),
    );
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(331);
    expect(issue(epc({ ...base, beneficiaryName: "  ", remittance: { text: "" } }))?.path).toEqual([
      "beneficiaryName",
    ]);
    expect(issue(epc({ ...base, iban: "DE00", remittance: { text: "" } }))?.path).toEqual(["iban"]);
  });
});

describe("forDocument (rule D12)", () => {
  const source: QrSource = {
    kind: "invoice",
    status: "issued",
    currency: "CZK",
    amount: bd("58100"),
    bankAccount: { iban: CZ_IBAN, bic: null },
    recipientName: "Ateliér Kalný s.r.o.",
    message: "Faktura 2026-0042",
    variableSymbol: "20260042",
    dueOn: "2026-11-16" as IsoDate,
  };

  test("CZK picks SPAYD, EUR picks EPC", () => {
    expect(ok(forDocument(source))?.format).toBe("spayd");
    expect(ok(forDocument(source))?.payload).toContain("X-VS:20260042");
    const eur = ok(forDocument({ ...source, currency: "EUR" }));
    expect(eur?.format).toBe("epc");
    expect(eur?.payload.startsWith("BCD\n002\n1\nSCT\n")).toBe(true);
  });

  test("null for other currencies, no IBAN, credit notes, PTDs, cancelled, nothing to pay", () => {
    expect(ok(forDocument({ ...source, currency: "USD" }))).toBeNull();
    expect(ok(forDocument({ ...source, bankAccount: null }))).toBeNull();
    expect(ok(forDocument({ ...source, bankAccount: { iban: null } }))).toBeNull();
    expect(ok(forDocument({ ...source, kind: "credit_note" }))).toBeNull();
    expect(ok(forDocument({ ...source, kind: "payment_tax_document" }))).toBeNull();
    expect(ok(forDocument({ ...source, status: "cancelled" }))).toBeNull();
    expect(ok(forDocument({ ...source, amount: bd("0") }))).toBeNull();
    expect(ok(forDocument({ ...source, kind: "proforma", status: "draft" }))?.format).toBe("spayd");
  });

  test("an invalid IBAN surfaces as Invalid", () => {
    expect(Result.isFailure(forDocument({ ...source, bankAccount: { iban: "CZ00" } }))).toBe(true);
  });
});

describe("toSvg", () => {
  const payload = "SPD*1.0*ACC:CZ6508000000192000145399*AM:480.50*CC:CZK";

  test("deterministic for the same payload", () => {
    expect(toSvg(payload)).toBe(toSvg(payload));
    expect(toSvg(payload)).not.toBe(toSvg(`${payload}*X-VS:1`));
  });

  test("encodes the qrcode module matrix at error correction M with a 4-module quiet zone", () => {
    const { modules } = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const svg = toSvg(payload);
    const full = modules.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${full} ${full}"`);
    let dark = 0;
    for (let r = 0; r < modules.size; r++)
      for (let c = 0; c < modules.size; c++) dark += modules.get(r, c) ? 1 : 0;
    const d = /<path fill="#000000" d="([^"]*)"/.exec(svg)?.[1] ?? "";
    const covered = [...d.matchAll(/h(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(covered).toBe(dark);
    expect(d.startsWith("M4 4h7")).toBe(true); // finder pattern top row
  });

  test("options: margin, colour, accessible title; rejects bad input", () => {
    const svg = toSvg(payload, { margin: 0, color: "#09090B", title: 'QR "Platba"' });
    expect(svg).toContain('fill="#09090B"');
    expect(svg).toContain('aria-label="QR &quot;Platba&quot;"');
    expect(svg).toContain('d="M0 0h7');
    expect(() => toSvg("")).toThrow(RangeError);
    expect(() => toSvg(payload, { color: "red;" })).toThrow(RangeError);
  });

  test("isValidIban checks mod 97", () => {
    expect(isValidIban(CZ_IBAN)).toBe(true);
    expect(isValidIban("CZ6508000000192000145398")).toBe(false);
  });
});

/** Builds an IBAN with correct mod-97 check digits for any BBAN, valid length or not. */
const withCheckDigits = (country: string, bban: string): string => {
  const digits = [...`${bban}${country}00`]
    .map((ch) => (ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch))
    .join("");
  let r = 0;
  for (const d of digits) r = (r * 10 + Number(d)) % 97;
  return `${country}${String(98 - r).padStart(2, "0")}${bban}`;
};

describe("council regressions", () => {
  test("checksum-valid IBANs of the wrong registered length or BBAN shape are rejected", () => {
    const short = withCheckDigits("CZ", "0800000019200014539"); // 23 chars
    const long = withCheckDigits("CZ", "080000001920001453999"); // 25 chars
    const letters = withCheckDigits("CZ", "08000000192000145A99"); // CZ BBAN is numeric
    const unknown = withCheckDigits("ZZ", "12345678901234567890");
    for (const iban of [short, long, letters, unknown]) {
      expect(isValidIban(iban)).toBe(false);
      expect(issue(spayd({ iban, amount: bd("1") }))?.path).toEqual(["iban"]);
      expect(
        issue(epc({ iban, beneficiaryName: "X", amount: bd("1"), remittance: { text: "" } }))?.path,
      ).toEqual(["iban"]);
    }
    expect(isValidIban(withCheckDigits("CZ", "08000000192000145399"))).toBe(true);
  });

  test("EPC requires a BIC outside the EEA and accepts it when given", () => {
    for (const iban of ["CH9300762011623852957", "GB82WEST12345698765432"]) {
      const input = { iban, beneficiaryName: "X", amount: bd("1"), remittance: { text: "t" } };
      expect(issue(epc(input))).toEqual({
        path: ["bic"],
        code: "request.malformed",
        params: { reason: "required_outside_eea" },
      });
      expect(ok(epc({ ...input, bic: "UBSWCHZH80A" })).split("\n")[4]).toBe("UBSWCHZH80A");
    }
  });

  test("EPC rejects an empty or control-character structured reference", () => {
    const base = { iban: CZ_IBAN, beneficiaryName: "X", amount: bd("1") };
    expect(issue(epc({ ...base, remittance: { reference: "   " } }))?.path).toEqual([
      "remittance",
      "reference",
    ]);
    expect(issue(epc({ ...base, remittance: { reference: "RF18\u0007" } }))?.code).toBe(
      "request.malformed",
    );
  });
});

describe("review regressions", () => {
  test("registered BBAN formats are enforced for supported countries", () => {
    expect(isValidIban("NL7112345678901234")).toBe(false); // NL BBAN is 4 letters + 10 digits
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isValidIban(withCheckDigits("GB", "1234123456987654321"))).toBe(false);
    expect(issue(spayd({ iban: "NL7112345678901234", amount: bd("1") }))?.path).toEqual(["iban"]);
  });
});
