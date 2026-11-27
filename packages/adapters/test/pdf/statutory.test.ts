import { describe, expect, test } from "bun:test";
import type { VatTreatment } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import { statutoryNotes, statutoryTitle } from "../../src/pdf";

const notes = (
  input: Partial<Omit<Parameters<typeof statutoryNotes>[0], "treatments">> & {
    treatments?: Array<VatTreatment>;
  },
) =>
  Arr.map(
    statutoryNotes({
      kind: input.kind ?? "invoice",
      regime: input.regime ?? "vat_payer",
      treatments: new Set(input.treatments ?? ["standard"]),
      issuerRegisterEntry: input.issuerRegisterEntry ?? null,
      language: input.language ?? "cs",
    }),
    (n) => `${n.code}: ${n.text}`,
  );

describe("statutoryTitle", () => {
  test("tax document flag selects the tax wording", () => {
    const title = (
      kind: Parameters<typeof statutoryTitle>[0]["kind"],
      taxDocument: boolean,
      final = false,
    ) => statutoryTitle({ kind, taxDocument, final, language: "cs" });
    expect(title("invoice", true)).toBe("Faktura – daňový doklad");
    expect(title("invoice", false)).toBe("Faktura");
    expect(title("invoice", true, true)).toBe("Faktura – vyúčtování záloh");
    expect(title("proforma", true)).toBe("Zálohová faktura");
    expect(title("credit_note", true)).toBe("Opravný daňový doklad");
    expect(title("payment_tax_document", false)).toBe("Potvrzení o přijaté platbě");
    expect(
      statutoryTitle({ kind: "credit_note", taxDocument: false, final: false, language: "en" }),
    ).toBe("Credit note");
  });
});

describe("statutoryNotes", () => {
  test("one regime note per Tax Regime", () => {
    expect(notes({ regime: "vat_payer" })).toEqual([]);
    expect(notes({ regime: "non_vat_payer", treatments: ["outside_scope"] })).toEqual([
      "regime.non_vat_payer: Dodavatel není plátcem DPH.",
    ]);
    expect(
      notes({ regime: "identified_person", treatments: ["outside_scope"], language: "en" }),
    ).toEqual([
      "regime.identified_person: The supplier is an identified person for Czech VAT purposes and is not a VAT payer.",
    ]);
  });

  test("treatment notes, proforma note and §435 register entry, in print order", () => {
    expect(
      notes({
        kind: "proforma",
        treatments: ["reverse_charge", "exempt_intra_eu_goods"],
        issuerRegisterEntry: "Zapsána v OR u Městského soudu v Praze, oddíl C, vložka 1.",
      }),
    ).toEqual([
      "not_tax_document: Nejedná se o daňový doklad.",
      "reverse_charge: Daň odvede zákazník.",
      "exempt_intra_eu_goods: Osvobozeno od DPH podle § 64 zákona č. 235/2004 Sb.",
      "register_entry: Zapsána v OR u Městského soudu v Praze, oddíl C, vložka 1.",
    ]);
    expect(notes({ treatments: ["reverse_charge"], language: "en" })).toEqual([
      "reverse_charge: Reverse charge.",
    ]);
    expect(notes({ issuerRegisterEntry: "  " })).toEqual([]);
  });
});
