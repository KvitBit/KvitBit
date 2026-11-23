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

describe("review round 2 regressions", () => {
  test("every registry country's BBAN format applies: AD bank code must be digits", () => {
    const bad = "AD78A0012030200359100100"; // valid checksum, letter in a digit position
    const good = "AD1200012030200359100100"; // SWIFT registry example
    expect(isValidIban(bad)).toBe(false);
    expect(issue(spayd({ iban: bad, amount: bd("1") }))?.path).toEqual(["iban"]);
    expect(
      issue(
        epc({
          iban: bad,
          bic: "BACAADADXXX",
          beneficiaryName: "X",
          amount: bd("1"),
          remittance: { text: "" },
        }),
      )?.path,
    ).toEqual(["iban"]);
    expect(ok(spayd({ iban: good, amount: bd("1") }))).toContain("ACC:AD1200012030200359100100*");
    expect(
      ok(
        epc({
          iban: good,
          bic: "BACAADADXXX",
          beneficiaryName: "X",
          amount: bd("1"),
          remittance: { text: "t" },
        }),
      ),
    ).toContain("\nAD1200012030200359100100\n");
  });

  test("SWIFT registry example IBANs are all accepted (BR bank code may hold letters)", () => {
    const examples =
      "AD1200012030200359100100 AE070331234567890123456 AL47212110090000000235698741 AZ21NABZ00000000137010001944 BA391290079401028494 BE68539007547034 BG80BNBG96611020345678 BH67BMAG00001299123456 BR1800360305000010009795493C1 BR6699999A03000010009795493C1 AT611904300234573201 CH9300762011623852957 CR05015202001026284066 CY17002001280000001200527600 DE89370400440532013000 DK5000400440116243 DO28BAGR00000001212453611324 EE382200221020145685 EG380019000500000000263180002 ES9121000418450200051332 FI2112345600000785 FO6264600001631634 FR1420041010050500013M02606 GB29NWBK60161331926819 GE29NB0000000101904917 GI75NWBK000000007099453 GL8964710001000206 GR1601101250000000012300695 GT82TRAJ01020000001210029690 HR1210010051863000160 HU42117730161111101800000000 IE29AIBK93115212345678 IL620108000000099999999 IQ98NBIQ850123456789012 IS140159260076545510730339 IT60X0542811101000000123456 JO94CBJO0010000000000131000302 KW81CBKU0000000000001234560101 KZ86125KZT5004100100 LB62099900000001001901229114 LC55HEMM000100010012001200023015 LI21088100002324013AA LT121000011101001000 LU280019400644750000 LV80BANK0000435195001 MC5811222000010123456789030 MD24AG000225100013104168 ME25505000012345678951 MK07250120000058984 MR1300020001010000123456753 MT84MALT011000012345MTLCAST001S MU17BOMM0101101030300200000MUR NL91ABNA0417164300 NO9386011117947 PK36SCBL0000001123456702 PL61109010140000071219812874 PS92PALS000000000400123456702 PT50000201231234567890154 QA58DOHB00001234567890ABCDEFG RO49AAAA1B31007593840000 RS35260005601001611379 SA0380000000608010167519 SC18SSCB11010000000000001497USD SE4550000000058398257466 SI56263300012039086 SK3112000000198742637541 SM86U0322509800000000270100 ST68000100010051845310112 SV62CENR00000000000000700025 TL380080012345678910157 TN5910006035183598478831 TR330006100519786457841326 UA213223130000026007233566001 VA59001123000012345678 VG96VPVG0000012345678901 XK051212012345678906 BY13NBRB3600900000002Z00AB00 LY83002048000020100120361 SD2129010501234001 BI4210000100010000332045181 DJ2100010000000154000100186 RU0304452522540817810538091310419 SO211000001001000100141 YE15CBYE0001018861234567891234 NI45BAPR00000013000003558124 MN121234123456789123 FK88SC123456789012 OM810180000001299123456 HN88CABF00000000000250005469 CZ6508000000192000145399".split(
        " ",
      );
    expect(examples.filter((iban) => !isValidIban(iban))).toEqual([]);
    const br = "BR6699999A03000010009795493C1";
    expect(ok(spayd({ iban: br, amount: bd("1") }))).toContain(`ACC:${br}*`);
    expect(
      ok(
        epc({
          iban: br,
          bic: "BOFABRSPXXX",
          beneficiaryName: "X",
          amount: bd("1"),
          remittance: { text: "t" },
        }),
      ),
    ).toContain(`\n${br}\n`);
  });
});
