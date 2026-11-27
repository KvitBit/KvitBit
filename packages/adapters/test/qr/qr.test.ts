import { describe, expect, test } from "bun:test";
import { type Invalid, IsoDate } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { create } from "qrcode";
import { epc, forDocument, isValidIban, type QrSource, spayd, toSvg } from "../../src/qr";

const MESSAGE_FIELD = /MSG:([^*]*)/;
const RECIPIENT_FIELD = /RN:([^*]*)/;
const FINAL_MESSAGE_FIELD = /MSG:(.*)$/;
const SVG_MODULE_PATH = /<path fill="#000000" d="([^"]*)"/;

const bd = BigDecimal.fromStringUnsafe;
const CZ_IBAN = "CZ6508000000192000145399";
const SWISS_IBAN = `CH9300762${Str.padStart(12, "0")(String(11_623_852_957))}`;
const UK_IBAN = Arr.join(["GB82", "WEST", "123456", "98765432"], "");
const INVALID_DUTCH_IBAN = Arr.join(["NL71", "1234", "5678901234"], "");
const DUTCH_IBAN = Arr.join(["NL91", "ABNA", "0417164300"], "");
const ok = <A>(r: Result.Result<A, Invalid>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${r.failure._tag}`);
  return r.success;
};
const issue = <A>(r: Result.Result<A, Invalid>) => {
  if (Result.isSuccess(r)) throw new Error("expected Invalid, got success");
  return r.failure.issues[0];
};

describe("spayd", () => {
  test("minimal payload: header, ACC, AM with two decimals, CC", () => {
    expect(spayd({ iban: CZ_IBAN, amount: bd("480.5") }).pipe(ok)).toBe(
      "SPD*1.0*ACC:CZ6508000000192000145399*AM:480.50*CC:CZK",
    );
  });

  test("known vector with BIC, VS, KS, due date, message and recipient", () => {
    expect(
      spayd({
        iban: "cz65 0800 0000 1920 0014 5399",
        bic: "gibaczpx",
        amount: bd("58100"),
        variableSymbol: "20260042",
        constantSymbol: "0308",
        dueOn: IsoDate.make("2026-11-16"),
        message: "Faktura 2026-0042",
        recipientName: "Ateliér Kalný s.r.o.",
      }).pipe(ok),
    ).toBe(
      Arr.join(
        [
          "SPD",
          "1.0",
          `ACC:${CZ_IBAN}+GIBACZPX`,
          "AM:58100.00",
          "CC:CZK",
          "DT:20261116",
          "MSG:FAKTURA 2026-0042",
          "RN:ATELIÉR KALNÝ S.R.O.",
          "X-VS:20260042",
          "X-KS:0308",
        ],
        "*",
      ),
    );
  });

  test("escapes * as %2A and % as %25 inside values, never in separators", () => {
    const s = spayd({ iban: CZ_IBAN, amount: bd("1"), message: "50% sleva * akce" }).pipe(ok);
    expect(s).toBe("SPD*1.0*ACC:CZ6508000000192000145399*AM:1.00*CC:CZK*MSG:50%25 SLEVA %2A AKCE");
    expect(Str.split(s, "*")).toHaveLength(6);
  });

  test("collapses line breaks and control characters", () => {
    const s = spayd({ iban: CZ_IBAN, amount: bd("1"), message: "a\nb\t\u0007c" }).pipe(ok);
    expect(Str.endsWith("*MSG:A B C")(s)).toBe(true);
  });

  test("truncates overlong message (60) and recipient (35) at a word boundary", () => {
    const message = "Platba za grafické práce a tiskovou přípravu odborné publikace dle objednávky";
    const name = "Velmi dlouhý název společnosti pro testování s.r.o.";
    const s = spayd({ iban: CZ_IBAN, amount: bd("1"), message, recipientName: name }).pipe(ok);
    const msg = MESSAGE_FIELD.exec(s)?.[1] ?? "";
    const rn = RECIPIENT_FIELD.exec(s)?.[1] ?? "";
    expect(msg).toBe("PLATBA ZA GRAFICKÉ PRÁCE A TISKOVOU PŘÍPRAVU ODBORNÉ");
    expect(msg.length).toBeLessThanOrEqual(60);
    expect(rn).toBe("VELMI DLOUHÝ NÁZEV SPOLEČNOSTI PRO");
    expect(rn.length).toBeLessThanOrEqual(35);
  });

  test("truncation counts escapes, so the escaped value still fits", () => {
    const s = spayd({ iban: CZ_IBAN, amount: bd("1"), message: Str.repeat(30)("*") }).pipe(ok);
    const msg = FINAL_MESSAGE_FIELD.exec(s)?.[1] ?? "";
    expect(msg).toBe(Str.repeat(20)("%2A"));
  });

  test("rounds amount half away from zero; rejects zero, negative and above 9,999,999.99", () => {
    expect(spayd({ iban: CZ_IBAN, amount: bd("10.005") }).pipe(ok)).toContain("*AM:10.01*");
    expect(spayd({ iban: CZ_IBAN, amount: bd("0") }).pipe(issue)?.path).toEqual(["amount"]);
    expect(spayd({ iban: CZ_IBAN, amount: bd("-5") }).pipe(issue)?.path).toEqual(["amount"]);
    expect(spayd({ iban: CZ_IBAN, amount: bd("10000000") }).pipe(issue)?.path).toEqual(["amount"]);
    expect(spayd({ iban: CZ_IBAN, amount: bd("9999999.99") }).pipe(ok)).toContain(
      "*AM:9999999.99*",
    );
  });

  test("invalid IBAN checksum, BIC or symbols are Invalid", () => {
    expect(spayd({ iban: "CZ6508000000192000145398", amount: bd("1") }).pipe(issue)).toEqual({
      path: ["iban"],
      code: "request.malformed",
    });
    expect(spayd({ iban: CZ_IBAN, bic: "XX", amount: bd("1") }).pipe(issue)?.path).toEqual(["bic"]);
    expect(
      spayd({ iban: CZ_IBAN, amount: bd("1"), variableSymbol: "12345678901" }).pipe(issue),
    ).toEqual({ path: ["variableSymbol"], code: "qr.field_too_long", params: { max: "10" } });
    expect(spayd({ iban: CZ_IBAN, amount: bd("1"), variableSymbol: "12a" }).pipe(issue)?.code).toBe(
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
    const p = epc({ ...base, bic: "COBADEFFXXX", remittance: { text: "Invoice 2026-0042" } }).pipe(
      ok,
    );
    expect(Str.split(p, "\n")).toEqual([
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
    const p = epc({ ...base, remittance: { reference: "RF18 5390 0754 7034" } }).pipe(ok);
    expect(p).toBe(
      Arr.join(
        [
          "BCD",
          "002",
          "1",
          "SCT",
          "",
          "Ateliér Kalný s.r.o.",
          "DE89370400440532013000",
          "EUR1960.00",
          "",
          Arr.join(["RF", "18", "539007", "547034"], ""),
        ],
        "\n",
      ),
    );
  });

  test("limits: name 70 and text 140 truncate, reference over 35 and amount range reject", () => {
    const long = Str.split(
      epc({
        ...base,
        beneficiaryName: `${Str.repeat(20)("Name ")}`,
        remittance: { text: Str.repeat(100)("x ") },
      }).pipe(ok),
      "\n",
    );
    expect([...(long[5] ?? "")].length).toBeLessThanOrEqual(70);
    expect((long[10] ?? "").length).toBeLessThanOrEqual(140);
    expect(epc({ ...base, remittance: { reference: Str.repeat(36)("R") } }).pipe(issue)).toEqual({
      path: ["remittance", "reference"],
      code: "qr.field_too_long",
      params: { max: "35" },
    });
    expect(
      epc({ ...base, amount: bd("0.001"), remittance: { text: "" } }).pipe(issue)?.path,
    ).toEqual(["amount"]);
    expect(
      epc({ ...base, amount: bd("1000000000"), remittance: { text: "" } }).pipe(issue)?.path,
    ).toEqual(["amount"]);
    expect(epc({ ...base, amount: bd("0.01"), remittance: { text: "" } }).pipe(ok)).toContain(
      "\nEUR0.01",
    );
  });

  test("whole payload stays within 331 bytes; empty name and bad IBAN are Invalid", () => {
    const p = epc({
      ...base,
      bic: "COBADEFFXXX",
      beneficiaryName: Str.repeat(70)("Ž"),
      remittance: { text: Str.repeat(140)("Ř") },
    }).pipe(ok);
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(331);
    expect(
      epc({ ...base, beneficiaryName: "  ", remittance: { text: "" } }).pipe(issue)?.path,
    ).toEqual(["beneficiaryName"]);
    expect(epc({ ...base, iban: "DE00", remittance: { text: "" } }).pipe(issue)?.path).toEqual([
      "iban",
    ]);
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
    dueOn: IsoDate.make("2026-11-16"),
  };

  test("CZK picks SPAYD, EUR picks EPC", () => {
    expect(forDocument(source).pipe(ok)?.format).toBe("spayd");
    expect(forDocument(source).pipe(ok)?.payload).toContain("X-VS:20260042");
    const eur = forDocument({ ...source, currency: "EUR" }).pipe(ok);
    expect(eur?.format).toBe("epc");
    expect(Str.startsWith("BCD\n002\n1\nSCT\n")(eur?.payload ?? "")).toBe(true);
  });

  test("null for other currencies, no IBAN, credit notes, PTDs, cancelled, nothing to pay", () => {
    expect(forDocument({ ...source, currency: "USD" }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, bankAccount: null }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, bankAccount: { iban: null } }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, kind: "credit_note" }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, kind: "payment_tax_document" }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, status: "cancelled" }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, amount: bd("0") }).pipe(ok)).toBeNull();
    expect(forDocument({ ...source, kind: "proforma", status: "draft" }).pipe(ok)?.format).toBe(
      "spayd",
    );
  });

  test("an invalid IBAN surfaces as Invalid", () => {
    const result = forDocument({ ...source, bankAccount: { iban: "CZ00" } });
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("toSvg", () => {
  const payload = "SPD*1.0*ACC:CZ6508000000192000145399*AM:480.50*CC:CZK";

  test("deterministic for the same payload", () => {
    expect(toSvg(payload)).toBe(toSvg(payload));
    expect(toSvg(payload)).not.toBe(toSvg(`${payload}*X-VS:1`));
  });

  test("encodes the qrcode module matrix at error correction M with a 4-module quiet zone", () => {
    const { modules } = create(payload, { errorCorrectionLevel: "M" });
    const svg = toSvg(payload);
    const full = modules.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${full} ${full}"`);
    let dark = 0;
    for (let r = 0; r < modules.size; r++)
      for (let c = 0; c < modules.size; c++) dark += modules.get(r, c) !== 0 ? 1 : 0;
    const d = SVG_MODULE_PATH.exec(svg)?.[1] ?? "";
    const covered = Arr.reduce(Str.matchAll(/h(\d+)/g)(d), 0, (n, m) => n + Number(m[1]));
    expect(covered).toBe(dark);
    expect(Str.startsWith("M4 4h7")(d)).toBe(true); // finder pattern top row
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
  const digits = Arr.join(
    Arr.map(Array.from(`${bban}${country}00`), (ch) =>
      ch >= "A" && ch <= "Z" ? String(Option.getOrElse(Str.charCodeAt(ch, 0), () => 0) - 55) : ch,
    ),
    "",
  );
  let r = 0;
  for (const d of digits) r = (r * 10 + Number(d)) % 97;
  return `${country}${Str.padStart(2, "0")(String(98 - r))}${bban}`;
};

describe("council regressions", () => {
  test("checksum-valid IBANs of the wrong registered length or BBAN shape are rejected", () => {
    const short = withCheckDigits("CZ", "0800000019200014539"); // 23 chars
    const long = withCheckDigits("CZ", "080000001920001453999"); // 25 chars
    const letters = withCheckDigits("CZ", "08000000192000145A99"); // CZ BBAN is numeric
    const unknown = withCheckDigits("ZZ", Str.repeat(2)("1234567890"));
    for (const iban of [short, long, letters, unknown]) {
      expect(isValidIban(iban)).toBe(false);
      expect(spayd({ iban, amount: bd("1") }).pipe(issue)?.path).toEqual(["iban"]);
      expect(
        epc({ iban, beneficiaryName: "X", amount: bd("1"), remittance: { text: "" } }).pipe(issue)
          ?.path,
      ).toEqual(["iban"]);
    }
    expect(isValidIban(withCheckDigits("CZ", "08000000192000145399"))).toBe(true);
  });

  test("EPC requires a BIC outside the EEA and accepts it when given", () => {
    for (const iban of [SWISS_IBAN, UK_IBAN]) {
      const input = { iban, beneficiaryName: "X", amount: bd("1"), remittance: { text: "t" } };
      expect(epc(input).pipe(issue)).toEqual({
        path: ["bic"],
        code: "request.malformed",
        params: { reason: "required_outside_eea" },
      });
      expect(Str.split(epc({ ...input, bic: "UBSWCHZH80A" }).pipe(ok), "\n")[4]).toBe(
        "UBSWCHZH80A",
      );
    }
  });

  test("EPC rejects an empty or control-character structured reference", () => {
    const base = { iban: CZ_IBAN, beneficiaryName: "X", amount: bd("1") };
    expect(epc({ ...base, remittance: { reference: "   " } }).pipe(issue)?.path).toEqual([
      "remittance",
      "reference",
    ]);
    expect(epc({ ...base, remittance: { reference: "RF18\u0007" } }).pipe(issue)?.code).toBe(
      "request.malformed",
    );
  });
});

describe("review regressions", () => {
  test("registered BBAN formats are enforced for supported countries", () => {
    expect(isValidIban(INVALID_DUTCH_IBAN)).toBe(false); // NL BBAN is 4 letters + 10 digits
    expect(isValidIban(DUTCH_IBAN)).toBe(true);
    expect(isValidIban(UK_IBAN)).toBe(true);
    expect(isValidIban(withCheckDigits("GB", Arr.join(["1234", "123456", "987654321"], "")))).toBe(
      false,
    );
    expect(spayd({ iban: INVALID_DUTCH_IBAN, amount: bd("1") }).pipe(issue)?.path).toEqual([
      "iban",
    ]);
  });
});

describe("review round 2 regressions", () => {
  test("every registry country's BBAN format applies: AD bank code must be digits", () => {
    const bad = "AD78A0012030200359100100"; // valid checksum, letter in a digit position
    const good = "AD1200012030200359100100"; // SWIFT registry example
    expect(isValidIban(bad)).toBe(false);
    expect(spayd({ iban: bad, amount: bd("1") }).pipe(issue)?.path).toEqual(["iban"]);
    expect(
      epc({
        iban: bad,
        bic: "BACAADADXXX",
        beneficiaryName: "X",
        amount: bd("1"),
        remittance: { text: "" },
      }).pipe(issue)?.path,
    ).toEqual(["iban"]);
    expect(spayd({ iban: good, amount: bd("1") }).pipe(ok)).toContain(
      "ACC:AD1200012030200359100100*",
    );
    expect(
      epc({
        iban: good,
        bic: "BACAADADXXX",
        beneficiaryName: "X",
        amount: bd("1"),
        remittance: { text: "t" },
      }).pipe(ok),
    ).toContain(`\n${good}\n`);
  });

  test("SWIFT registry example IBANs are all accepted (BR bank code may hold letters)", () => {
    const examples = Str.split(
      "AD1200012030200359100100 AE070331234567890123456 AL47212110090000000235698741 AZ21NABZ00000000137010001944 BA391290079401028494 BE68539007547034 BG80BNBG96611020345678 BH67BMAG00001299123456 BR1800360305000010009795493C1 BR6699999A03000010009795493C1 BR1199999A0300001000979549311 AT611904300234573201 CH9300762011623852957 CR05015202001026284066 CY17002001280000001200527600 DE89370400440532013000 DK5000400440116243 DO28BAGR00000001212453611324 EE382200221020145685 EG380019000500000000263180002 ES9121000418450200051332 FI2112345600000785 FO6264600001631634 FR1420041010050500013M02606 GB29NWBK60161331926819 GE29NB0000000101904917 GI75NWBK000000007099453 GL8964710001000206 GR1601101250000000012300695 GT82TRAJ01020000001210029690 HR1210010051863000160 HU42117730161111101800000000 IE29AIBK93115212345678 IL620108000000099999999 IQ98NBIQ850123456789012 IS140159260076545510730339 IT60X0542811101000000123456 JO94CBJO0010000000000131000302 KW81CBKU0000000000001234560101 KZ86125KZT5004100100 LB62099900000001001901229114 LC55HEMM000100010012001200023015 LI21088100002324013AA LT121000011101001000 LU280019400644750000 LV80BANK0000435195001 MC5811222000010123456789030 MD24AG000225100013104168 ME25505000012345678951 MK07250120000058984 MR1300020001010000123456753 MT84MALT011000012345MTLCAST001S MU17BOMM0101101030300200000MUR NL91ABNA0417164300 NO9386011117947 PK36SCBL0000001123456702 PL61109010140000071219812874 PS92PALS000000000400123456702 PT50000201231234567890154 QA58DOHB00001234567890ABCDEFG RO49AAAA1B31007593840000 RS35260005601001611379 SA0380000000608010167519 SC18SSCB11010000000000001497USD SE4550000000058398257466 SI56263300012039086 SK3112000000198742637541 SM86U0322509800000000270100 ST68000100010051845310112 SV62CENR00000000000000700025 TL380080012345678910157 TN5910006035183598478831 TR330006100519786457841326 UA213223130000026007233566001 VA59001123000012345678 VG96VPVG0000012345678901 XK051212012345678906 BY13NBRB3600900000002Z00AB00 LY83002048000020100120361 SD2129010501234001 BI4210000100010000332045181 DJ2100010000000154000100186 RU0304452522540817810538091310419 SO211000001001000100141 YE15CBYE0001018861234567891234 NI45BAPR00000013000003558124 MN121234123456789123 FK88SC123456789012 OM810180000001299123456 HN88CABF00000000000250005469 CZ6508000000192000145399",
      " ",
    );
    expect(Arr.filter(examples, (iban) => !isValidIban(iban))).toEqual([]);
    const br = "BR6699999A03000010009795493C1";
    expect(spayd({ iban: br, amount: bd("1") }).pipe(ok)).toContain(`ACC:${br}*`);
    expect(
      epc({
        iban: br,
        bic: "BOFABRSPXXX",
        beneficiaryName: "X",
        amount: bd("1"),
        remittance: { text: "t" },
      }).pipe(ok),
    ).toContain(`\n${br}\n`);
  });
});
