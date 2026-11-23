/** Row builders for Reports tests. Amounts are decimal strings. */
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  ExpenseId,
  IsoDate,
  Money,
  PaymentId,
  VatBucket,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import type {
  ReportDocument,
  ReportExpense,
  ReportPayment,
  StoredFx,
} from "../../../src/modules/reports";
import { WORKSPACE_A } from "../../helpers";

export const d = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Decimal as a normalized string, for readable assertions. */
export const s = (value: BigDecimal.BigDecimal | Money) =>
  BigDecimal.format(BigDecimal.normalize("amount" in value ? value.amount : value));

export const CZK = "CZK" as CurrencyCode;
export const EUR = "EUR" as CurrencyCode;

const id = (prefix: string, n: number) =>
  `01900000-0000-7000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
export const docId = (n: number) => id("d", n) as DocumentId;
export const expenseId = (n: number) => id("e", n) as ExpenseId;
export const paymentId = (n: number) => id("f", n) as PaymentId;
export const contactId = (n: number) => id("c", n) as ContactId;

export const bucket = (
  treatment: VatTreatment,
  rate: string,
  base: string,
  vat: string,
  vatCzk: string | null = null,
): VatBucket => ({
  treatment,
  ratePercent: d(rate),
  base: d(base),
  vat: d(vat),
  gross: BigDecimal.sum(d(base), d(vat)),
  vatCzk: vatCzk === null ? null : d(vatCzk),
});

const breakdown = (buckets: ReadonlyArray<VatBucket>, currency: CurrencyCode) => {
  const net = buckets.reduce((a, b) => BigDecimal.sum(a, b.base), d("0"));
  const vat = buckets.reduce((a, b) => BigDecimal.sum(a, b.vat), d("0"));
  const vatCzk =
    currency === CZK || buckets.some((b) => b.vatCzk === null)
      ? null
      : {
          amount: buckets.reduce((a, b) => BigDecimal.sum(a, b.vatCzk ?? d("0")), d("0")),
          currency: CZK,
        };
  return {
    buckets,
    net: { amount: net, currency },
    vat: { amount: vat, currency },
    roundingAdjustment: { amount: d("0"), currency },
    gross: { amount: BigDecimal.sum(net, vat), currency },
    vatCzk,
  };
};

export const fx = (rate: string, quantity = 1): StoredFx => ({ rate: d(rate), quantity });

export const document = (
  n: number,
  overrides: Partial<Omit<ReportDocument, "totals">> & {
    readonly buckets?: ReadonlyArray<VatBucket>;
  } = {},
): ReportDocument => {
  const currency = overrides.currency ?? CZK;
  const { buckets, ...rest } = overrides;
  return {
    id: docId(n),
    workspaceId: WORKSPACE_A,
    kind: "invoice",
    finalInvoice: false,
    correctsKind: overrides.kind === "credit_note" ? "invoice" : null,
    status: "issued",
    number: `2026-${String(n).padStart(4, "0")}`,
    contact: { id: contactId(1), name: "Odběratel s.r.o." },
    currency,
    issuedOn: "2026-11-05" as IsoDate,
    taxPoint: "2026-11-05" as IsoDate,
    dueOn: "2026-11-19" as IsoDate,
    fx: null,
    advanceDeductions: [],
    settlement: "unpaid",
    outstanding: d("0"),
    ...rest,
    totals: breakdown(buckets ?? [bucket("standard", "21", "1000", "210")], currency),
  };
};

export const expense = (
  n: number,
  overrides: Partial<Omit<ReportExpense, "totals">> & {
    readonly buckets?: ReadonlyArray<VatBucket>;
  } = {},
): ReportExpense => {
  const currency = overrides.currency ?? CZK;
  const { buckets, ...rest } = overrides;
  return {
    id: expenseId(n),
    workspaceId: WORKSPACE_A,
    supplierDocumentNumber: `FA-${n}`,
    supplier: { contactId: contactId(9), name: "Dodavatel a.s." },
    category: "software",
    tags: [],
    issuedOn: "2026-11-08" as IsoDate,
    taxPoint: "2026-11-08" as IsoDate,
    currency,
    selfAssessed: [],
    fx: null,
    deductiblePercent: 100,
    ...rest,
    totals: breakdown(buckets ?? [bucket("standard", "21", "400", "84")], currency),
  };
};

export const payment = (
  n: number,
  direction: "in" | "out",
  paidOn: string,
  amount: string,
  currency: CurrencyCode = CZK,
  storedFx: StoredFx | null = null,
  workspaceId: WorkspaceId = WORKSPACE_A,
): ReportPayment => ({
  id: paymentId(n),
  workspaceId,
  direction,
  target: direction === "in" ? { document: docId(n) } : { expense: expenseId(n) },
  paidOn: paidOn as IsoDate,
  amount: { amount: d(amount), currency },
  fx: storedFx,
});
