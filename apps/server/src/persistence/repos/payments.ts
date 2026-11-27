/** `PaymentsRepo` over `payments`. */

import { PaymentsRepo } from "@kvitbit/core";
import {
  CurrencyCode,
  DocumentId,
  ExpenseId,
  IsoDate,
  PaymentId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { formatDecimal, parseDecimal, StoredUuid, toPgDate } from "../codec";
import { col, decodeEach, makeTable, type TableSpec } from "../table";
import { selectReportRows } from "./reportArchivePages";

type PaymentRecord = Effect.Success<ReturnType<PaymentsRepo["Service"]["get"]>>;

const OptionalText = Schema.String.pipe(Schema.NullOr, Schema.optional);
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    id: StoredUuid,
    workspace_id: Schema.String,
    document_id: OptionalText,
    expense_id: OptionalText,
    currency: Schema.String,
    paid_on: Schema.String,
    method: PaymentMethod,
    note: OptionalText,
    tax_document_id: OptionalText,
    removed_at: OptionalText,
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);

const spec: TableSpec<PaymentRecord> = {
  table: "payments",
  collection: "payments",
  entity: "Payment",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "document_id",
      "expense_id",
      col.numeric("amount"),
      "currency",
      col.date("paid_on"),
      "method",
      "note",
      "tax_document_id",
      col.instant("removed_at"),
      col.instant("created_at"),
      col.instant("updated_at"),
    ],
    ", ",
  ),
  decode: decodeEach((row): PaymentRecord => {
    const stored = Option.getOrThrow(decodeRow(row));
    return {
      id: PaymentId.make(stored.id, { disableChecks: true }),
      workspaceId: WorkspaceId.make(stored.workspace_id),
      revision: Number(row.revision),
      documentId: Predicate.isNotNullish(stored.document_id)
        ? DocumentId.make(stored.document_id)
        : null,
      expenseId: Predicate.isNotNullish(stored.expense_id)
        ? ExpenseId.make(stored.expense_id)
        : null,
      amount: parseDecimal(row.amount),
      currency: CurrencyCode.make(stored.currency),
      paidOn: IsoDate.make(stored.paid_on),
      method: stored.method,
      note: stored.note ?? null,
      taxDocumentId: Predicate.isNotNullish(stored.tax_document_id)
        ? DocumentId.make(stored.tax_document_id)
        : null,
      removedAt: stored.removed_at ?? null,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    document_id: row.documentId,
    expense_id: row.expenseId,
    amount: formatDecimal(row.amount),
    currency: row.currency,
    paid_on: row.paidOn,
    method: row.method,
    note: row.note,
    tax_document_id: row.taxDocumentId,
    removed_at: row.removedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
};

export const PaymentsRepoSql: Layer.Layer<PaymentsRepo, never, SqlClient.SqlClient> = Layer.effect(
  PaymentsRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = makeTable(sql, spec);
    return PaymentsRepo.of({
      get: Effect.fn("PaymentsRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      lock: Effect.fn("PaymentsRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      insert: table.insert,
      update: table.update,
      liveFor: Effect.fn("PaymentsRepo.liveFor")((workspaceId, target) =>
        table.select(
          workspaceId,
          "document" in target
            ? sql`document_id = ${target.document} and removed_at is null`
            : sql`expense_id = ${target.expense} and removed_at is null`,
          sql`order by paid_on asc, id asc`,
        ),
      ),
      paidBetween: Effect.fn("PaymentsRepo.paidBetween")((workspaceId, range) =>
        selectReportRows(
          sql,
          "payments",
          sql`removed_at is null and paid_on >= ${toPgDate(range.from)} and paid_on <= ${toPgDate(range.to)}`,
          (where) => table.select(workspaceId, where, sql`order by paid_on asc, id asc`),
        ),
      ),
    });
  }),
);
