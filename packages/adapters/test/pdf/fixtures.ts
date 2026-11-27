/** Sample render models matching the approved mockups (screens 23 and 24). */

import {
  CurrencyCode,
  type DocumentKind,
  IsoDate,
  type Money,
  type VatBucket,
  type VatTreatment,
} from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Str from "effect/String";
import type { DocumentRenderModel, RenderLine, ReportRenderModel } from "../../src/pdf";

export const bd = BigDecimal.fromStringUnsafe;
const d = IsoDate.make;
const money = (amount: string, currency = "CZK"): Money => ({
  amount: bd(amount),
  currency: CurrencyCode.make(currency),
});

const line = (
  description: string,
  quantity: string,
  unitPrice: string,
  treatment: VatTreatment,
  rate: string,
  total: string,
  role: RenderLine["role"] = "item",
): RenderLine => ({
  description,
  quantity: bd(quantity),
  unit: "ks",
  unitPrice: bd(unitPrice),
  treatment,
  ratePercent: bd(rate),
  total: bd(total),
  role,
});

const bucket = (
  treatment: VatTreatment,
  rate: string,
  base: string,
  vat: string,
  gross: string,
  vatCzk: string | null = null,
): VatBucket => ({
  treatment,
  ratePercent: bd(rate),
  base: bd(base),
  vat: bd(vat),
  gross: bd(gross),
  vatCzk: vatCzk === null ? null : bd(vatCzk),
});

export type Variant = "invoice" | "proforma" | "ptd" | "credit" | "final";
export const VARIANTS = [
  "invoice",
  "proforma",
  "ptd",
  "credit",
  "final",
] as const satisfies ReadonlyArray<Variant>;

const KIND = {
  invoice: "invoice",
  proforma: "proforma",
  ptd: "payment_tax_document",
  credit: "credit_note",
  final: "invoice",
} as const satisfies Record<Variant, DocumentKind>;

/** A domestic CZK document from a VAT payer (Classic Czech mockup, "Plátce CZK"). */
export const czkModel = (variant: Variant = "invoice"): DocumentRenderModel => {
  const kind = KIND[variant];
  const items = {
    invoice: [
      line("Architektura designového systému", "1", "42000", "standard", "21", "50820"),
      line("Tisková příprava a odborná publikace", "1", "6500", "reduced", "12", "7280"),
    ],
    proforma: [
      line("Architektura designového systému", "1", "42000", "standard", "21", "50820"),
      line("Tisková příprava a odborná publikace", "1", "6500", "reduced", "12", "7280"),
    ],
    ptd: [line("Přijatá záloha dle Z2026-014", "1", "16528.93", "standard", "21", "20000")],
    credit: [line("Tisková příprava a odborná publikace", "-1", "6500", "reduced", "12", "-7280")],
    final: [
      line("Architektura designového systému", "1", "42000", "standard", "21", "50820"),
      line("Tisková příprava a odborná publikace", "1", "6500", "reduced", "12", "7280"),
      line(
        "Odpočet uhrazené zálohy (Z2026-014 / DDP-2026-007)",
        "1",
        "-16528.93",
        "standard",
        "21",
        "-20000",
        "deduction",
      ),
    ],
  }[variant];
  const totals = {
    invoice: {
      buckets: [
        bucket("standard", "21", "42000", "8820", "50820"),
        bucket("reduced", "12", "6500", "780", "7280"),
      ],
      net: "48500",
      vat: "9600",
      gross: "58100",
    },
    proforma: {
      buckets: [
        bucket("standard", "21", "42000", "8820", "50820"),
        bucket("reduced", "12", "6500", "780", "7280"),
      ],
      net: "48500",
      vat: "9600",
      gross: "58100",
    },
    ptd: {
      buckets: [bucket("standard", "21", "16528.93", "3471.07", "20000")],
      net: "16528.93",
      vat: "3471.07",
      gross: "20000",
    },
    credit: {
      buckets: [bucket("reduced", "12", "-6500", "-780", "-7280")],
      net: "-6500",
      vat: "-780",
      gross: "-7280",
    },
    final: {
      buckets: [
        bucket("standard", "21", "25471.07", "5348.93", "30820"),
        bucket("reduced", "12", "6500", "780", "7280"),
      ],
      net: "31971.07",
      vat: "6128.93",
      gross: "38100",
    },
  }[variant];
  const number = {
    invoice: "2026-0042",
    proforma: "Z2026-014",
    ptd: "DDP-2026-007",
    credit: "ODD-2026-002",
    final: "2026-0045",
  }[variant];
  return {
    kind,
    status: "issued",
    number,
    regime: "vat_payer",
    taxDocument: kind !== "proforma",
    currency: CurrencyCode.make("CZK"),
    issuer: {
      name: "Ateliér Kalný s.r.o.",
      addressLines: ["Křižíkova 185/35", "186 00 Praha 8, Česká republika"],
      companyId: "09482711",
      vatId: "CZ09482711",
      registerEntry: "Zapsána v OR u Městského soudu v Praze, oddíl C, vložka 334912.",
      email: "fakturace@atelierkalny.cz",
      phone: "+420 228 881 420",
    },
    customer: {
      name: "Nová Vlna Studio s.r.o.",
      addressLines: ["Vodičkova 28", "110 00 Praha 1, Česká republika"],
      companyId: "04819204",
      vatId: "CZ04819204",
    },
    dates: {
      issuedOn: d("2026-11-02"),
      taxableSupplyOn: kind === "proforma" ? null : d("2026-11-02"),
      dueOn: d("2026-11-16"),
    },
    paymentMethod: "bank_transfer",
    bankAccount: {
      accountNumber: "2101482910/2010",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
    variableSymbol: Str.replace(/\D/g, "")(number),
    orderNumber: "PO-2026-118",
    note: null,
    reference:
      variant === "ptd"
        ? { kind: "payment", receivedOn: d("2026-11-02"), proformaNumber: "Z2026-014" }
        : variant === "credit"
          ? {
              kind: "correction",
              originalNumber: "2026-0031",
              originalIssuedOn: d("2026-10-14"),
              reason: "Snížení rozsahu tiskové přípravy dle dohody.",
            }
          : variant === "final"
            ? {
                kind: "settlement",
                proformaNumbers: ["Z2026-014"],
                paymentTaxDocumentNumbers: ["DDP-2026-007"],
              }
            : null,
    lines: items,
    totals: {
      buckets: totals.buckets,
      net: money(totals.net),
      vat: money(totals.vat),
      roundingAdjustment: money("0"),
      gross: money(totals.gross),
      vatCzk: null,
    },
    fx: null,
    paymentQr:
      variant === "invoice" || variant === "proforma" || variant === "final"
        ? {
            format: "spayd",
            payload: `SPD*1.0*ACC:CZ6508000000192000145399+GIBACZPX*AM:${totals.gross}.00*CC:CZK*X-VS:${Str.replace(/\D/g, "")(number)}`,
          }
        : null,
    branding: { accentColor: "#1D4ED8", footerText: null, logo: null, stamp: null },
  };
};

/** The same document from a non-VAT payer: no VAT columns, recap or DIČ. */
export const nonVatModel = (variant: Variant = "invoice"): DocumentRenderModel => {
  const m = czkModel(variant);
  const lines = Arr.map(m.lines, (l) => ({
    ...l,
    treatment: "outside_scope" as const,
    ratePercent: bd("0"),
    total: BigDecimal.multiply(l.quantity, l.unitPrice),
  }));
  const gross = Arr.reduce(lines, bd("0"), (a, l) => BigDecimal.sum(a, l.total));
  return {
    ...m,
    regime: "non_vat_payer",
    taxDocument: false,
    issuer: { ...m.issuer, vatId: null },
    lines,
    totals: {
      buckets: [
        bucket("outside_scope", "0", BigDecimal.format(gross), "0", BigDecimal.format(gross)),
      ],
      net: gross.pipe(BigDecimal.format, money),
      vat: money("0"),
      roundingAdjustment: money("0"),
      gross: gross.pipe(BigDecimal.format, money),
      vatCzk: null,
    },
  };
};

/** An identified person invoicing a domestic customer: outside the scope of VAT. */
export const identifiedPersonModel = (): DocumentRenderModel => ({
  ...nonVatModel("invoice"),
  regime: "identified_person",
  issuer: { ...czkModel().issuer },
});

/** EU B2B services in EUR under reverse charge with the CNB fixing ("EU EUR + FX"). */
export const eurModel = (variant: Variant = "invoice"): DocumentRenderModel => {
  const m = czkModel(variant);
  return {
    ...m,
    currency: CurrencyCode.make("EUR"),
    customer: {
      name: "Nordic Craft GmbH",
      addressLines: ["Torstraße 114", "10119 Berlin, Germany"],
      companyId: null,
      vatId: "DE298410221",
    },
    lines: [
      line("Design system architecture", "1", "1700", "reverse_charge", "0", "1700"),
      line("Print production & editorial book", "1", "260", "reverse_charge", "0", "260"),
    ],
    totals: {
      buckets: [bucket("reverse_charge", "0", "1960", "0", "1960", "0")],
      net: money("1960", "EUR"),
      vat: money("0", "EUR"),
      roundingAdjustment: money("0", "EUR"),
      gross: money("1960", "EUR"),
      vatCzk: money("0"),
    },
    fx: { rate: bd("25.24"), quantity: 1, fixingDate: d("2026-11-02"), source: "cnb" },
    bankAccount: { accountNumber: null, iban: "DE89370400440532013000", bic: "COBADEFFXXX" },
    paymentQr: {
      format: "epc",
      payload:
        "BCD\n002\n1\nSCT\nCOBADEFFXXX\nAteliér Kalný s.r.o.\nDE89370400440532013000\nEUR1960.00",
    },
  };
};

/** EUR at standard rate, so the CZK VAT per bucket is non-zero. */
export const eurRatedModel = (): DocumentRenderModel => {
  const m = eurModel();
  return {
    ...m,
    customer: czkModel().customer,
    lines: [
      line("Design system architecture", "1", "1700", "standard", "21", "2057"),
      line("Print production", "1", "260", "reduced", "12", "291.2"),
    ],
    totals: {
      buckets: [
        bucket("standard", "21", "1700", "357", "2057", "9010.68"),
        bucket("reduced", "12", "260", "31.2", "291.2", "787.49"),
      ],
      net: money("1960", "EUR"),
      vat: money("388.2", "EUR"),
      roundingAdjustment: money("0", "EUR"),
      gross: money("2348.2", "EUR"),
      vatCzk: money("9798.17"),
    },
  };
};

export const reportModel = (): ReportRenderModel => ({
  workspace: { name: "Ateliér Kalný s.r.o.", companyId: "09482711", vatId: "CZ09482711" },
  branding: { accentColor: "#0F5D42", footerText: null, logo: null, stamp: null },
  periodLabel: "Export přehledu · Q4 2026",
  title: "Souhrn DPH a cashflow",
  generatedAt: "2026-11-23T13:20:00Z",
  kpis: [
    { label: "Tržby bez DPH", value: money("412800") },
    { label: "Náklady bez DPH", value: money("96420") },
    { label: "Výstupní DPH", value: money("78140") },
    { label: "DPH k odvodu", value: money("57892"), emphasis: true },
  ],
  table: {
    columns: [
      { label: "Kategorie DPH (01. 10. – 31. 12. 2026)", align: "left" },
      { label: "Dokladů", align: "right" },
      { label: "Základ CZK", align: "right" },
      { label: "DPH CZK", align: "right" },
    ],
    rows: [
      {
        cells: [
          { text: "Tuzemská plnění — základní sazba 21 %" },
          { count: 11 },
          { money: money("346000") },
          { money: money("72660") },
        ],
      },
      {
        cells: [
          { text: "Odpočet vstupní DPH z přijatých nákladů" },
          { count: 14 },
          { money: money("96420") },
          { money: money("-20248") },
        ],
        tone: "deduction",
      },
    ],
  },
  total: { label: "Čistá daňová povinnost (Q4 2026)", value: money("57892") },
  footerNote: "Podklad pro účetní a daňové přiznání",
});
