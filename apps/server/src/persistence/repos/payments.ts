/** `PaymentsRepo` over `payments`. */
import { PaymentsRepo } from "@kvitbit/core";
import type {
  CurrencyCode,
  DocumentId,
  ExpenseId,
  IsoDate,
  PaymentId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { formatDecimal, parseDecimal, toPgDate } from "../codec";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type PaymentRecord = Effect.Success<ReturnType<PaymentsRepo["Service"]["get"]>>;

const spec: TableSpec<PaymentRecord> = {
  table: "payments",
  collection: "payments",
  entity: "Payment",
  select: [
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
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): PaymentRecord => ({
      id: row.id as PaymentId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      documentId: (row.document_id as DocumentId | null) ?? null,
      expenseId: (row.expense_id as ExpenseId | null) ?? null,
      amount: parseDecimal(row.amount),
      currency: row.currency as CurrencyCode,
      paidOn: row.paid_on as IsoDate,
      method: row.method as PaymentMethod,
      note: (row.note as string | null) ?? null,
      taxDocumentId: (row.tax_document_id as DocumentId | null) ?? null,
      removedAt: (row.removed_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }),
  ),
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
      get: (workspaceId, id) => table.get(workspaceId, id),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      insert: table.insert,
      update: table.update,
      liveFor: (workspaceId, target) =>
        table.select(
          workspaceId,
          "document" in target
            ? sql`document_id = ${target.document} and removed_at is null`
            : sql`expense_id = ${target.expense} and removed_at is null`,
          sql`order by paid_on asc, id asc`,
        ),
      paidBetween: (workspaceId, range) =>
        table.select(
          workspaceId,
          sql`removed_at is null and paid_on >= ${toPgDate(range.from)} and paid_on <= ${toPgDate(range.to)}`,
          sql`order by paid_on asc, id asc`,
        ),
    });
  }),
);
