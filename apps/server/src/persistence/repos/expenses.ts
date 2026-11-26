/** `ExpensesRepo` over `expenses` and `attachments`. */
import { ExpensesRepo } from "@kvitbit/core";
import type {
  AttachmentId,
  ContactId,
  CurrencyCode,
  ExpenseId,
  ExpenseStatus,
  IsoDate,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  asStringArray,
  decodeVatBreakdown,
  decodeVatBucket,
  encodeVatBreakdown,
  encodeVatBucket,
  formatDecimal,
  formatNullableDecimal,
  parseDecimal,
  parseJson,
  parseNullableDecimal,
} from "../codec";
import { unavailable } from "../errors";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type ExpenseRow = Effect.Success<ReturnType<ExpensesRepo["Service"]["get"]>>;
type AttachmentRow = Effect.Success<ReturnType<ExpensesRepo["Service"]["getAttachment"]>>;
type StoredVatLine = NonNullable<ExpenseRow["vatLines"]>[number];
type ExpenseFigures = NonNullable<ExpenseRow["figures"]>;

interface JsonVatLine {
  readonly treatment: VatTreatment;
  readonly base: string;
  readonly vat: string;
  readonly selfAssessed: "standard" | "reduced" | null;
}

interface JsonFigures {
  readonly taxPoint: IsoDate;
  readonly totals: unknown;
  readonly selfAssessed: ReadonlyArray<unknown>;
  readonly fx: {
    readonly rate: string;
    readonly quantity: number;
    readonly fixingDate: IsoDate | null;
    readonly source: "cnb" | "manual";
  } | null;
  readonly totalCzk: string;
  readonly deductibleVat: string;
  readonly deductibleVatCzk: string;
}

const encodeVatLines = (lines: ExpenseRow["vatLines"]): string | null =>
  lines === null
    ? null
    : JSON.stringify(
        lines.map(
          (l): JsonVatLine => ({
            treatment: l.treatment,
            base: formatDecimal(l.base),
            vat: formatDecimal(l.vat),
            selfAssessed: l.selfAssessed,
          }),
        ),
      );

const decodeVatLines = (raw: unknown): ExpenseRow["vatLines"] =>
  raw === null || raw === undefined
    ? null
    : parseJson<ReadonlyArray<JsonVatLine>>(raw).map(
        (l): StoredVatLine => ({
          treatment: l.treatment,
          base: parseDecimal(l.base),
          vat: parseDecimal(l.vat),
          selfAssessed: l.selfAssessed,
        }),
      );

const encodeFigures = (figures: ExpenseRow["figures"]): string | null =>
  figures === null
    ? null
    : JSON.stringify({
        taxPoint: figures.taxPoint,
        totals: encodeVatBreakdown(figures.totals),
        selfAssessed: figures.selfAssessed.map((b) => encodeVatBucket(b)),
        fx:
          figures.fx === null
            ? null
            : {
                rate: formatDecimal(figures.fx.rate),
                quantity: figures.fx.quantity,
                fixingDate: figures.fx.fixingDate,
                source: figures.fx.source,
              },
        totalCzk: formatDecimal(figures.totalCzk),
        deductibleVat: formatDecimal(figures.deductibleVat),
        deductibleVatCzk: formatDecimal(figures.deductibleVatCzk),
      } satisfies JsonFigures);

const decodeFigures = (raw: unknown): ExpenseRow["figures"] => {
  if (raw === null || raw === undefined) return null;
  const parsed = parseJson<JsonFigures>(raw);
  return {
    taxPoint: parsed.taxPoint,
    totals: decodeVatBreakdown(parsed.totals),
    selfAssessed: parsed.selfAssessed.map((b) => decodeVatBucket(b)),
    fx:
      parsed.fx === null
        ? null
        : {
            rate: parseDecimal(parsed.fx.rate),
            quantity: Number(parsed.fx.quantity),
            fixingDate: parsed.fx.fixingDate,
            source: parsed.fx.source,
          },
    totalCzk: parseDecimal(parsed.totalCzk),
    deductibleVat: parseDecimal(parsed.deductibleVat),
    deductibleVatCzk: parseDecimal(parsed.deductibleVatCzk),
  } satisfies ExpenseFigures;
};

const expenseSpec: TableSpec<ExpenseRow> = {
  table: "expenses",
  collection: "expenses",
  entity: "Expense",
  select: [
    "id",
    "workspace_id",
    "revision",
    "status",
    "contact_id",
    "supplier_name",
    "supplier_ico",
    "supplier_dic",
    "supplier_document_number",
    col.date("issued_on"),
    col.date("taxable_supply_on"),
    col.date("due_on"),
    "currency",
    col.numeric("total_gross"),
    "vat_breakdown",
    "figures",
    "deductible_percent",
    "category",
    "tags",
    "note",
    col.numeric("paid"),
    "payments",
    col.instant("removed_at"),
    col.instant("created_at"),
    col.instant("updated_at"),
  ].join(", "),
  decode: decodeEach((row: DbRow): ExpenseRow => {
    const hasSupplier =
      row.contact_id !== null ||
      row.supplier_name !== null ||
      row.supplier_ico !== null ||
      row.supplier_dic !== null;
    return {
      id: row.id as ExpenseId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      status: row.status as ExpenseStatus,
      supplier: hasSupplier
        ? {
            contactId: (row.contact_id as ContactId | null) ?? null,
            name: (row.supplier_name as string | null) ?? null,
            ico: (row.supplier_ico as string | null) ?? null,
            dic: (row.supplier_dic as string | null) ?? null,
          }
        : null,
      supplierDocumentNumber: (row.supplier_document_number as string | null) ?? null,
      issuedOn: (row.issued_on as IsoDate | null) ?? null,
      taxableSupplyOn: (row.taxable_supply_on as IsoDate | null) ?? null,
      dueOn: (row.due_on as IsoDate | null) ?? null,
      currency: (row.currency as CurrencyCode | null) ?? null,
      total: parseNullableDecimal(row.total_gross),
      vatLines: decodeVatLines(row.vat_breakdown),
      deductiblePercent: Number(row.deductible_percent),
      category: (row.category as string | null) ?? null,
      tags: asStringArray(row.tags),
      note: (row.note as string | null) ?? null,
      figures: decodeFigures(row.figures),
      paid: parseDecimal(row.paid),
      payments: Number(row.payments),
      removedAt: (row.removed_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    status: row.status,
    contact_id: row.supplier?.contactId ?? null,
    supplier_name: row.supplier?.name ?? null,
    supplier_ico: row.supplier?.ico ?? null,
    supplier_dic: row.supplier?.dic ?? null,
    supplier_document_number: row.supplierDocumentNumber,
    issued_on: row.issuedOn,
    taxable_supply_on: row.taxableSupplyOn,
    due_on: row.dueOn,
    currency: row.currency,
    total_gross: formatNullableDecimal(row.total),
    vat_breakdown: encodeVatLines(row.vatLines),
    figures: encodeFigures(row.figures),
    fx_rate: row.figures?.fx ? formatDecimal(row.figures.fx.rate) : null,
    fx_quantity: row.figures?.fx?.quantity ?? null,
    fx_fixing_date: row.figures?.fx?.fixingDate ?? null,
    fx_source: row.figures?.fx?.source ?? null,
    deductible_percent: row.deductiblePercent,
    category: row.category,
    tags: [...row.tags],
    note: row.note,
    paid: formatDecimal(row.paid),
    payments: row.payments,
    removed_at: row.removedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
};

const attachmentSpec: TableSpec<AttachmentRow> = {
  table: "attachments",
  collection: "attachments",
  entity: "Attachment",
  select: [
    "id",
    "workspace_id",
    "revision",
    "expense_id",
    "blob_key",
    "file_name",
    "content_type",
    "bytes",
    "sha256",
    col.instant("created_at"),
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): AttachmentRow => ({
      id: row.id as AttachmentId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      expenseId: row.expense_id as ExpenseId,
      blobKey: row.blob_key as string,
      name: (row.file_name as string | null) ?? "",
      contentType: row.content_type as string,
      bytes: Number(row.bytes),
      sha256: row.sha256 as string,
      createdAt: row.created_at as string,
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    expense_id: row.expenseId,
    blob_key: row.blobKey,
    file_name: row.name,
    content_type: row.contentType,
    bytes: row.bytes,
    sha256: row.sha256,
    created_at: row.createdAt,
  }),
};

export const ExpensesRepoSql: Layer.Layer<ExpensesRepo, never, SqlClient.SqlClient> = Layer.effect(
  ExpensesRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const expenses = makeTable(sql, expenseSpec);
    const attachments = makeTable(sql, attachmentSpec);

    const attachmentsOf = (workspaceId: WorkspaceId, expenseIds: ReadonlyArray<ExpenseId>) =>
      expenseIds.length === 0
        ? Effect.succeed<ReadonlyArray<AttachmentRow>>([])
        : attachments.select(
            workspaceId,
            sql`expense_id in ${sql.in([...expenseIds])}`,
            sql`order by created_at asc, id asc`,
          );

    return ExpensesRepo.of({
      get: (ws, id) => expenses.get(ws, id),
      lock: (ws, id) => expenses.lock(ws, id),
      insert: expenses.insert,
      update: expenses.update,
      page: (ws, request) =>
        Effect.gen(function* () {
          const conditions = [sql`removed_at is null`];
          if (request.status !== undefined) conditions.push(sql`status = ${request.status}`);
          if (request.beforeId !== undefined) {
            conditions.push(sql`id < ${request.beforeId}::uuid`);
          }
          const rows = yield* expenses.select(
            ws,
            sql.and(conditions),
            sql`order by id desc limit ${request.limit}`,
          );
          if (rows.length === 0) return [];
          const countRows = yield* unavailable(
            sql<{ expense_id: string; n: string }>`
              select expense_id, count(*)::text as n
              from attachments
              where workspace_id = ${ws} and expense_id in ${sql.in(rows.map((r) => r.id))}
              group by expense_id
            `,
          );
          const counts = new Map(countRows.map((c) => [c.expense_id, Number(c.n)] as const));
          return rows.map((row) => ({ row, attachments: counts.get(row.id) ?? 0 }));
        }),
      detail: (ws, id) =>
        Effect.gen(function* () {
          const row = yield* expenses.get(ws, id);
          const atts = yield* attachmentsOf(ws, [row.id]);
          return { row, attachments: atts };
        }),
      completeIn: (ws, range) =>
        expenses.select(
          ws,
          range.field === "issuedOn"
            ? sql`status = 'complete' and removed_at is null and issued_on >= ${range.from} and issued_on <= ${range.to}`
            : sql`status = 'complete' and removed_at is null and coalesce(taxable_supply_on, issued_on) >= ${range.from} and coalesce(taxable_supply_on, issued_on) <= ${range.to}`,
        ),
      countIncomplete: (ws) =>
        Effect.map(
          unavailable(
            sql<{ n: string }>`
              select count(*)::text as n from expenses
              where workspace_id = ${ws} and status = 'incomplete' and removed_at is null
            `,
          ),
          (rows) => Number(rows[0]?.n ?? 0),
        ),
      getAttachment: (ws, id) => attachments.get(ws, id),
      findAttachment: (ws, id) => attachments.find(ws, id),
      findAttachmentBySha: (ws, expenseId, sha256) =>
        attachments.first(ws, sql`expense_id = ${expenseId} and sha256 = ${sha256}`),
      insertAttachment: attachments.insert,
      removeAttachment: (ws, id, expectedRevision) => attachments.remove(ws, id, expectedRevision),
      attachmentsOf,
    });
  }),
);
