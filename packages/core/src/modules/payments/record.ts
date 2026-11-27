/**
 * The stored Payment (`payments` table) and its view codecs.
 *
 * A row names exactly one target: `documentId` (money received, direction "in") or
 * `expenseId` (money paid, "out"). For a document it is the document the payment SETTLES: a
 * payment recorded on a Proforma that already has a Final Invoice is stored against the Final
 * Invoice (rule D8), so a document's paid total is the sum of its live rows. Removal is a soft
 * delete (`removedAt`); the reason goes into the audit entry.
 */

import {
  CurrencyCode,
  DocumentId,
  type DocumentView,
  ExpenseId,
  IsoDate,
  Money,
  MoneyMath,
  PaymentId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineCollection } from "../../store/tables";
import { DocumentViewCodec } from "../documents/view";

export const PaymentRecord = Schema.Struct({
  id: PaymentId,
  workspaceId: WorkspaceId,
  revision: Schema.Finite,
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
  schema: PaymentRecord,
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
  revision: Schema.Finite,
  target: PaymentTargetSchema,
  amount: Money,
  paidOn: IsoDate,
  method: PaymentMethod,
  note: Schema.NullOr(Schema.String),
  taxDocument: Schema.NullOr(DocumentId),
  createdAt: Schema.String,
});
export type PaymentViewData = typeof PaymentViewData.Type;
export const PaymentViewCodec = PaymentViewData.pipe(Schema.brand("PaymentView"));

const IssuedDocumentCodec: Schema.Codec<DocumentView, unknown> = DocumentViewCodec;

/** The C3 result codec of `Payments.record`. */
export const RecordResultCodec = Schema.Struct({
  payment: PaymentViewCodec,
  settlement: Schema.Literals(["partially_paid", "paid", "overpaid"]),
  issued: Schema.Array(IssuedDocumentCodec),
});
export type RecordResult = typeof RecordResultCodec.Type;

/** The row's one target (the table checks exactly one is set). */
export const targetOf = (
  row: PaymentRecord,
): { readonly document: DocumentId } | { readonly expense: ExpenseId } =>
  row.documentId !== null
    ? { document: row.documentId }
    : { expense: Option.getOrThrow(Option.fromNullOr(row.expenseId)) };

export const toView = (row: PaymentRecord) =>
  PaymentViewCodec.make({
    id: row.id,
    revision: row.revision,
    target: targetOf(row),
    amount: MoneyMath.make(row.amount, row.currency),
    paidOn: row.paidOn,
    method: row.method,
    note: row.note,
    taxDocument: row.taxDocumentId,
    createdAt: row.createdAt,
  });

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
export const reportPayment: {
  (fx: ReportPayment["fx"]): (row: PaymentRecord) => ReportPayment;
  (row: PaymentRecord, fx: ReportPayment["fx"]): ReportPayment;
} = Fn.dual(
  2,
  (row: PaymentRecord, fx: ReportPayment["fx"]): ReportPayment => ({
    id: row.id,
    direction: row.documentId !== null ? "in" : "out",
    target: targetOf(row),
    paidOn: row.paidOn,
    amount: MoneyMath.make(BigDecimal.normalize(row.amount), row.currency),
    fx,
  }),
);
