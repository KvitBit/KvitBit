/**
 * The stored Payment (`payments` table) and its view codecs.
 *
 * A row names exactly one target: `documentId` (money received, direction "in") or
 * `expenseId` (money paid, "out"). For a document it is the document the payment SETTLES: a
 * payment recorded on a Proforma that already has a Final Invoice is stored against the Final
 * Invoice (rule D8), so a document's paid total is the sum of its live rows. Removal is a soft
 * delete (`removedAt`); the reason goes into the audit entry.
 */
import type { DocumentView, PaymentView } from "@kvitbit/domain/contract";
import {
  CurrencyCode,
  DocumentId,
  ExpenseId,
  IsoDate,
  Money,
  MoneyMath,
  PaymentId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { BigDecimal, Schema } from "effect";
import { defineCollection } from "../../store/tables";
import { DocumentViewData } from "../documents";

export const PaymentRecord = Schema.Struct({
  id: PaymentId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
  documentId: Schema.NullOr(DocumentId),
  expenseId: Schema.NullOr(ExpenseId),
  /** Positive, in `currency` (= the target's currency, P1). */
  amount: Schema.BigDecimal,
  currency: CurrencyCode,
  paidOn: IsoDate,
  method: PaymentMethod,
  note: Schema.NullOr(Schema.String),
  /** The Payment Tax Document issued for this payment (P2), if any. */
  taxDocumentId: Schema.NullOr(DocumentId),
  removedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PaymentRecord = typeof PaymentRecord.Type;

export const PaymentsTable = defineCollection<PaymentRecord>({
  name: "payments",
  entity: "Payment",
  schema: PaymentRecord as unknown as Schema.Codec<PaymentRecord, unknown>,
});

export const PaymentTargetSchema = Schema.Union([
  Schema.Struct({ document: DocumentId }),
  Schema.Struct({ expense: ExpenseId }),
]);

/** `Payments.record` input, fingerprinted for the request key (C3). */
export const RecordPaymentInputSchema = Schema.Struct({
  target: PaymentTargetSchema,
  amount: Schema.optional(Money),
  paidOn: Schema.optional(IsoDate),
  method: Schema.optional(PaymentMethod),
  note: Schema.optional(Schema.String),
});

/** Concrete shape of the domain `PaymentView` placeholder; every default resolved (C4). */
export const PaymentViewData = Schema.Struct({
  id: PaymentId,
  revision: Schema.Number,
  target: PaymentTargetSchema,
  amount: Money,
  paidOn: IsoDate,
  method: PaymentMethod,
  note: Schema.NullOr(Schema.String),
  taxDocument: Schema.NullOr(DocumentId),
  createdAt: Schema.String,
});
export type PaymentViewData = typeof PaymentViewData.Type;
export const PaymentViewCodec = PaymentViewData as unknown as Schema.Codec<PaymentView, unknown>;

/** The result of `Payments.record`. */
export interface RecordResult {
  readonly payment: PaymentView;
  readonly settlement: "partially_paid" | "paid" | "overpaid";
  readonly issued: ReadonlyArray<DocumentView>;
}

const RecordResultData = Schema.Struct({
  payment: PaymentViewData,
  settlement: Schema.Literals(["partially_paid", "paid", "overpaid"]),
  issued: Schema.Array(DocumentViewData),
});
/** The C3 result codec of `Payments.record`. */
export const RecordResultCodec = RecordResultData as unknown as Schema.Codec<RecordResult, unknown>;

/** The row's one target (the table checks exactly one is set). */
export const targetOf = (
  row: PaymentRecord,
): { readonly document: DocumentId } | { readonly expense: ExpenseId } =>
  row.documentId !== null ? { document: row.documentId } : { expense: row.expenseId as ExpenseId };

export const toView = (row: PaymentRecord): PaymentView =>
  ({
    id: row.id,
    revision: row.revision,
    target: targetOf(row),
    amount: MoneyMath.make(row.amount, row.currency),
    paidOn: row.paidOn,
    method: row.method,
    note: row.note,
    taxDocument: row.taxDocumentId,
    createdAt: row.createdAt,
  }) as PaymentViewData as unknown as PaymentView;

/** A payment as `ReportsSource.payments` returns it (board #397). */
export interface ReportPayment {
  readonly id: PaymentId;
  /** "in": a document target (received); "out": an expense target (paid). */
  readonly direction: "in" | "out";
  readonly target: { readonly document: DocumentId } | { readonly expense: ExpenseId };
  readonly paidOn: IsoDate;
  readonly amount: Money;
  /** The target's stored fixing (null for CZK). */
  readonly fx: { readonly rate: BigDecimal.BigDecimal; readonly quantity: number } | null;
}

/** Maps a live row and its target's stored fixing to the ReportsSource shape (pure). */
export const reportPayment = (row: PaymentRecord, fx: ReportPayment["fx"]): ReportPayment => ({
  id: row.id,
  direction: row.documentId !== null ? "in" : "out",
  target: targetOf(row),
  paidOn: row.paidOn,
  amount: MoneyMath.make(BigDecimal.normalize(row.amount), row.currency),
  fx,
});
