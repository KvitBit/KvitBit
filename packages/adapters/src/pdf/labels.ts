/** Fixed cs/en chrome strings for the PDF templates (approved mockups screens 23 and 24). */
import type { Locale, PaymentMethod, VatTreatment } from "@kvitbit/domain";

export interface Labels {
  readonly supplier: string;
  readonly customer: string;
  readonly from: string;
  readonly billedTo: string;
  readonly issuedOn: string;
  readonly taxPoint: string;
  readonly issuedTaxPoint: string;
  readonly dueOn: string;
  readonly due: string;
  readonly paid: string;
  readonly paymentMethod: string;
  readonly bankAccount: string;
  readonly ibanBic: string;
  readonly variableSymbol: string;
  readonly orderNumber: string;
  readonly companyId: string;
  readonly vatId: string;
  readonly euVatId: string;
  readonly number: string;
  readonly draftNumber: string;
  readonly description: string;
  readonly descriptionShort: string;
  readonly quantity: string;
  readonly quantityShort: string;
  readonly unitPrice: string;
  readonly vat: string;
  readonly total: string;
  readonly vatRate: string;
  readonly vatBase: string;
  readonly vatGross: string;
  readonly vatSum: string;
  readonly subtotal: string;
  readonly netSubtotal: string;
  readonly vatTotal: string;
  readonly vatAt: string;
  readonly suppliesTotal: string;
  readonly lessDeposit: string;
  readonly rounding: string;
  readonly grandDue: string;
  readonly grandPaid: string;
  readonly grandCredit: string;
  readonly grandCreditShort: string;
  readonly grandRemaining: string;
  readonly grandRemainingShort: string;
  readonly qrSpayd: string;
  readonly qrEpc: string;
  readonly qrSpaydCard: string;
  readonly qrEpcCard: string;
  readonly watermark: string;
  readonly thanks: string;
  readonly cnb: string;
  readonly manualRate: string;
  readonly vatInCzk: string;
  readonly generated: string;
  readonly paymentMethods: Readonly<Record<PaymentMethod, string>>;
  readonly treatments: Readonly<Record<Exclude<VatTreatment, "standard" | "reduced">, string>>;
  readonly treatmentsLong: Readonly<Record<Exclude<VatTreatment, "standard" | "reduced">, string>>;
  readonly refPayment: (receivedOn: string, proforma: string | null) => string;
  readonly refCorrection: (original: string, issuedOn: string, reason: string) => string;
  readonly refSettlement: (proformas: string, ptds: string) => string;
  readonly fxDisclosure: (fixingDate: string | null, pair: string) => string;
  /** Non-tax documents: the conversion rate without VAT wording. */
  readonly fxRate: (fixingDate: string | null, pair: string) => string;
}

export const LABELS: Readonly<Record<Locale, Labels>> = {
  cs: {
    supplier: "Dodavatel",
    customer: "Odběratel",
    from: "Vystavil",
    billedTo: "Pro klienta",
    issuedOn: "Datum vystavení",
    taxPoint: "DUZP",
    issuedTaxPoint: "Vystaveno / DUZP",
    dueOn: "Datum splatnosti",
    due: "Splatnost",
    paid: "Uhrazeno",
    paymentMethod: "Forma úhrady",
    bankAccount: "Bankovní účet",
    ibanBic: "IBAN / BIC",
    variableSymbol: "Variabilní symbol",
    orderNumber: "Objednávka",
    companyId: "IČO",
    vatId: "DIČ",
    euVatId: "DIČ",
    number: "č.",
    draftNumber: "Návrh",
    description: "Popis položky",
    descriptionShort: "Položka",
    quantity: "Množství",
    quantityShort: "Mn.",
    unitPrice: "Cena / j.",
    vat: "DPH",
    total: "Celkem",
    vatRate: "Sazba DPH",
    vatBase: "Základ",
    vatGross: "Celkem",
    vatSum: "Celkem",
    subtotal: "Celkem bez DPH",
    netSubtotal: "Základ DPH",
    vatTotal: "DPH celkem",
    vatAt: "DPH",
    suppliesTotal: "Celkem za plnění",
    lessDeposit: "Odpočet zálohy",
    rounding: "Zaokrouhlení",
    grandDue: "Celkem k úhradě",
    grandPaid: "Uhrazená záloha",
    grandCredit: "K vrácení odběrateli",
    grandCreditShort: "K vrácení",
    grandRemaining: "Zbývá k úhradě",
    grandRemainingShort: "Zbývá k úhradě",
    qrSpayd: "QR Platba",
    qrEpc: "EPC QR (SEPA)",
    qrSpaydCard: "QR Platba · Bankovní převod",
    qrEpcCard: "EPC QR · SEPA převod",
    watermark: "Návrh",
    thanks: "Děkujeme za spolupráci",
    cnb: "ČNB",
    manualRate: "kurz dodavatele",
    vatInCzk: "DPH v Kč",
    generated: "Vygenerováno",
    paymentMethods: {
      bank_transfer: "Bankovní převod",
      cash: "Hotově",
      card: "Platební kartou",
      other: "Jiná",
    },
    treatments: { reverse_charge: "PDP", exempt_intra_eu_goods: "osvob.", outside_scope: "–" },
    treatmentsLong: {
      reverse_charge: "0 % (přenesení daňové povinnosti)",
      exempt_intra_eu_goods: "0 % (osvobozeno, § 64)",
      outside_scope: "Mimo předmět DPH",
    },
    refPayment: (on, proforma) =>
      proforma === null
        ? `Vystaveno k přijaté platbě ze dne ${on}.`
        : `Vystaveno k přijaté platbě ze dne ${on} podle zálohové faktury č. ${proforma}.`,
    refCorrection: (original, on, reason) =>
      `Oprava k původnímu dokladu č. ${original} ze dne ${on}. Důvod opravy: ${reason}`,
    refSettlement: (proformas, ptds) =>
      ptds === ""
        ? `Vyúčtování zakázky s odpočtem uhrazené zálohy č. ${proformas}.`
        : `Vyúčtování zakázky s odpočtem uhrazené zálohy č. ${proformas} (daňový doklad k platbě č. ${ptds}).`,
    fxDisclosure: (date, pair) =>
      date === null
        ? `Přepočet pro účely DPH kurzem stanoveným dodavatelem: ${pair}.`
        : `Přepočet pro účely DPH dle kurzu ČNB ze dne ${date}: ${pair}.`,
    fxRate: (date, pair) =>
      date === null
        ? `Přepočet kurzem stanoveným dodavatelem: ${pair}.`
        : `Přepočet dle kurzu ČNB ze dne ${date}: ${pair}.`,
  },
  en: {
    supplier: "Supplier",
    customer: "Customer",
    from: "From",
    billedTo: "Billed to",
    issuedOn: "Issue date",
    taxPoint: "Tax point (DUZP)",
    issuedTaxPoint: "Issued / Tax point",
    dueOn: "Due date",
    due: "Due date",
    paid: "Paid",
    paymentMethod: "Payment method",
    bankAccount: "Bank account",
    ibanBic: "IBAN / BIC",
    variableSymbol: "Variable symbol",
    orderNumber: "Purchase order",
    companyId: "Company ID",
    vatId: "VAT ID",
    euVatId: "VAT ID",
    number: "#",
    draftNumber: "Draft",
    description: "Description",
    descriptionShort: "Description",
    quantity: "Qty",
    quantityShort: "Qty",
    unitPrice: "Unit price",
    vat: "VAT",
    total: "Total",
    vatRate: "VAT rate",
    vatBase: "Net base",
    vatGross: "Gross",
    vatSum: "Total",
    subtotal: "Subtotal (excl. VAT)",
    netSubtotal: "Net subtotal",
    vatTotal: "Total VAT",
    vatAt: "VAT",
    suppliesTotal: "Total for supplies",
    lessDeposit: "Less paid deposit",
    rounding: "Rounding",
    grandDue: "Total due",
    grandPaid: "Deposit received",
    grandCredit: "Credit total",
    grandCreditShort: "Credit total",
    grandRemaining: "Remaining balance due",
    grandRemainingShort: "Remaining balance",
    qrSpayd: "QR Platba",
    qrEpc: "EPC QR (SEPA)",
    qrSpaydCard: "QR Platba · Bank transfer",
    qrEpcCard: "EPC QR · SEPA transfer",
    watermark: "Draft",
    thanks: "Thank you for your business",
    cnb: "CNB",
    manualRate: "supplier rate",
    vatInCzk: "VAT in CZK",
    generated: "Generated",
    paymentMethods: { bank_transfer: "Bank transfer", cash: "Cash", card: "Card", other: "Other" },
    treatments: { reverse_charge: "RC", exempt_intra_eu_goods: "exempt", outside_scope: "–" },
    treatmentsLong: {
      reverse_charge: "0% (reverse charge)",
      exempt_intra_eu_goods: "0% (exempt intra-EU supply)",
      outside_scope: "Outside the scope of VAT",
    },
    refPayment: (on, proforma) =>
      proforma === null
        ? `Issued for the payment received on ${on}.`
        : `Issued for the deposit payment received on ${on} against proforma ${proforma}.`,
    refCorrection: (original, on, reason) =>
      `Corrects original invoice ${original} (issued ${on}). Reason: ${reason}`,
    refSettlement: (proformas, ptds) =>
      ptds === ""
        ? `Final invoice deducting paid deposit ${proformas}.`
        : `Final invoice deducting paid deposit ${proformas} (payment tax document ${ptds}).`,
    fxDisclosure: (date, pair) =>
      date === null
        ? `Converted for Czech VAT at the supplier's rate: ${pair}.`
        : `Converted for Czech VAT at the CNB fixing of ${date}: ${pair}.`,
    fxRate: (date, pair) =>
      date === null
        ? `Converted at the supplier's rate: ${pair}.`
        : `Converted at the CNB fixing of ${date}: ${pair}.`,
  },
};
