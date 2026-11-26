/** `DeliveriesRepo` over `deliveries`. */
import { DeliveriesRepo, DocumentsModule } from "@kvitbit/core";
import type {
  ContactId,
  DeliveryId,
  DeliveryPurpose,
  DocumentId,
  IsoDate,
  Locale,
  PdfTemplate,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { asStringArray, parseJson, toJsonb } from "../codec";
import { unavailable } from "../errors";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type DeliveryRecord = Effect.Success<ReturnType<DeliveriesRepo["Service"]["get"]>>;
type DeliveryStatus = DeliveryRecord["status"];

const documentViewJson = Schema.toCodecJson(DocumentsModule.DocumentViewCodec);
const encodeDocumentView = Schema.encodeSync(documentViewJson);
const decodeDocumentView = Schema.decodeUnknownSync(documentViewJson);

const decodeRow = (row: DbRow): DeliveryRecord => {
  const reminder =
    row.reminder_due_on != null && row.reminder_offset_days != null && row.reminder_armed_by != null
      ? {
          dueOn: row.reminder_due_on as IsoDate,
          offsetDays: Number(row.reminder_offset_days),
          armedBy: Number(row.reminder_armed_by),
        }
      : null;

  const attachment = parseJson<{
    readonly filename: string;
    readonly contentType: string;
    readonly template: PdfTemplate;
  }>(row.attachment);

  return {
    id: row.id as DeliveryId,
    workspaceId: row.workspace_id as WorkspaceId,
    revision: Number(row.revision),
    documentId: row.document_id as DocumentId,
    sequence: Number(row.sequence),
    documentRevision: Number(row.document_revision),
    purpose: row.purpose as DeliveryPurpose,
    status: row.status as DeliveryStatus,
    to: asStringArray(row.recipients),
    replyTo: (row.reply_to as string | null) ?? null,
    language: row.language as Locale,
    subject: row.subject as string,
    view: decodeDocumentView(parseJson<unknown>(row.render_model)),
    attachment,
    contactId: row.contact_id as ContactId,
    arms: Boolean(row.arms),
    dueOn: row.due_on as IsoDate,
    reminder,
    attempts: Number(row.attempts),
    lastOutcome: (row.last_outcome as "not_accepted" | "outcome_unknown" | null) ?? null,
    failure: (row.failure as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    providerMessageId: (row.provider_message_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
};

const spec: TableSpec<DeliveryRecord> = {
  table: "deliveries",
  collection: "deliveries",
  entity: "Document",
  select: [
    "id",
    "workspace_id",
    "revision",
    "document_id",
    "sequence",
    "document_revision",
    "purpose",
    "status",
    "recipients",
    "reply_to",
    "language",
    "subject",
    "render_model",
    "attachment",
    "contact_id",
    "arms",
    col.date("due_on"),
    col.date("reminder_due_on"),
    "reminder_offset_days",
    "reminder_armed_by",
    "attempts",
    "last_outcome",
    "failure",
    "provider",
    "provider_message_id",
    col.instant("created_at"),
    col.instant("updated_at"),
  ].join(", "),
  decode: decodeEach(decodeRow),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    document_id: row.documentId,
    sequence: row.sequence,
    document_revision: row.documentRevision,
    purpose: row.purpose,
    status: row.status,
    recipients: [...row.to],
    reply_to: row.replyTo,
    language: row.language,
    subject: row.subject,
    render_model: JSON.stringify(encodeDocumentView(row.view)),
    attachment: toJsonb(row.attachment),
    contact_id: row.contactId,
    arms: row.arms,
    due_on: row.dueOn,
    reminder_due_on: row.reminder?.dueOn ?? null,
    reminder_offset_days: row.reminder?.offsetDays ?? null,
    reminder_armed_by: row.reminder?.armedBy ?? null,
    attempts: row.attempts,
    last_outcome: row.lastOutcome,
    failure: row.failure,
    provider: row.provider,
    provider_message_id: row.providerMessageId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
};

export const DeliveriesRepoSql: Layer.Layer<DeliveriesRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    DeliveriesRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const table = makeTable(sql, spec);

      return DeliveriesRepo.of({
        get: (workspaceId, id) => table.get(workspaceId, id),
        lock: (workspaceId, id) => table.lock(workspaceId, id),
        insert: table.insert,
        update: table.update,
        byDocument: (workspaceId, documentId) =>
          table.select(workspaceId, sql`document_id = ${documentId}`, sql`order by sequence asc`),
        reminderStep: (workspaceId, step) =>
          table.first(
            workspaceId,
            sql`document_id = ${step.documentId}
              and reminder_due_on = ${step.dueOn}::date
              and reminder_offset_days = ${step.offsetDays}
              and reminder_armed_by = ${step.armedBy}
              and not (status = 'skipped' and attempts = 0 and last_outcome is null)`,
          ),
        statuses: (workspaceId, ids) =>
          ids.length === 0
            ? Effect.succeed(new Map())
            : sql<{ readonly id: DeliveryId; readonly status: DeliveryStatus }>`
                select id, status
                from deliveries
                where workspace_id = ${workspaceId} and id in ${sql.in(ids)}
              `.pipe(
                Effect.map((rows) => new Map(rows.map((r) => [r.id, r.status] as const))),
                Effect.catch(unavailable),
              ),
        findStaleQueuedOrSending: (before) =>
          table.selectGlobal(
            sql`status in ('queued', 'sending') and updated_at < ${before}::timestamptz`,
            sql`order by updated_at asc`,
          ),
      });
    }),
  );
