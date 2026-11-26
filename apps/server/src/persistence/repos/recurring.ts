/** `RecurringRepo` over `templates`, `template_lines`, `schedules`, and `schedule_runs`. */
import { RecurringRepo } from "@kvitbit/core";
import type {
  DeliveryId,
  DocumentId,
  IsoDate,
  IssueCode,
  ScheduleId,
  TemplateId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { TemplateInput as TemplateInputSchema } from "@kvitbit/domain/contract";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { formatNullableDecimal, parseJson } from "../codec";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type TemplateRow = Effect.Success<ReturnType<RecurringRepo["Service"]["getTemplate"]>>;
type ScheduleRow = Effect.Success<ReturnType<RecurringRepo["Service"]["lockSchedule"]>>;
type RunRow = Effect.Success<ReturnType<RecurringRepo["Service"]["insertRun"]>>;

const templateInputJson = Schema.toCodecJson(TemplateInputSchema);
const encodeTemplateInput = Schema.encodeSync(templateInputJson);
const decodeTemplateInput = Schema.decodeUnknownSync(templateInputJson);

const templateSpec: TableSpec<TemplateRow> = {
  table: "templates",
  collection: "templates",
  entity: "Template",
  select: [
    "id",
    "workspace_id",
    "revision",
    "name",
    "body",
    col.instant("archived_at"),
    col.instant("created_at"),
    col.instant("updated_at"),
  ].join(", "),
  decode: decodeEach(
    (row): TemplateRow => ({
      id: row.id as TemplateId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      name: row.name as string,
      input: decodeTemplateInput(parseJson<unknown>(row.body)),
      archivedAt: (row.archived_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
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
    body: JSON.stringify(encodeTemplateInput(row.input)),
    archived_at: row.archivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
  writeChildren: (row, mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (mode === "update") {
        yield* sql`
          delete from template_lines
          where workspace_id = ${row.workspaceId} and template_id = ${row.id}
        `;
      }
      if (row.input.lines.length === 0) return;
      const lineRows = row.input.lines.map((line, idx) => ({
        id: crypto.randomUUID(),
        workspace_id: row.workspaceId,
        template_id: row.id,
        position: idx,
        price_list_item_id: line.item ?? null,
        description: line.description ?? null,
        quantity: formatNullableDecimal(line.quantity ?? null),
        unit: line.unit ?? null,
        unit_price: formatNullableDecimal(line.unitPrice ?? null),
        vat: line.vat ?? null,
      })) as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
      yield* sql`insert into template_lines ${sql.insert(lineRows)}`;
    }),
};

const scheduleSpec: TableSpec<ScheduleRow> = {
  table: "schedules",
  collection: "schedules",
  entity: "Schedule",
  select: [
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
  ].join(", "),
  decode: decodeEach(
    (row): ScheduleRow => ({
      id: row.id as ScheduleId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      templateId: row.template_id as TemplateId,
      cadenceUnit: row.cadence_unit as ScheduleRow["cadenceUnit"],
      cadenceInterval: Number(row.cadence_interval),
      startOn: row.start_on as IsoDate,
      endOn: (row.end_on as IsoDate | null) ?? null,
      issueAs: row.issue_as as ScheduleRow["issueAs"],
      autoSend: Boolean(row.auto_send),
      nextOccurrence: (row.next_occurrence as IsoDate | null) ?? null,
      pausedAt: (row.paused_at as string | null) ?? null,
      pausedReason: (row.paused_reason as IssueCode | null) ?? null,
      pausedError: (row.paused_error as string | null) ?? null,
      catchUpThrough: (row.catch_up_through as IsoDate | null) ?? null,
      detachedAt: (row.detached_at as string | null) ?? null,
      createdAt: row.created_at as string,
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
  select: [
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
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): RunRow => ({
      id: row.id as string,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      scheduleId: row.schedule_id as ScheduleId,
      occurrence: row.occurrence as IsoDate,
      outcome: row.outcome as RunRow["outcome"],
      at: row.at as string,
      documentId: (row.document_id as DocumentId | null) ?? null,
      documentNumber: (row.document_number as string | null) ?? null,
      deliveryId: (row.delivery_id as DeliveryId | null) ?? null,
      send: row.send_state as RunRow["send"],
      failure: (row.failure as IssueCode | null) ?? null,
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
        getTemplate: (ws, id) => templates.get(ws, id),
        lockTemplate: (ws, id, expectedRevision) =>
          templates.getForUpdate(ws, id, expectedRevision),
        lockTemplateState: (ws, id) => templates.lock(ws, id),
        listTemplates: (ws) =>
          templates.select(ws, sql`archived_at is null`, sql`order by name asc, id asc`),
        insertTemplate: templates.insert,
        updateTemplate: templates.update,

        attachedSchedule: (ws, templateId) =>
          schedules.first(ws, sql`template_id = ${templateId} and detached_at is null`),
        schedulesOfTemplate: (ws, templateId) =>
          schedules.select(ws, sql`template_id = ${templateId}`, sql`order by created_at asc`),
        lockSchedule: (ws, id) => schedules.lock(ws, id),
        insertSchedule: schedules.insert,
        updateSchedule: schedules.update,
        dueSchedules: (today) =>
          schedules.selectGlobal(
            sql`detached_at is null and paused_at is null and next_occurrence is not null and next_occurrence <= ${today}::date`,
            sql`order by next_occurrence asc`,
          ),

        findRun: (ws, scheduleId, occurrence) =>
          runs.first(ws, sql`schedule_id = ${scheduleId} and occurrence = ${occurrence}::date`),
        lastIssuedRun: (ws, scheduleId) =>
          Effect.map(
            runs.select(
              ws,
              sql`schedule_id = ${scheduleId} and outcome = 'issued'`,
              sql`order by occurrence desc, id desc limit 1`,
            ),
            (rows) => Option.fromNullishOr(rows[0]),
          ),
        pendingSendRuns: (before) =>
          runs.selectGlobal(
            sql`outcome = 'issued' and send_state = 'pending' and at < ${before}::timestamptz`,
            sql`order by at asc`,
          ),
        insertRun: runs.insert,
        updateRun: runs.update,
        listRuns: (ws, query) => {
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
        },

        templatesUsingBankAccount: (ws, bankAccountId) =>
          templates.select(
            ws,
            sql`archived_at is null and bank_account_id = ${bankAccountId}`,
            sql`order by name asc, id asc`,
          ),
      });
    }),
  );
