/** Row builders for Reports tests. Amounts are decimal strings. */

import type { Money, VatBucket, WorkspaceId } from "@kvitbit/domain/contract";
import {
  ContactId,
  CurrencyCode,
  DocumentId,
  ExpenseId,
  IsoDate,
  PaymentId,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as EffectFunction from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import type {
  ReportDocument,
  ReportExpense,
  ReportPayment,
  StoredFx,
} from "../../../src/modules/reports";
import { WORKSPACE_A } from "../../helpers";

export const d = (sInput: string) => BigDecimal.fromStringUnsafe(sInput);
/** Decimal as a normalized string, for readable assertions. */
export const s = (value: BigDecimal.BigDecimal | Money) =>
  ("amount" in value ? value.amount : value).pipe(BigDecimal.normalize, BigDecimal.format);

export const CZK = CurrencyCode.make("CZK");
export const EUR = CurrencyCode.make("EUR");

const id = (prefix: string, n: number) =>
  `01900000-0000-7000-8000-${prefix}${EffectString.padStart(12 - prefix.length, "0")(String(n))}`;
export const docId = (n: number) => DocumentId.make(id("d", n));
export const expenseId = (n: number) => ExpenseId.make(id("e", n));
const paymentId = (n: number) => PaymentId.make(id("f", n));
export const contactId = (n: number) => ContactId.make(id("c", n));

export const bucket: {
  (
    treatment: VatTreatment,
    rate: string,
    base: string,
    vat: string,
    vatCzk?: string | null,
  ): VatBucket;
  (
    rate: string,
    base: string,
    vat: string,
    vatCzk?: string | null,
  ): (treatment: VatTreatment) => VatBucket;
} = EffectFunction.dual(
  (args) => Schema.is(VatTreatment)(args[0]),
  (
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
  }),
);

const breakdown = (buckets: ReadonlyArray<VatBucket>, currency: CurrencyCode) => {
  const net = EffectArray.reduce(buckets, d("0"), (a, b) => BigDecimal.sum(a, b.base));
  const vat = EffectArray.reduce(buckets, d("0"), (a, b) => BigDecimal.sum(a, b.vat));
  const vatCzk =
    currency === CZK || EffectArray.some(buckets, (b) => b.vatCzk === null)
      ? null
      : {
          amount: EffectArray.reduce(buckets, d("0"), (a, b) =>
            BigDecimal.sum(a, b.vatCzk ?? d("0")),
          ),
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

export const fx: {
  (quantity?: number): (rate: string) => StoredFx;
  (rate: string, quantity?: number): StoredFx;
} = EffectFunction.dual(
  (args) => Predicate.isString(args[0]),
  (rate: string, quantity = 1): StoredFx => ({
    rate: d(rate),
    quantity,
  }),
);

type DocumentOverrides = Partial<Omit<ReportDocument, "totals">> & {
  readonly buckets?: ReadonlyArray<VatBucket>;
};

export const document: {
  (overrides?: DocumentOverrides): (n: number) => ReportDocument;
  (n: number, overrides?: DocumentOverrides): ReportDocument;
} = EffectFunction.dual(
  (args) => Predicate.isNumber(args[0]),
  (n: number, overrides: DocumentOverrides = {}): ReportDocument => {
    const currency = overrides.currency ?? CZK;
    const { buckets, ...rest } = overrides;
    return {
      id: docId(n),
      workspaceId: WORKSPACE_A,
      kind: "invoice",
      finalInvoice: false,
      correctsKind: overrides.kind === "credit_note" ? "invoice" : null,
      status: "issued",
      number: `2026-${EffectString.padStart(4, "0")(String(n))}`,
      contact: { id: contactId(1), name: "Odběratel s.r.o." },
      currency,
      issuedOn: IsoDate.make("2026-11-05"),
      taxPoint: IsoDate.make("2026-11-05"),
      dueOn: IsoDate.make("2026-11-19"),
      fx: null,
      advanceDeductions: [],
      settlement: "unpaid",
      outstanding: d("0"),
      ...rest,
      totals: breakdown(buckets ?? [bucket("standard", "21", "1000", "210")], currency),
    };
  },
);

type ExpenseOverrides = Partial<Omit<ReportExpense, "totals">> & {
  readonly buckets?: ReadonlyArray<VatBucket>;
};

export const expense: {
  (overrides?: ExpenseOverrides): (n: number) => ReportExpense;
  (n: number, overrides?: ExpenseOverrides): ReportExpense;
} = EffectFunction.dual(
  (args) => Predicate.isNumber(args[0]),
  (n: number, overrides: ExpenseOverrides = {}): ReportExpense => {
    const currency = overrides.currency ?? CZK;
    const { buckets, ...rest } = overrides;
    return {
      id: expenseId(n),
      workspaceId: WORKSPACE_A,
      supplierDocumentNumber: `FA-${n}`,
      supplier: { contactId: contactId(9), name: "Dodavatel a.s." },
      category: "software",
      tags: [],
      issuedOn: IsoDate.make("2026-11-08"),
      taxPoint: IsoDate.make("2026-11-08"),
      currency,
      selfAssessed: [],
      fx: null,
      deductiblePercent: 100,
      ...rest,
      totals: breakdown(buckets ?? [bucket("standard", "21", "400", "84")], currency),
    };
  },
);

export const payment: {
  (
    direction: "in" | "out",
    paidOn: string,
    amount: string,
    currency?: CurrencyCode,
    storedFx?: StoredFx | null,
    workspaceId?: WorkspaceId,
  ): (n: number) => ReportPayment;
  (
    n: number,
    direction: "in" | "out",
    paidOn: string,
    amount: string,
    currency?: CurrencyCode,
    storedFx?: StoredFx | null,
    workspaceId?: WorkspaceId,
  ): ReportPayment;
} = EffectFunction.dual(
  (args) => Predicate.isNumber(args[0]),
  (
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
    paidOn: IsoDate.make(paidOn),
    amount: { amount: d(amount), currency },
    fx: storedFx,
  }),
);
