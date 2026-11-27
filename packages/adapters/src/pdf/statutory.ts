/**
 * Statutory titles and notes printed on documents (core-ports 5.4, wording from
 * docs/research/czech-invoicing-specs.md section 1). Czech strings marked statutory are the
 * exact legal wording; English strings are product translations, not official ones.
 */

import type { DocumentKind, Locale, TaxRegime, VatTreatment } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

export type StatutoryNoteCode =
  | "not_tax_document"
  | "regime.non_vat_payer"
  | "regime.identified_person"
  | "reverse_charge"
  | "exempt_intra_eu_goods"
  | "register_entry";

export interface PrintedNote {
  readonly code: StatutoryNoteCode | (string & {});
  readonly text: string;
}

type Texts = Readonly<Record<Locale, string>>;

const TITLES: Readonly<Record<string, Texts>> = {
  invoice_tax: { cs: "Faktura – daňový doklad", en: "Invoice – tax document" },
  invoice: { cs: "Faktura", en: "Invoice" },
  final_tax: { cs: "Faktura – vyúčtování záloh", en: "Final settlement invoice" },
  final: { cs: "Vyúčtovací faktura", en: "Final invoice" },
  proforma: { cs: "Zálohová faktura", en: "Proforma invoice" },
  payment_tax_document_tax: { cs: "Daňový doklad k přijaté platbě", en: "Payment tax document" },
  payment_tax_document: { cs: "Potvrzení o přijaté platbě", en: "Payment receipt" },
  credit_note_tax: { cs: "Opravný daňový doklad", en: "Credit note – corrective tax document" },
  credit_note: { cs: "Dobropis", en: "Credit note" },
};

/** Document title. A Final Invoice is an `invoice` that settles advances (`final: true`). */
export const statutoryTitle = (input: {
  readonly kind: DocumentKind;
  readonly taxDocument: boolean;
  readonly final: boolean;
  readonly language: Locale;
}): string => {
  const base = input.kind === "invoice" && input.final ? "final" : input.kind;
  const key = input.kind !== "proforma" && input.taxDocument ? `${base}_tax` : base;
  const texts = TITLES[key] ?? TITLES[base] ?? TITLES["invoice"];
  return texts !== undefined ? texts[input.language] : "";
};

const NOTES: Readonly<Record<Exclude<StatutoryNoteCode, "register_entry">, Texts>> = {
  not_tax_document: {
    cs: "Nejedná se o daňový doklad.",
    en: "This is not a tax document.",
  },
  "regime.non_vat_payer": {
    cs: "Dodavatel není plátcem DPH.",
    en: "The supplier is not a VAT payer.",
  },
  "regime.identified_person": {
    cs: "Dodavatel je identifikovanou osobou k DPH; není plátcem DPH.",
    en: "The supplier is an identified person for Czech VAT purposes and is not a VAT payer.",
  },
  // §29(2)(c) exact wording; "Reverse charge" is Art. 226(11a) of Directive 2006/112/EC.
  reverse_charge: { cs: "Daň odvede zákazník.", en: "Reverse charge." },
  exempt_intra_eu_goods: {
    cs: "Osvobozeno od DPH podle § 64 zákona č. 235/2004 Sb.",
    en: "VAT-exempt intra-Community supply under Article 138 of Directive 2006/112/EC.",
  },
};

/** Notes in print order: tax-document status, regime, line treatments, §435 register entry. */
export const statutoryNotes = (input: {
  readonly kind: DocumentKind;
  readonly regime: TaxRegime;
  readonly treatments: ReadonlySet<VatTreatment>;
  readonly issuerRegisterEntry: string | null;
  readonly language: Locale;
}): ReadonlyArray<PrintedNote> => {
  const codes: Array<Exclude<StatutoryNoteCode, "register_entry">> = [];
  if (input.kind === "proforma") codes.push("not_tax_document");
  if (input.regime === "non_vat_payer") codes.push("regime.non_vat_payer");
  if (input.regime === "identified_person") codes.push("regime.identified_person");
  if (input.treatments.has("reverse_charge")) codes.push("reverse_charge");
  if (input.treatments.has("exempt_intra_eu_goods")) codes.push("exempt_intra_eu_goods");
  const notes: Array<PrintedNote> = Arr.map(codes, (code) => ({
    code,
    text: NOTES[code][input.language],
  }));
  if (input.issuerRegisterEntry !== null && Str.trim(input.issuerRegisterEntry) !== "") {
    notes.push({ code: "register_entry", text: input.issuerRegisterEntry });
  }
  return notes;
};
