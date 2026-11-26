/** `DocumentsRepo` over `documents`, `document_lines`, and `document_relations`. */
import { DocumentsRepo } from "@kvitbit/core";
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentRelation,
  DocumentSettlement,
  DocumentStatus,
  IsoDate,
  LineId,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  PriceListItemId,
  ScheduleId,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";
import {
  decodeVatBreakdown,
  encodeVatBreakdown,
  formatDecimal,
  formatNullableDecimal,
  parseDecimal,
  parseJson,
  parseNullableDecimal,
  toJsonb,
  toPgDate,
} from "../codec";
import { writeErrors } from "../errors";
import { col, type DbRow, makeTable, type TableSpec } from "../table";

type DocumentRecord = Effect.Success<ReturnType<DocumentsRepo["Service"]["get"]>>;
type LineRecord = DocumentRecord["lines"][number];
type LinkRecord = DocumentRecord["links"][number];

const isOverdueRow = (row: DocumentRecord, today: string): boolean =>
  (row.kind === "invoice" ||
    (row.kind === "proforma" && !row.links.some((l) => l.relation === "final_invoice_for"))) &&
  row.status === "issued" &&
  (row.settlement === "unpaid" || row.settlement === "partially_paid") &&
  row.dueOn < today;

const decodeItemPrice = (raw: unknown): LineRecord["itemPrice"] => {
  if (raw === null || raw === undefined) return null;
  const parsed = parseJson<{ readonly currency: CurrencyCode; readonly net: string }>(raw);
  return { currency: parsed.currency, net: parseDecimal(parsed.net) };
};

const encodeItemPrice = (value: LineRecord["itemPrice"]): string | null =>
  value === null
    ? null
    : JSON.stringify({ currency: value.currency, net: formatDecimal(value.net) });

const decodeFxOverride = (raw: unknown): DocumentRecord["fxOverride"] => {
  if (raw === null || raw === undefined) return null;
  const parsed = parseJson<{
    readonly manual: { readonly rate: string; readonly quantity: number };
  }>(raw);
  return {
    manual: { rate: parseDecimal(parsed.manual.rate), quantity: Number(parsed.manual.quantity) },
  };
};

const encodeFxOverride = (value: DocumentRecord["fxOverride"]): string | null =>
  value === null
    ? null
    : JSON.stringify({
        manual: { rate: formatDecimal(value.manual.rate), quantity: value.manual.quantity },
      });

const spec: TableSpec<DocumentRecord> = {
  table: "documents",
  collection: "documents",
  entity: "Document",
  constraints: {
    documents_number_unique: "documents_number_per_kind",
  },
  select: [
    "id",
    "workspace_id",
    "revision",
    "kind",
    "status",
    "locked",
    col.instant("locked_at"),
    "number",
    "series_id",
    "contact_id",
    "contact_snapshot",
    "issuer_snapshot",
    "given",
    "currency",
    "language",
    "payment_method",
    "note",
    col.date("issued_on"),
    col.date("taxable_supply_on"),
    col.date("due_on"),
    "prices_include_vat",
    "variable_symbol",
    "order_number",
    "vat_breakdown",
    col.numeric("fx_rate"),
    "fx_quantity",
    col.date("fx_fixing_date"),
    "fx_source",
    "fx_override",
    "tax_document",
    "payment_rounding",
    "reminders_choice",
    "reminders_on",
    col.numeric("paid_amount"),
    "payments",
    "settlement",
    "schedule_id",
    col.date("occurrence"),
    col.date("cancelled_on"),
    "corrected_number",
    "correction_reason",
    "cancellation_reason",
    col.instant("created_at"),
    col.instant("updated_at"),
    col.instant("issued_at"),
  ].join(", "),
  decode: (rows) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = rows.map((r) => r.id as string);
      const workspaceId = rows[0]?.workspace_id as string;

      const lineRows = yield* sql<DbRow>`
        select
          id, document_id, position, price_list_item_id, description,
          quantity::text as quantity, unit, unit_price::text as unit_price,
          item_price, given_vat, item_vat, vat,
          rate_percent::text as rate_percent, amount::text as amount,
          deducts_document_id, deducted_vat::text as deducted_vat,
          deducted_vat_czk::text as deducted_vat_czk
        from document_lines
        where workspace_id = ${workspaceId} and document_id in ${sql.in(ids)}
        order by position asc
      `;

      const relRows = yield* sql<{
        readonly from_document_id: string;
        readonly to_document_id: DocumentId;
        readonly relation: DocumentRelation;
      }>`
        select from_document_id, to_document_id, relation
        from document_relations
        where workspace_id = ${workspaceId} and from_document_id in ${sql.in(ids)}
        order by created_at asc, to_document_id asc
      `;

      const linesByDoc = new Map<string, LineRecord[]>();
      for (const lr of lineRows) {
        const docId = lr.document_id as string;
        let list = linesByDoc.get(docId);
        if (list === undefined) {
          list = [];
          linesByDoc.set(docId, list);
        }
        list.push({
          id: lr.id as LineId,
          item: (lr.price_list_item_id as PriceListItemId | null) ?? null,
          description: lr.description as string,
          quantity: parseDecimal(lr.quantity),
          unit: (lr.unit as string | null) ?? null,
          unitPrice: parseDecimal(lr.unit_price),
          itemPrice: decodeItemPrice(lr.item_price),
          vat: (lr.given_vat as VatTreatment | null) ?? null,
          itemVat: (lr.item_vat as VatTreatment | null) ?? null,
          treatment: lr.vat as VatTreatment,
          ratePercent: parseDecimal(lr.rate_percent),
          amount: parseDecimal(lr.amount),
          deducts: (lr.deducts_document_id as DocumentId | null) ?? null,
          deductedVat: parseNullableDecimal(lr.deducted_vat),
          deductedVatCzk: parseNullableDecimal(lr.deducted_vat_czk),
        });
      }

      const linksByDoc = new Map<string, LinkRecord[]>();
      for (const rr of relRows) {
        let list = linksByDoc.get(rr.from_document_id);
        if (list === undefined) {
          list = [];
          linksByDoc.set(rr.from_document_id, list);
        }
        list.push({ relation: rr.relation, id: rr.to_document_id });
      }

      return rows.map((row): DocumentRecord => {
        const docId = row.id as DocumentId;
        const fx =
          row.fx_rate != null && row.fx_quantity != null && row.fx_source != null
            ? {
                rate: parseDecimal(row.fx_rate),
                quantity: Number(row.fx_quantity),
                fixingDate: (row.fx_fixing_date as IsoDate | null) ?? null,
                source: row.fx_source as "cnb" | "manual",
              }
            : null;
        return {
          id: docId,
          workspaceId: row.workspace_id as WorkspaceId,
          revision: Number(row.revision),
          kind: row.kind as DocumentKind,
          status: row.status as DocumentStatus,
          locked: Boolean(row.locked),
          lockedAt: (row.locked_at as string | null) ?? null,
          number: (row.number as string | null) ?? null,
          seriesId: (row.series_id as NumberingSeriesId | null) ?? null,
          contactId: row.contact_id as ContactId,
          contact: parseJson<DocumentRecord["contact"]>(row.contact_snapshot),
          issuer: parseJson<DocumentRecord["issuer"]>(row.issuer_snapshot),
          given: parseJson<DocumentRecord["given"]>(row.given),
          currency: row.currency as CurrencyCode,
          language: row.language as Locale,
          paymentMethod: row.payment_method as PaymentMethod,
          note: (row.note as string | null) ?? null,
          issuedOn: row.issued_on as IsoDate,
          taxableSupplyOn: (row.taxable_supply_on as IsoDate | null) ?? null,
          dueOn: row.due_on as IsoDate,
          pricesIncludeVat: Boolean(row.prices_include_vat),
          variableSymbol: (row.variable_symbol as string | null) ?? null,
          orderNumber: (row.order_number as string | null) ?? null,
          lines: linesByDoc.get(docId) ?? [],
          totals: decodeVatBreakdown(parseJson<unknown>(row.vat_breakdown)),
          fx,
          fxOverride: decodeFxOverride(row.fx_override),
          taxDocument: Boolean(row.tax_document),
          paymentRounding: row.payment_rounding as "none" | "whole_unit",
          remindersChoice: row.reminders_choice as "on" | "off" | "inherit",
          remindersOn: Boolean(row.reminders_on),
          links: linksByDoc.get(docId) ?? [],
          paidAmount: parseDecimal(row.paid_amount),
          payments: Number(row.payments),
          settlement: row.settlement as DocumentSettlement,
          scheduleId: (row.schedule_id as ScheduleId | null) ?? null,
          occurrence: (row.occurrence as IsoDate | null) ?? null,
          cancelledOn: (row.cancelled_on as IsoDate | null) ?? null,
          correctedNumber: (row.corrected_number as string | null) ?? null,
          reason:
            (row.correction_reason as string | null) ??
            (row.cancellation_reason as string | null) ??
            null,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
          issuedAt: (row.issued_at as string | null) ?? null,
        };
      });
    }),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    kind: row.kind,
    status: row.status,
    locked: row.locked,
    locked_at: row.lockedAt,
    number: row.number,
    series_id: row.seriesId,
    contact_id: row.contactId,
    bank_account_id: row.issuer.bankAccount?.id ?? null,
    contact_snapshot: toJsonb(row.contact),
    issuer_snapshot: toJsonb(row.issuer),
    given: toJsonb(row.given),
    currency: row.currency,
    language: row.language,
    payment_method: row.paymentMethod,
    note: row.note,
    issued_on: row.issuedOn,
    taxable_supply_on: row.taxableSupplyOn,
    due_on: row.dueOn,
    prices_include_vat: row.pricesIncludeVat,
    variable_symbol: row.variableSymbol,
    order_number: row.orderNumber,
    vat_breakdown: JSON.stringify(encodeVatBreakdown(row.totals)),
    total_net: formatDecimal(row.totals.net.amount),
    total_vat: formatDecimal(row.totals.vat.amount),
    total_gross: formatDecimal(row.totals.gross.amount),
    fx_rate: row.fx ? formatDecimal(row.fx.rate) : null,
    fx_quantity: row.fx ? row.fx.quantity : null,
    fx_fixing_date: row.fx ? row.fx.fixingDate : null,
    fx_source: row.fx ? row.fx.source : null,
    fx_override: encodeFxOverride(row.fxOverride),
    tax_document: row.taxDocument,
    payment_rounding: row.paymentRounding,
    reminders_choice: row.remindersChoice,
    reminders_on: row.remindersOn,
    paid_amount: formatDecimal(row.paidAmount),
    payments: row.payments,
    settlement: row.settlement,
    schedule_id: row.scheduleId,
    occurrence: row.occurrence,
    cancelled_on: row.cancelledOn,
    corrected_number: row.correctedNumber,
    correction_reason: row.kind === "credit_note" ? row.reason : null,
    cancellation_reason: row.kind !== "credit_note" ? row.reason : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    issued_at: row.issuedAt,
  }),
  writeChildren: (row, mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (mode === "update") {
        yield* sql`
          delete from document_lines
          where workspace_id = ${row.workspaceId} and document_id = ${row.id}
        `;
        yield* sql`
          delete from document_relations
          where workspace_id = ${row.workspaceId} and from_document_id = ${row.id}
        `;
      }
      if (row.lines.length > 0) {
        const lineRows = row.lines.map((l, idx) => ({
          id: l.id,
          workspace_id: row.workspaceId,
          document_id: row.id,
          position: idx,
          price_list_item_id: l.item,
          description: l.description,
          quantity: formatDecimal(l.quantity),
          unit: l.unit,
          unit_price: formatDecimal(l.unitPrice),
          item_price: encodeItemPrice(l.itemPrice),
          given_vat: l.vat,
          item_vat: l.itemVat,
          vat: l.treatment,
          rate_percent: formatDecimal(l.ratePercent),
          amount: formatDecimal(l.amount),
          deducts_document_id: l.deducts,
          deducted_vat: formatNullableDecimal(l.deductedVat),
          deducted_vat_czk: formatNullableDecimal(l.deductedVatCzk),
        })) as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
        yield* sql`insert into document_lines ${sql.insert(lineRows)}`;
      }
      if (row.links.length > 0) {
        const relRows = row.links.map((link) => ({
          workspace_id: row.workspaceId,
          from_document_id: row.id,
          to_document_id: link.id,
          relation: link.relation,
        })) as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
        yield* sql`insert into document_relations ${sql.insert(relRows)}`;
      }
    }),
};

export const DocumentsRepoSql: Layer.Layer<DocumentsRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    DocumentsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const table = makeTable(sql, spec);

      return DocumentsRepo.of({
        get: (workspaceId, id) => table.get(workspaceId, id),
        getMany: (workspaceId, ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : table.select(workspaceId, sql`id in ${sql.in(ids)}`),
        getForUpdate: (workspaceId, id, expectedRevision) =>
          table.getForUpdate(workspaceId, id, expectedRevision),
        lock: (workspaceId, id) => table.lock(workspaceId, id),
        insert: table.insert,
        update: table.update,
        remove: (workspaceId, id, expectedRevision) =>
          table.remove(workspaceId, id, expectedRevision),
        linkSchedule: (workspaceId, id, link) =>
          sql
            .withTransaction(
              sql<{ readonly id: string }>`
                update documents
                set schedule_id = ${link.scheduleId},
                    occurrence = ${link.occurrence}::date,
                    revision = revision + 1
                where workspace_id = ${workspaceId} and id = ${id}
                returning id
              `,
            )
            .pipe(
              Effect.catch(writeErrors("documents")),
              Effect.flatMap((rows) =>
                rows.length === 0
                  ? Effect.fail(new NotFound({ entity: "Document", id }))
                  : Effect.void,
              ),
            ),
        search: (workspaceId, s, page) => {
          const filters: Fragment[] = [];
          if (s.kind !== undefined) filters.push(sql`kind = ${s.kind}`);
          if (s.status !== undefined) filters.push(sql`status = ${s.status}`);
          if (s.settlement !== undefined) filters.push(sql`settlement = ${s.settlement}`);
          if (s.contactId !== undefined) filters.push(sql`contact_id = ${s.contactId}`);
          if (s.from !== undefined) filters.push(sql`issued_on >= ${s.from}::date`);
          if (s.to !== undefined) filters.push(sql`issued_on <= ${s.to}::date`);
          if (page.after !== undefined) {
            const [afterDate, afterId] = page.after;
            filters.push(
              sql`(issued_on < ${afterDate}::date or (issued_on = ${afterDate}::date and id < ${afterId}::uuid))`,
            );
          }
          const where = filters.length > 0 ? sql.and(filters) : undefined;
          const needsMemoryFilter =
            s.overdue !== undefined || (s.text !== undefined && s.text !== "");
          const tail = needsMemoryFilter
            ? sql`order by issued_on desc, id desc`
            : sql`order by issued_on desc, id desc limit ${page.limit + 1}`;
          return Effect.map(table.select(workspaceId, where, tail), (rows) => {
            const filtered = needsMemoryFilter
              ? rows.filter((row) => {
                  if (
                    s.overdue !== undefined &&
                    isOverdueRow(row, s.overdue.today) !== s.overdue.value
                  ) {
                    return false;
                  }
                  if (s.text !== undefined && s.text !== "") {
                    const needle = s.text.toLowerCase();
                    const hay = `${row.number ?? ""}\n${row.contact.name}`.toLowerCase();
                    if (!hay.includes(needle)) return false;
                  }
                  return true;
                })
              : rows;
            return {
              rows: filtered.slice(0, page.limit),
              more: filtered.length > page.limit,
            };
          });
        },
        reportable: (workspaceId, range) =>
          range.field === "issuedOn"
            ? table.select(
                workspaceId,
                sql`status in ('issued', 'cancelled')
                  and issued_on >= ${toPgDate(range.from)}::date
                  and issued_on <= ${toPgDate(range.to)}::date`,
              )
            : table.select(
                workspaceId,
                sql`status in ('issued', 'cancelled')
                  and kind <> 'proforma'
                  and coalesce(taxable_supply_on, issued_on) >= ${toPgDate(range.from)}::date
                  and coalesce(taxable_supply_on, issued_on) <= ${toPgDate(range.to)}::date`,
              ),
        receivable: (workspaceId) =>
          table.select(
            workspaceId,
            sql`status = 'issued'
              and kind in ('invoice', 'proforma')
              and settlement in ('unpaid', 'partially_paid')`,
          ),
        draftsUsingBankAccount: (workspaceId, bankAccountId) =>
          Effect.map(table.select(workspaceId, sql`status = 'draft'`), (rows) =>
            rows.filter(
              (row) =>
                row.given.bankAccount === bankAccountId ||
                row.issuer.bankAccount?.id === bankAccountId,
            ),
          ),
      });
    }),
  );
