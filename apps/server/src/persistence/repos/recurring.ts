/** `RecurringRepo` over `templates`, `template_lines`, `schedules`, and `schedule_runs`. */

import { RecurringRepo } from "@kvitbit/core";
import {
  DeliveryId,
  DocumentId,
  IsoDate,
  IssueCode,
  ScheduleId,
  TemplateId,
  TemplateInput as TemplateInputSchema,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  decodeStored,
  decodeWorkspaceId,
  encodeJson,
  encodeStored,
  formatNullableDecimal,
  parseJson,
} from "../codec";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

const readNullableText = decodeStored(Schema.NullOr(Schema.String));
const readNullableIsoDate = decodeStored(Schema.NullOr(IsoDate));
const readNullableIssueCode = decodeStored(Schema.NullOr(IssueCode));
const readNullableDocumentId = decodeStored(Schema.NullOr(DocumentId));
const readNullableDeliveryId = decodeStored(Schema.NullOr(DeliveryId));
const readTemplateId = decodeStored(TemplateId);
const readText = decodeStored(Schema.String);
const readScheduleId = decodeStored(ScheduleId);
const readCadenceUnit = decodeStored(Schema.Literals(["weeks", "months", "years"]));
const readIsoDate = decodeStored(IsoDate);
const readIssueAs = decodeStored(Schema.Literals(["invoice", "proforma"]));
const readRunOutcome = decodeStored(Schema.Literals(["issued", "failed", "skipped_missed"]));
const readRunSend = decodeStored(Schema.Literals(["none", "pending", "queued", "failed"]));

type TemplateRow = Effect.Success<ReturnType<RecurringRepo["Service"]["getTemplate"]>>;
type ScheduleRow = Effect.Success<ReturnType<RecurringRepo["Service"]["lockSchedule"]>>;
type RunRow = Effect.Success<ReturnType<RecurringRepo["Service"]["insertRun"]>>;

const templateInputJson = Schema.toCodecJson(TemplateInputSchema);
const encodeTemplateInput = encodeStored(templateInputJson);
const decodeTemplateInput = parseJson(templateInputJson);

const templateSpec: TableSpec<TemplateRow> = {
  table: "templates",
  collection: "templates",
  entity: "Template",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "name",
      "body",
      col.instant("archived_at"),
      col.instant("created_at"),
      col.instant("updated_at"),
    ],
    ", ",
  ),
  decode: decodeEach(
    (row): TemplateRow => ({
      id: readTemplateId(row.id),
      workspaceId: decodeWorkspaceId(row.workspace_id),
      revision: Number(row.revision),
      name: readText(row.name),
      input: decodeTemplateInput(row.body),
      archivedAt: readNullableText(row.archived_at ?? null),
      createdAt: readText(row.created_at),
      updatedAt: readText(row.updated_at),
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    kind: row.input.kind,
    contact_id: row.input.contact,
    series_id: row.input.series ?? null,
    bank_account_id: row.input.bankAccount ?? null,
    due_in_days: row.input.due?.inDays ?? null,
    body: encodeJson(encodeTemplateInput(row.input)),
    archived_at: row.archivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
  writeChildren: Effect.fn("writeChildren")(function* (row, mode) {
    const sql = yield* SqlClient.SqlClient;
    if (mode === "update") {
      yield* sql`
          delete from template_lines
          where workspace_id = ${row.workspaceId} and template_id = ${row.id}
        `;
    }
    if (!Arr.isReadonlyArrayNonEmpty(row.input.lines)) return;
    const lineRows = Arr.map(row.input.lines, (line, idx) => ({
      id: SecureRandom.uuidV4Unsafe(),
      workspace_id: row.workspaceId,
      template_id: row.id,
      position: idx,
      price_list_item_id: line.item ?? null,
      description: line.description ?? null,
      quantity: formatNullableDecimal(line.quantity ?? null),
      unit: line.unit ?? null,
      unit_price: formatNullableDecimal(line.unitPrice ?? null),
      vat: line.vat ?? null,
    }));
    yield* sql`insert into template_lines ${sql.insert(lineRows)}`;
  }),
};

const scheduleSpec: TableSpec<ScheduleRow> = {
  table: "schedules",
  collection: "schedules",
  entity: "Schedule",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "template_id",
      "cadence_unit",
      "cadence_interval",
      col.date("start_on"),
      col.date("end_on"),
      "issue_as",
      "auto_send",
      col.date("next_occurrence"),
      col.instant("paused_at"),
      "paused_reason",
      "paused_error",
      col.date("catch_up_through"),
      col.instant("detached_at"),
      col.instant("created_at"),
    ],
    ", ",
  ),
  decode: decodeEach(
    (row): ScheduleRow => ({
      id: readScheduleId(row.id),
      workspaceId: decodeWorkspaceId(row.workspace_id),
      revision: Number(row.revision),
      templateId: readTemplateId(row.template_id),
      cadenceUnit: readCadenceUnit(row.cadence_unit),
      cadenceInterval: Number(row.cadence_interval),
      startOn: readIsoDate(row.start_on),
      endOn: readNullableIsoDate(row.end_on ?? null),
      issueAs: readIssueAs(row.issue_as),
      autoSend: Boolean(row.auto_send),
      nextOccurrence: readNullableIsoDate(row.next_occurrence ?? null),
      pausedAt: readNullableText(row.paused_at ?? null),
      pausedReason: readNullableIssueCode(row.paused_reason ?? null),
      pausedError: readNullableText(row.paused_error ?? null),
      catchUpThrough: readNullableIsoDate(row.catch_up_through ?? null),
      detachedAt: readNullableText(row.detached_at ?? null),
      createdAt: readText(row.created_at),
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    template_id: row.templateId,
    cadence_unit: row.cadenceUnit,
    cadence_interval: row.cadenceInterval,
    start_on: row.startOn,
    end_on: row.endOn,
    issue_as: row.issueAs,
    auto_send: row.autoSend,
    next_occurrence: row.nextOccurrence,
    paused_at: row.pausedAt,
    paused_reason: row.pausedReason,
    paused_error: row.pausedError,
    catch_up_through: row.catchUpThrough,
    detached_at: row.detachedAt,
    created_at: row.createdAt,
  }),
};

const runSpec: TableSpec<RunRow> = {
  table: "schedule_runs",
  collection: "schedule_runs",
  entity: "Schedule",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "schedule_id",
      col.date("occurrence"),
      "outcome",
      col.instant("at"),
      "document_id",
      "(select d.number from documents d where d.workspace_id = schedule_runs.workspace_id and d.id = schedule_runs.document_id) as document_number",
      "delivery_id",
      "send_state",
      "failure",
    ],
    ", ",
  ),
  decode: decodeEach(
    (row: DbRow): RunRow => ({
      id: readText(row.id),
      workspaceId: decodeWorkspaceId(row.workspace_id),
      revision: Number(row.revision),
      scheduleId: readScheduleId(row.schedule_id),
      occurrence: readIsoDate(row.occurrence),
      outcome: readRunOutcome(row.outcome),
      at: readText(row.at),
      documentId: readNullableDocumentId(row.document_id ?? null),
      documentNumber: readNullableText(row.document_number ?? null),
      deliveryId: readNullableDeliveryId(row.delivery_id ?? null),
      send: readRunSend(row.send_state),
      failure: readNullableIssueCode(row.failure ?? null),
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    schedule_id: row.scheduleId,
    occurrence: row.occurrence,
    outcome: row.outcome,
    at: row.at,
    document_id: row.documentId,
    delivery_id: row.deliveryId,
    send_state: row.send,
    failure: row.failure,
  }),
};

export const RecurringRepoSql: Layer.Layer<RecurringRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    RecurringRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const templates = makeTable(sql, templateSpec);
      const schedules = makeTable(sql, scheduleSpec);
      const runs = makeTable(sql, runSpec);

      return RecurringRepo.of({
        getTemplate: Effect.fn("RecurringRepo.getTemplate")((ws, id) => templates.get(ws, id)),
        lockTemplate: Effect.fn("RecurringRepo.lockTemplate")((ws, id, expectedRevision) =>
          templates.getForUpdate(ws, id, expectedRevision),
        ),
        lockTemplateState: Effect.fn("RecurringRepo.lockTemplateState")((ws, id) =>
          templates.lock(ws, id),
        ),
        listTemplates: Effect.fn("RecurringRepo.listTemplates")((ws) =>
          templates.select(ws, sql`archived_at is null`, sql`order by name asc, id asc`),
        ),
        insertTemplate: templates.insert,
        updateTemplate: templates.update,

        attachedSchedule: Effect.fn("RecurringRepo.attachedSchedule")((ws, templateId) =>
          schedules.first(ws, sql`template_id = ${templateId} and detached_at is null`),
        ),
        schedulesOfTemplate: Effect.fn("RecurringRepo.schedulesOfTemplate")((ws, templateId) =>
          schedules.select(ws, sql`template_id = ${templateId}`, sql`order by created_at asc`),
        ),
        lockSchedule: Effect.fn("RecurringRepo.lockSchedule")((ws, id) => schedules.lock(ws, id)),
        insertSchedule: schedules.insert,
        updateSchedule: schedules.update,
        dueSchedules: Effect.fn("RecurringRepo.dueSchedules")((today) =>
          schedules.selectGlobal(
            sql`detached_at is null and paused_at is null and next_occurrence is not null and next_occurrence <= ${today}::date`,
            sql`order by next_occurrence asc`,
          ),
        ),

        findRun: Effect.fn("RecurringRepo.findRun")((ws, scheduleId, occurrence) =>
          runs.first(ws, sql`schedule_id = ${scheduleId} and occurrence = ${occurrence}::date`),
        ),
        lastIssuedRun: Effect.fn("RecurringRepo.lastIssuedRun")((ws, scheduleId) =>
          Effect.map(
            runs.select(
              ws,
              sql`schedule_id = ${scheduleId} and outcome = 'issued'`,
              sql`order by occurrence desc, id desc limit 1`,
            ),
            (rows) => Option.fromNullishOr(rows[0]),
          ),
        ),
        pendingSendRuns: Effect.fn("RecurringRepo.pendingSendRuns")((before) =>
          runs.selectGlobal(
            sql`outcome = 'issued' and send_state = 'pending' and at < ${before}::timestamptz`,
            sql`order by at asc`,
          ),
        ),
        insertRun: runs.insert,
        updateRun: runs.update,
        listRuns: Effect.fn("RecurringRepo.listRuns")((ws, query) => {
          if (query.scheduleIds.length === 0) return Effect.succeed([]);
          const after = query.after;
          const where =
            after !== undefined
              ? sql`schedule_id in ${sql.in(query.scheduleIds)}
                  and (occurrence < ${after[0]}::date or (occurrence = ${after[0]}::date and id < ${after[1]}::uuid))`
              : sql`schedule_id in ${sql.in(query.scheduleIds)}`;
          return runs.select(
            ws,
            where,
            sql`order by occurrence desc, id desc limit ${query.limit}`,
          );
        }),

        templatesUsingBankAccount: Effect.fn("RecurringRepo.templatesUsingBankAccount")(
          (ws, bankAccountId) =>
            templates.select(
              ws,
              sql`archived_at is null and bank_account_id = ${bankAccountId}`,
              sql`order by name asc, id asc`,
            ),
        ),
      });
    }),
  );
