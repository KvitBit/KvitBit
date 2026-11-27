import { describe, expect, test } from "bun:test";
import type { VatTreatment } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import { StatutoryText } from "../../src/engines";

const notes = (
  input: Partial<Parameters<typeof StatutoryText.notes>[0]> & {
    treatments?: ReadonlySet<VatTreatment>;
  },
) =>
  EffectArray.map(
    StatutoryText.notes({
      kind: "invoice",
      regime: "vat_payer",
      treatments: new Set(),
      issuerRegisterEntry: null,
      language: "cs",
      ...input,
    }),
    (n) => [n.code, n.text],
  );

describe("StatutoryText.title", () => {
  test.each([
    ["invoice", true, "cs", "Faktura – daňový doklad"],
    ["invoice", true, "en", "Invoice – tax document"],
    ["invoice", false, "cs", "Faktura"],
    ["proforma", true, "cs", "Zálohová faktura"],
    ["proforma", false, "en", "Proforma invoice"],
    ["payment_tax_document", true, "cs", "Daňový doklad k přijaté platbě"],
    ["credit_note", true, "cs", "Opravný daňový doklad"],
    ["credit_note", true, "en", "Credit note"],
  ] as const)("%s taxDocument=%p %s", (kind, taxDocument, language, text) => {
    expect(StatutoryText.title({ kind, regime: "vat_payer", taxDocument, language })).toBe(text);
  });
});

describe("StatutoryText.notes", () => {
  test("reverse charge uses the exact §29(2)(c) wording", () => {
    expect(notes({ treatments: new Set(["standard", "reverse_charge"]) })).toEqual([
      ["reverse_charge", "Daň odvede zákazník."],
    ]);
    expect(notes({ treatments: new Set(["reverse_charge"]), language: "en" })).toEqual([
      ["reverse_charge", "Reverse charge"],
    ]);
  });

  test("proforma disclaimer, regime line, exemption, then the §435 register line", () => {
    expect(
      notes({
        kind: "proforma",
        regime: "non_vat_payer",
        treatments: new Set(["outside_scope"]),
        issuerRegisterEntry: " Spisová značka C 12345 vedená u Městského soudu v Praze ",
      }),
    ).toEqual([
      ["proforma_not_tax_document", "Nejedná se o daňový doklad."],
      ["not_vat_payer", "Dodavatel není plátcem DPH."],
      ["commercial_register", "Spisová značka C 12345 vedená u Městského soudu v Praze"],
    ]);
  });

  test("identified person (domestic) and exempt intra-EU goods", () => {
    expect(
      notes({
        regime: "identified_person",
        treatments: new Set(["outside_scope"]),
        language: "en",
      }),
    ).toEqual([
      [
        "identified_person",
        "The supplier is an identified person for Czech VAT purposes and is not a VAT payer.",
      ],
    ]);
    expect(notes({ treatments: new Set(["exempt_intra_eu_goods"]) })).toEqual([
      ["exempt_intra_eu_goods", "Osvobozeno od DPH podle § 64 zákona č. 235/2004 Sb."],
    ]);
  });

  test("a plain domestic VAT invoice has no notes", () => {
    expect(
      notes({ treatments: new Set(["standard", "reduced"]), issuerRegisterEntry: "  " }),
    ).toEqual([]);
  });
});
