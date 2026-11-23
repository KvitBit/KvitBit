/**
 * StatutoryText (core-ports 5.4): document titles and statutory notes, fixed data in cs and en.
 * Wording follows docs/research/czech-invoicing-specs.md §1: "Daň odvede zákazník." is the
 * exact §29(2)(c) text and "Reverse charge" the Directive's Art. 226(11a) wording; the other
 * Czech lines are the recommended clarity texts; English lines are product translations.
 */
import type {
  DocumentKind,
  Locale,
  StatutoryCode,
  StatutoryNote,
  TaxRegime,
  VatTreatment,
} from "@kvitbit/domain/contract";

export type { StatutoryNote };

/** Note codes (the domain's `StatutoryCode` is an opaque placeholder; these are its values). */
export const STATUTORY_CODES = [
  "proforma_not_tax_document",
  "not_vat_payer",
  "identified_person",
  "reverse_charge",
  "exempt_intra_eu_goods",
  "commercial_register",
] as const;
export type StatutoryCodeValue = (typeof STATUTORY_CODES)[number];

type Text = { readonly cs: string; readonly en: string };

const NOTES: Readonly<Record<Exclude<StatutoryCodeValue, "commercial_register">, Text>> = {
  proforma_not_tax_document: {
    cs: "Nejedná se o daňový doklad.",
    en: "This is not a tax document.",
  },
  not_vat_payer: { cs: "Dodavatel není plátcem DPH.", en: "The supplier is not a VAT payer." },
  identified_person: {
    cs: "Dodavatel je identifikovanou osobou k DPH; není plátcem DPH.",
    en: "The supplier is an identified person for Czech VAT purposes and is not a VAT payer.",
  },
  reverse_charge: { cs: "Daň odvede zákazník.", en: "Reverse charge" },
  exempt_intra_eu_goods: {
    cs: "Osvobozeno od DPH podle § 64 zákona č. 235/2004 Sb.",
    en: "VAT-exempt intra-Community supply under Article 138 of Directive 2006/112/EC.",
  },
};

const code = (value: StatutoryCodeValue): StatutoryCode => value as unknown as StatutoryCode;
const note = (value: StatutoryCodeValue, text: string): StatutoryNote => ({
  code: code(value),
  text,
});

const TITLES: Readonly<Record<DocumentKind, { readonly tax: Text; readonly plain: Text }>> = {
  invoice: {
    tax: { cs: "Faktura – daňový doklad", en: "Invoice – tax document" },
    plain: { cs: "Faktura", en: "Invoice" },
  },
  proforma: {
    tax: { cs: "Zálohová faktura", en: "Proforma invoice" },
    plain: { cs: "Zálohová faktura", en: "Proforma invoice" },
  },
  payment_tax_document: {
    tax: { cs: "Daňový doklad k přijaté platbě", en: "Tax document for a received payment" },
    plain: { cs: "Doklad k přijaté platbě", en: "Receipt for a received payment" },
  },
  credit_note: {
    tax: { cs: "Opravný daňový doklad", en: "Credit note" },
    plain: { cs: "Opravný doklad", en: "Credit note" },
  },
};

/** Title printed on the document; a Proforma is never a tax document. */
export const title = (input: {
  readonly kind: DocumentKind;
  readonly regime: TaxRegime;
  readonly taxDocument: boolean;
  readonly language: Locale;
}): string => {
  const entry = TITLES[input.kind];
  return (input.taxDocument && input.kind !== "proforma" ? entry.tax : entry.plain)[input.language];
};

/**
 * Notes in print order: the Proforma disclaimer, the regime line, one line per non-rated
 * treatment present, then the §435 commercial register line (verbatim, both languages).
 */
export const notes = (input: {
  readonly kind: DocumentKind;
  readonly regime: TaxRegime;
  readonly treatments: ReadonlySet<VatTreatment>;
  readonly issuerRegisterEntry: string | null;
  readonly language: Locale;
}): ReadonlyArray<StatutoryNote> => {
  const out: Array<StatutoryNote> = [];
  const add = (value: Exclude<StatutoryCodeValue, "commercial_register">) =>
    out.push(note(value, NOTES[value][input.language]));
  if (input.kind === "proforma") add("proforma_not_tax_document");
  if (input.regime === "non_vat_payer") add("not_vat_payer");
  if (input.regime === "identified_person" && input.treatments.has("outside_scope")) {
    add("identified_person");
  }
  if (input.treatments.has("reverse_charge")) add("reverse_charge");
  if (input.treatments.has("exempt_intra_eu_goods")) add("exempt_intra_eu_goods");
  const register = input.issuerRegisterEntry?.trim();
  if (register) out.push(note("commercial_register", register));
  return out;
};

export const StatutoryText = { title, notes } as const;
