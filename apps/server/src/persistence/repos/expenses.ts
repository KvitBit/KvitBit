/** `ExpensesRepo` over `expenses` and `attachments`. */

import { ExpensesRepo } from "@kvitbit/core";
import {
  AttachmentId,
  ContactId,
  CurrencyCode,
  ExpenseId,
  ExpenseStatus,
  IsoDate,
  VatTreatment,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  asStringArray,
  decodeStored,
  decodeWorkspaceId,
  encodeJson,
  encodeVatBreakdown,
  encodeVatBucket,
  formatDecimal,
  formatNullableDecimal,
  parseDecimal,
  parseJson,
  parseNullableDecimal,
  toPgDate,
  VatBreakdownJson,
  VatBucketJson,
} from "../codec";
import { unavailable } from "../errors";
import { col, type DbRow, type DbValue, decodeEach, makeTable, type TableSpec } from "../table";
import { selectReportRows } from "./reportArchivePages";

const readNullableContactId = decodeStored(Schema.NullOr(ContactId));
const readNullableText = decodeStored(Schema.NullOr(Schema.String));
const readNullableIsoDate = decodeStored(Schema.NullOr(IsoDate));
const readNullableCurrencyCode = decodeStored(Schema.NullOr(CurrencyCode));
const readExpenseId = decodeStored(ExpenseId);
const readExpenseStatus = decodeStored(ExpenseStatus);
const readText = decodeStored(Schema.String);
const readAttachmentId = decodeStored(AttachmentId);

type ExpenseRow = Effect.Success<ReturnType<ExpensesRepo["Service"]["get"]>>;
type AttachmentRow = Effect.Success<ReturnType<ExpensesRepo["Service"]["getAttachment"]>>;
type StoredVatLine = NonNullable<ExpenseRow["vatLines"]>[number];
type ExpenseFigures = NonNullable<ExpenseRow["figures"]>;

const VatLineJson = Schema.Struct({
  treatment: VatTreatment,
  base: Schema.String,
  vat: Schema.String,
  selfAssessed: Schema.NullOr(Schema.Literals(["standard", "reduced"])),
});

const readVatLines = parseJson(Schema.Array(VatLineJson));
const readFigures = parseJson(
  Schema.Struct({
    taxPoint: IsoDate,
    totals: VatBreakdownJson,
    selfAssessed: Schema.Array(VatBucketJson),
    fx: Schema.NullOr(
      Schema.Struct({
        rate: Schema.String,
        quantity: Schema.Finite,
        fixingDate: Schema.NullOr(IsoDate),
        source: Schema.Literals(["cnb", "manual"]),
      }),
    ),
    totalCzk: Schema.String,
    deductibleVat: Schema.String,
    deductibleVatCzk: Schema.String,
  }),
);

const encodeVatLines = (lines: ExpenseRow["vatLines"]): string | null =>
  lines === null
    ? null
    : encodeJson(
        Arr.map(lines, (l): typeof VatLineJson.Type => ({
          treatment: l.treatment,
          base: formatDecimal(l.base),
          vat: formatDecimal(l.vat),
          selfAssessed: l.selfAssessed,
        })),
      );

const decodeVatLines = (raw: DbValue): ExpenseRow["vatLines"] =>
  Predicate.isNullish(raw)
    ? null
    : Arr.map(
        readVatLines(raw),
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
    : encodeJson({
        taxPoint: figures.taxPoint,
        totals: encodeVatBreakdown(figures.totals),
        selfAssessed: Arr.map(figures.selfAssessed, (b) => encodeVatBucket(b)),
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
      });

const decodeFigures = (raw: DbValue): ExpenseRow["figures"] => {
  if (Predicate.isNullish(raw)) return null;
  const parsed = readFigures(raw);
  return {
    taxPoint: parsed.taxPoint,
    totals: parsed.totals,
    selfAssessed: parsed.selfAssessed,
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
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
  decode: decodeEach((row: DbRow): ExpenseRow => {
    const hasSupplier =
      row.contact_id !== null ||
      row.supplier_name !== null ||
      row.supplier_ico !== null ||
      row.supplier_dic !== null;
    return {
      id: readExpenseId(row.id),
      workspaceId: decodeWorkspaceId(row.workspace_id),
      revision: Number(row.revision),
      status: readExpenseStatus(row.status),
      supplier: hasSupplier
        ? {
            contactId: readNullableContactId(row.contact_id ?? null),
            name: readNullableText(row.supplier_name ?? null),
            ico: readNullableText(row.supplier_ico ?? null),
            dic: readNullableText(row.supplier_dic ?? null),
          }
        : null,
      supplierDocumentNumber: readNullableText(row.supplier_document_number ?? null),
      issuedOn: readNullableIsoDate(row.issued_on ?? null),
      taxableSupplyOn: readNullableIsoDate(row.taxable_supply_on ?? null),
      dueOn: readNullableIsoDate(row.due_on ?? null),
      currency: readNullableCurrencyCode(row.currency ?? null),
      total: parseNullableDecimal(row.total_gross),
      vatLines: decodeVatLines(row.vat_breakdown),
      deductiblePercent: Number(row.deductible_percent),
      category: readNullableText(row.category ?? null),
      tags: asStringArray(row.tags),
      note: readNullableText(row.note ?? null),
      figures: decodeFigures(row.figures),
      paid: parseDecimal(row.paid),
      payments: Number(row.payments),
      removedAt: readNullableText(row.removed_at ?? null),
      createdAt: readText(row.created_at),
      updatedAt: readText(row.updated_at),
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
    fx_rate: formatNullableDecimal(row.figures?.fx?.rate ?? null),
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
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
  decode: decodeEach(
    (row: DbRow): AttachmentRow => ({
      id: readAttachmentId(row.id),
      workspaceId: decodeWorkspaceId(row.workspace_id),
      revision: Number(row.revision),
      expenseId: readExpenseId(row.expense_id),
      blobKey: readText(row.blob_key),
      name: readNullableText(row.file_name ?? null) ?? "",
      contentType: readText(row.content_type),
      bytes: Number(row.bytes),
      sha256: readText(row.sha256),
      createdAt: readText(row.created_at),
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
      get: Effect.fn("ExpensesRepo.get")((ws, id) => expenses.get(ws, id)),
      lock: Effect.fn("ExpensesRepo.lock")((ws, id) => expenses.lock(ws, id)),
      insert: expenses.insert,
      update: expenses.update,
      page: Effect.fn("ExpensesRepo.page")(function* (ws, request) {
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
              where workspace_id = ${ws} and expense_id in ${sql.in(Arr.map(rows, (r) => r.id))}
              group by expense_id
            `,
        );
        const counts = new Map(Arr.map(countRows, (c) => [c.expense_id, Number(c.n)] as const));
        return Arr.map(rows, (row) => ({ row, attachments: counts.get(row.id) ?? 0 }));
      }),
      detail: Effect.fn("ExpensesRepo.detail")(function* (ws, id) {
        const row = yield* expenses.get(ws, id);
        const atts = yield* attachmentsOf(ws, [row.id]);
        return { row, attachments: atts };
      }),
      completeIn: Effect.fn("ExpensesRepo.completeIn")((ws, range) =>
        selectReportRows(
          sql,
          "expenses",
          range.field === "issuedOn"
            ? sql`status = 'complete' and removed_at is null and issued_on >= ${toPgDate(range.from)} and issued_on <= ${toPgDate(range.to)}`
            : sql`status = 'complete' and removed_at is null and coalesce(taxable_supply_on, issued_on) >= ${toPgDate(range.from)} and coalesce(taxable_supply_on, issued_on) <= ${toPgDate(range.to)}`,
          (where) => expenses.select(ws, where),
        ),
      ),
      countIncomplete: Effect.fn("ExpensesRepo.countIncomplete")((ws) =>
        Effect.map(
          unavailable(
            sql<{ n: string }>`
              select count(*)::text as n from expenses
              where workspace_id = ${ws} and status = 'incomplete' and removed_at is null
            `,
          ),
          (rows) => Number(rows[0]?.n ?? 0),
        ),
      ),
      getAttachment: Effect.fn("ExpensesRepo.getAttachment")((ws, id) => attachments.get(ws, id)),
      findAttachment: Effect.fn("ExpensesRepo.findAttachment")((ws, id) =>
        attachments.find(ws, id),
      ),
      findAttachmentBySha: Effect.fn("ExpensesRepo.findAttachmentBySha")((ws, expenseId, sha256) =>
        attachments.first(ws, sql`expense_id = ${expenseId} and sha256 = ${sha256}`),
      ),
      insertAttachment: attachments.insert,
      removeAttachment: Effect.fn("ExpensesRepo.removeAttachment")((ws, id, expectedRevision) =>
        attachments.remove(ws, id, expectedRevision),
      ),
      attachmentsOf,
    });
  }),
);
