/** `DocumentsRepo` over `documents`, `document_lines`, and `document_relations`. */

import { DocumentsModule, DocumentsRepo } from "@kvitbit/core";
import { StoreUnavailable } from "@kvitbit/core/ports";
import {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  type DocumentRelation,
  DocumentSettlement,
  DocumentStatus,
  IsoDate,
  LineId,
  Locale,
  NotFound,
  NumberingSeriesId,
  PaymentMethod,
  PriceListItemId,
  ScheduleId,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import {
  decodeStored,
  decodeWorkspaceId,
  encodeJson,
  encodeVatBreakdown,
  formatDecimal,
  formatNullableDecimal,
  parseDecimal,
  parseJson,
  parseNullableDecimal,
  StoredUuid,
  toJsonb,
  toPgDate,
  VatBreakdownJson,
} from "../codec";
import { writeErrors } from "../errors";
import { col, type DbRow, type DbValue, makeTable, type TableSpec } from "../table";
import { selectReportRows } from "./reportArchivePages";

const readNullablePriceListItemId = decodeStored(Schema.NullOr(PriceListItemId));
const readNullableText = decodeStored(Schema.NullOr(Schema.String));
const readNullableVatTreatment = decodeStored(Schema.NullOr(VatTreatment));
const readNullableDocumentId = decodeStored(Schema.NullOr(DocumentId));
const readNullableIsoDate = decodeStored(Schema.NullOr(IsoDate));
const readNullableNumberingSeriesId = decodeStored(Schema.NullOr(NumberingSeriesId));
const readNullableScheduleId = decodeStored(Schema.NullOr(ScheduleId));
const readText = decodeStored(Schema.String);
const readLineUuid = decodeStored(StoredUuid);
const readVatTreatment = decodeStored(VatTreatment);
const readDocumentId = decodeStored(DocumentId);
const readFxSource = decodeStored(Schema.Literals(["cnb", "manual"]));
const readDocumentKind = decodeStored(DocumentKind);
const readDocumentStatus = decodeStored(DocumentStatus);
const readContactId = decodeStored(ContactId);
const readCurrencyCode = decodeStored(CurrencyCode);
const readLocale = decodeStored(Locale);
const readPaymentMethod = decodeStored(PaymentMethod);
const readIsoDate = decodeStored(IsoDate);
const readPaymentRounding = decodeStored(Schema.Literals(["none", "whole_unit"]));
const readRemindersChoice = decodeStored(Schema.Literals(["on", "off", "inherit"]));
const readDocumentSettlement = decodeStored(DocumentSettlement);

type DocumentRecord = Effect.Success<ReturnType<DocumentsRepo["Service"]["get"]>>;
type LineRecord = DocumentRecord["lines"][number];
type LinkRecord = DocumentRecord["links"][number];

const isOverdueRow = (row: DocumentRecord, today: string): boolean =>
  (row.kind === "invoice" ||
    (row.kind === "proforma" && !Arr.some(row.links, (l) => l.relation === "final_invoice_for"))) &&
  row.status === "issued" &&
  (row.settlement === "unpaid" || row.settlement === "partially_paid") &&
  row.dueOn < today;

const readItemPrice = parseJson(Schema.Struct({ currency: CurrencyCode, net: Schema.String }));
const readFxOverride = parseJson(
  Schema.Struct({ manual: Schema.Struct({ rate: Schema.String, quantity: Schema.Finite }) }),
);
// Document updates write the snapshots back, so validate without dropping stored fields.
const {
  contact: ContactSnapshot,
  issuer: IssuerSnapshot,
  given: Given,
} = DocumentsModule.DocumentRecord.fields;
const readContact = parseJson(
  Schema.Unknown.pipe(Schema.refine(Schema.is(Schema.NullOr(ContactSnapshot)))),
);
const readIssuer = parseJson(
  Schema.Unknown.pipe(Schema.refine(Schema.is(Schema.NullOr(IssuerSnapshot)))),
);
const readGiven = parseJson(Schema.Unknown.pipe(Schema.refine(Schema.is(Given))));
const readVatBreakdown = parseJson(VatBreakdownJson);

const decodeItemPrice = (raw: DbValue): LineRecord["itemPrice"] => {
  if (Predicate.isNullish(raw)) return null;
  const parsed = readItemPrice(raw);
  return { currency: parsed.currency, net: parseDecimal(parsed.net) };
};

const encodeItemPrice = (value: LineRecord["itemPrice"]): string | null =>
  value === null ? null : encodeJson({ currency: value.currency, net: formatDecimal(value.net) });

const decodeFxOverride = (raw: DbValue): DocumentRecord["fxOverride"] => {
  if (Predicate.isNullish(raw)) return null;
  const parsed = readFxOverride(raw);
  return {
    manual: { rate: parseDecimal(parsed.manual.rate), quantity: Number(parsed.manual.quantity) },
  };
};

const encodeFxOverride = (value: DocumentRecord["fxOverride"]): string | null =>
  value === null
    ? null
    : encodeJson({
        manual: { rate: formatDecimal(value.manual.rate), quantity: value.manual.quantity },
      });

const spec: TableSpec<DocumentRecord> = {
  table: "documents",
  collection: "documents",
  entity: "Document",
  constraints: {
    documents_number_unique: "documents_number_per_kind",
  },
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
  decode: Effect.fn("decode")(function* (rows) {
    const sql = yield* SqlClient.SqlClient;
    const ids = Arr.map(rows, (r) => readText(r["id"]));
    const workspaceId = decodeWorkspaceId(rows[0]?.["workspace_id"]);

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
      const docId = readText(lr["document_id"]);
      let list = linesByDoc.get(docId);
      if (list === undefined) {
        list = [];
        linesByDoc.set(docId, list);
      }
      list.push({
        id: LineId.make(readLineUuid(lr["id"]), { disableChecks: true }),
        item: readNullablePriceListItemId(lr["price_list_item_id"] ?? null),
        description: readText(lr["description"]),
        quantity: parseDecimal(lr["quantity"]),
        unit: readNullableText(lr["unit"] ?? null),
        unitPrice: parseDecimal(lr["unit_price"]),
        itemPrice: decodeItemPrice(lr["item_price"]),
        vat: readNullableVatTreatment(lr["given_vat"] ?? null),
        itemVat: readNullableVatTreatment(lr["item_vat"] ?? null),
        treatment: readVatTreatment(lr["vat"]),
        ratePercent: parseDecimal(lr["rate_percent"]),
        amount: parseDecimal(lr["amount"]),
        deducts: readNullableDocumentId(lr["deducts_document_id"] ?? null),
        deductedVat: parseNullableDecimal(lr["deducted_vat"]),
        deductedVatCzk: parseNullableDecimal(lr["deducted_vat_czk"]),
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

    const decoded: DocumentRecord[] = [];
    for (const row of rows) {
      const docId = readDocumentId(row["id"]);
      const contact = readContact(row["contact_snapshot"] ?? null);
      const issuer = readIssuer(row["issuer_snapshot"] ?? null);
      if (contact === null || issuer === null) {
        // Current contact or issuer data cannot replace a missing historical snapshot.
        return yield* StoreUnavailable.make({
          cause: new Error(`Document ${docId} has a missing contact or issuer snapshot`),
        });
      }
      const fx =
        row["fx_rate"] !== null &&
        row["fx_rate"] !== undefined &&
        row["fx_quantity"] !== null &&
        row["fx_quantity"] !== undefined &&
        row["fx_source"] !== null &&
        row["fx_source"] !== undefined
          ? {
              rate: parseDecimal(row["fx_rate"]),
              quantity: Number(row["fx_quantity"]),
              fixingDate: readNullableIsoDate(row["fx_fixing_date"] ?? null),
              source: readFxSource(row["fx_source"]),
            }
          : null;
      decoded.push({
        id: docId,
        workspaceId: decodeWorkspaceId(row["workspace_id"]),
        revision: Number(row["revision"]),
        kind: readDocumentKind(row["kind"]),
        status: readDocumentStatus(row["status"]),
        locked: Boolean(row["locked"]),
        lockedAt: readNullableText(row["locked_at"] ?? null),
        number: readNullableText(row["number"] ?? null),
        seriesId: readNullableNumberingSeriesId(row["series_id"] ?? null),
        contactId: readContactId(row["contact_id"]),
        contact,
        issuer,
        given: readGiven(row["given"]),
        currency: readCurrencyCode(row["currency"]),
        language: readLocale(row["language"]),
        paymentMethod: readPaymentMethod(row["payment_method"]),
        note: readNullableText(row["note"] ?? null),
        issuedOn: readIsoDate(row["issued_on"]),
        taxableSupplyOn: readNullableIsoDate(row["taxable_supply_on"] ?? null),
        dueOn: readIsoDate(row["due_on"]),
        pricesIncludeVat: Boolean(row["prices_include_vat"]),
        variableSymbol: readNullableText(row["variable_symbol"] ?? null),
        orderNumber: readNullableText(row["order_number"] ?? null),
        lines: linesByDoc.get(docId) ?? [],
        totals: readVatBreakdown(row["vat_breakdown"]),
        fx,
        fxOverride: decodeFxOverride(row["fx_override"]),
        taxDocument: Boolean(row["tax_document"]),
        paymentRounding: readPaymentRounding(row["payment_rounding"]),
        remindersChoice: readRemindersChoice(row["reminders_choice"]),
        remindersOn: Boolean(row["reminders_on"]),
        links: linksByDoc.get(docId) ?? [],
        paidAmount: parseDecimal(row["paid_amount"]),
        payments: Number(row["payments"]),
        settlement: readDocumentSettlement(row["settlement"]),
        scheduleId: readNullableScheduleId(row["schedule_id"] ?? null),
        occurrence: readNullableIsoDate(row["occurrence"] ?? null),
        cancelledOn: readNullableIsoDate(row["cancelled_on"] ?? null),
        correctedNumber: readNullableText(row["corrected_number"] ?? null),
        reason:
          readNullableText(row["correction_reason"] ?? null) ??
          readNullableText(row["cancellation_reason"] ?? null) ??
          null,
        createdAt: readText(row["created_at"]),
        updatedAt: readText(row["updated_at"]),
        issuedAt: readNullableText(row["issued_at"] ?? null),
      });
    }
    return decoded;
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
    vat_breakdown: encodeJson(encodeVatBreakdown(row.totals)),
    total_net: formatDecimal(row.totals.net.amount),
    total_vat: formatDecimal(row.totals.vat.amount),
    total_gross: formatDecimal(row.totals.gross.amount),
    fx_rate: formatNullableDecimal(row.fx?.rate ?? null),
    fx_quantity: row.fx?.quantity ?? null,
    fx_fixing_date: row.fx?.fixingDate ?? null,
    fx_source: row.fx?.source ?? null,
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
  writeChildren: Effect.fn("writeChildren")(function* (row, mode) {
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
    if (Arr.isReadonlyArrayNonEmpty(row.lines)) {
      const lineRows = Arr.map(row.lines, (l, idx) => ({
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
      }));
      yield* sql`insert into document_lines ${sql.insert(lineRows)}`;
    }
    if (Arr.isReadonlyArrayNonEmpty(row.links)) {
      const relRows = Arr.map(row.links, (link) => ({
        workspace_id: row.workspaceId,
        from_document_id: row.id,
        to_document_id: link.id,
        relation: link.relation,
      }));
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
        get: Effect.fn("DocumentsRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
        getMany: Effect.fn("DocumentsRepo.getMany")((workspaceId, ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : table.select(workspaceId, sql`id in ${sql.in(ids)}`),
        ),
        getForUpdate: Effect.fn("DocumentsRepo.getForUpdate")((workspaceId, id, expectedRevision) =>
          table.getForUpdate(workspaceId, id, expectedRevision),
        ),
        lock: Effect.fn("DocumentsRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
        insert: table.insert,
        update: table.update,
        remove: Effect.fn("DocumentsRepo.remove")((workspaceId, id, expectedRevision) =>
          table.remove(workspaceId, id, expectedRevision),
        ),
        linkSchedule: Effect.fn("DocumentsRepo.linkSchedule")((workspaceId, id, link) =>
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
                Effect.asVoid(
                  Effect.when(
                    NotFound.make({ entity: "Document", id }),
                    Effect.succeed(rows.length === 0),
                  ),
                ),
              ),
            ),
        ),
        search: Effect.fn("DocumentsRepo.search")((workspaceId, s, page) => {
          const filters: Statement.Fragment[] = [];
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
              ? Arr.filter(rows, (row) => {
                  if (
                    s.overdue !== undefined &&
                    isOverdueRow(row, s.overdue.today) !== s.overdue.value
                  ) {
                    return false;
                  }
                  if (s.text !== undefined && s.text !== "") {
                    const needle = Str.toLowerCase(s.text);
                    const hay = Str.toLowerCase(`${row.number ?? ""}\n${row.contact.name}`);
                    if (!Str.includes(needle)(hay)) return false;
                  }
                  return true;
                })
              : rows;
            return {
              rows: filtered.slice(0, page.limit),
              more: filtered.length > page.limit,
            };
          });
        }),
        reportable: Effect.fn("DocumentsRepo.reportable")((workspaceId, range) =>
          selectReportRows(
            sql,
            "documents",
            range.field === "issuedOn"
              ? sql`status in ('issued', 'cancelled')
                  and issued_on >= ${toPgDate(range.from)}::date
                  and issued_on <= ${toPgDate(range.to)}::date`
              : sql`status in ('issued', 'cancelled')
                  and kind <> 'proforma'
                  and coalesce(taxable_supply_on, issued_on) >= ${toPgDate(range.from)}::date
                  and coalesce(taxable_supply_on, issued_on) <= ${toPgDate(range.to)}::date`,
            (where) => table.select(workspaceId, where),
          ),
        ),
        receivable: Effect.fn("DocumentsRepo.receivable")((workspaceId) =>
          table.select(
            workspaceId,
            sql`status = 'issued'
              and kind in ('invoice', 'proforma')
              and settlement in ('unpaid', 'partially_paid')`,
          ),
        ),
        draftsUsingBankAccount: Effect.fn("DocumentsRepo.draftsUsingBankAccount")(
          (workspaceId, bankAccountId) =>
            Effect.map(table.select(workspaceId, sql`status = 'draft'`), (rows) =>
              Arr.filter(
                rows,
                (row) =>
                  row.given.bankAccount === bankAccountId ||
                  row.issuer.bankAccount?.id === bankAccountId,
              ),
            ),
        ),
      });
    }),
  );
