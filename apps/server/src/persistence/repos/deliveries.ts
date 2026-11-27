/** `DeliveriesRepo` over `deliveries`. */

import { DeliveriesRepo, DocumentsModule } from "@kvitbit/core";
import {
  ContactId,
  DeliveryId,
  DeliveryPurpose,
  DeliveryStatus,
  DocumentId,
  ImageRef,
  IsoDate,
  Locale,
  PdfTemplate,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  attachDeliverySnapshot,
  type DeliveryBrandingSnapshot,
  type DeliveryRenderSnapshot,
  markLegacyDeliveryView,
  projectDocumentFromSql,
  readDeliverySnapshot,
  readLegacyDeliveryInfo,
} from "../../projections/documents";
import {
  asStringArray,
  decodeStored,
  encodeJson,
  encodeStored,
  parseJson,
  toJsonb,
} from "../codec";
import { unavailable } from "../errors";
import { col, type DbRow, type DbValue, decodeEach, makeTable, type TableSpec } from "../table";

const readNullableText = decodeStored(Schema.NullOr(Schema.String));
const readNullableLastOutcome = decodeStored(
  Schema.NullOr(Schema.Literals(["not_accepted", "outcome_unknown"])),
);
const readIsoDate = decodeStored(IsoDate);
const readDeliveryId = decodeStored(DeliveryId);
const readWorkspaceId = decodeStored(WorkspaceId);
const readDocumentId = decodeStored(DocumentId);
const readDeliveryPurpose = decodeStored(DeliveryPurpose);
const readDeliveryStatus = decodeStored(DeliveryStatus);
const readLocale = decodeStored(Locale);
const readText = decodeStored(Schema.String);
const readContactId = decodeStored(ContactId);

type DeliveryRecord = Effect.Success<ReturnType<DeliveriesRepo["Service"]["get"]>>;

const documentViewJson = Schema.toCodecJson(DocumentsModule.DocumentViewCodec);
const encodeDocumentView = encodeStored(documentViewJson);
const decodeDocumentView = decodeStored(documentViewJson);

const DeliverySnapshotJson = Schema.Struct({
  variableSymbol: Schema.NullOr(Schema.String),
  orderNumber: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  amountDue: Schema.String,
  template: PdfTemplate,
  branding: Schema.optional(
    Schema.Struct({
      workspaceRevision: Schema.Finite,
      accentColor: Schema.String,
      footerText: Schema.NullOr(Schema.String),
      logo: Schema.NullOr(ImageRef),
      stamp: Schema.NullOr(ImageRef),
    }),
  ),
});

const readRenderModel = parseJson(Schema.JsonObject);
const readSnapshot = decodeStored(DeliverySnapshotJson);
const readJsonObject = decodeStored(Schema.JsonObject);
const readAttachment = parseJson(
  Schema.Struct({
    filename: Schema.String,
    contentType: Schema.String,
    template: PdfTemplate,
  }),
);
// Legacy rows without an attachment can still be read and moved to failed.
const missingLegacyAttachment = {
  filename: "document.pdf",
  contentType: "application/pdf",
  template: "classic",
} as const;
const readImageRef = parseJson(ImageRef);
const readIssuer = decodeStored(DocumentsModule.DocumentRecord.fields.issuer);

const decodeRenderModel = (
  raw: DbValue,
  meta: { readonly deliveryId: DeliveryId; readonly workspaceId: WorkspaceId },
): DeliveryRecord["view"] => {
  const { __snapshot, ...viewJson } = readRenderModel(raw);
  const view = decodeDocumentView(viewJson);
  if (__snapshot !== undefined) {
    const snapshotRaw = readSnapshot(__snapshot);
    const snapshot: DeliveryRenderSnapshot = {
      variableSymbol: snapshotRaw.variableSymbol,
      orderNumber: snapshotRaw.orderNumber,
      note: snapshotRaw.note,
      amountDue: BigDecimal.fromStringUnsafe(snapshotRaw.amountDue),
      template: snapshotRaw.template,
      branding: snapshotRaw.branding,
    };
    return attachDeliverySnapshot(view, snapshot);
  }
  return markLegacyDeliveryView(view, meta);
};

const encodeRenderModel = (view: DeliveryRecord["view"]): string => {
  const encoded = readJsonObject(encodeDocumentView(view));
  const snapshot = readDeliverySnapshot(view);
  if (snapshot === undefined) return encodeJson(encoded);
  const serialized: typeof DeliverySnapshotJson.Type = {
    variableSymbol: snapshot.variableSymbol,
    orderNumber: snapshot.orderNumber,
    note: snapshot.note,
    amountDue: BigDecimal.format(snapshot.amountDue),
    template: snapshot.template,
    branding: snapshot.branding,
  };
  return encodeJson({ ...encoded, __snapshot: serialized });
};

const decodeRow = (row: DbRow): DeliveryRecord => {
  const reminder =
    row.reminder_due_on !== null &&
    row.reminder_due_on !== undefined &&
    row.reminder_offset_days !== null &&
    row.reminder_offset_days !== undefined &&
    row.reminder_armed_by !== null &&
    row.reminder_armed_by !== undefined
      ? {
          dueOn: readIsoDate(row.reminder_due_on),
          offsetDays: Number(row.reminder_offset_days),
          armedBy: Number(row.reminder_armed_by),
        }
      : null;

  const deliveryId = readDeliveryId(row.id);
  const workspaceId = readWorkspaceId(row.workspace_id);
  const view = decodeRenderModel(row.render_model, { deliveryId, workspaceId });
  const attachment =
    (Predicate.isNullish(row.attachment) || row.attachment === "null") &&
    readLegacyDeliveryInfo(view) !== undefined
      ? missingLegacyAttachment
      : readAttachment(row.attachment);

  return {
    id: deliveryId,
    workspaceId,
    revision: Number(row.revision),
    documentId: readDocumentId(row.document_id),
    sequence: Number(row.sequence),
    documentRevision: Number(row.document_revision),
    purpose: readDeliveryPurpose(row.purpose),
    status: readDeliveryStatus(row.status),
    to: asStringArray(row.recipients),
    replyTo: readNullableText(row.reply_to ?? null),
    language: readLocale(row.language),
    subject: readText(row.subject),
    view,
    attachment,
    contactId: readContactId(row.contact_id),
    arms: Boolean(row.arms),
    dueOn: readIsoDate(row.due_on),
    reminder,
    attempts: Number(row.attempts),
    lastOutcome: readNullableLastOutcome(row.last_outcome ?? null),
    failure: readNullableText(row.failure ?? null),
    provider: readNullableText(row.provider ?? null),
    providerMessageId: readNullableText(row.provider_message_id ?? null),
    createdAt: readText(row.created_at),
    updatedAt: readText(row.updated_at),
  };
};

const spec: TableSpec<DeliveryRecord> = {
  table: "deliveries",
  collection: "deliveries",
  entity: "Document",
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
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
    render_model: encodeRenderModel(row.view),
    attachment: row.attachment === missingLegacyAttachment ? null : toJsonb(row.attachment),
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
        get: Effect.fn("DeliveriesRepo.get")((workspaceId, id) =>
          table.get(workspaceId, id).pipe(
            Effect.flatMap((row) => {
              if (row.status !== "sending" || readLegacyDeliveryInfo(row.view) === undefined) {
                return Effect.succeed(row);
              }
              const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
              return sql`
                update deliveries
                set status = 'failed',
                    failure = ${"delivery.snapshot_missing"},
                    revision = revision + 1,
                    updated_at = ${updatedAt}::timestamptz
                where workspace_id = ${workspaceId}
                  and id = ${id}
                  and revision = ${row.revision}
                  and status = 'sending'
              `.pipe(Effect.catch(unavailable), Effect.andThen(table.get(workspaceId, id)));
            }),
          ),
        ),
        lock: Effect.fn("DeliveriesRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
        insert: Effect.fn("DeliveriesRepo.insert")(function* (row) {
          const wsRows = yield* sql<{
            readonly revision: number;
            readonly pdf_template: PdfTemplate;
            readonly accent_color: string | null;
            readonly footer_text: string | null;
            readonly logo: DbValue;
            readonly stamp: DbValue;
          }>`
              select revision, pdf_template, accent_color, footer_text, logo, stamp
              from workspaces
              where id = ${row.workspaceId}
              limit 1
            `.pipe(Effect.catch(unavailable));
          const wsRow = wsRows[0];
          const effectiveTemplate =
            row.attachment.template === "classic" && wsRow !== undefined
              ? wsRow.pdf_template
              : row.attachment.template;
          const brandingSnapshot: DeliveryBrandingSnapshot | undefined =
            wsRow === undefined
              ? undefined
              : {
                  workspaceRevision: Number(wsRow.revision),
                  accentColor: wsRow.accent_color ?? "#1F5FAF",
                  footerText: wsRow.footer_text ?? null,
                  logo: Predicate.isNullish(wsRow.logo) ? null : readImageRef(wsRow.logo),
                  stamp: Predicate.isNullish(wsRow.stamp) ? null : readImageRef(wsRow.stamp),
                };
          const issuer = readIssuer(row.view.issuer);
          const projected = yield* projectDocumentFromSql(sql, row.workspaceId, row.documentId, {
            kind: row.view.kind,
            status: row.view.status,
            number: row.view.number,
            currency: row.view.totals.gross.currency,
            issuer,
            dueOn: row.view.dates.dueOn,
          }).pipe(Effect.catch(unavailable));

          const enrichedView =
            projected === undefined
              ? row.view
              : attachDeliverySnapshot(
                  projected.paymentQr === null
                    ? { ...row.view }
                    : { ...row.view, paymentQr: projected.paymentQr },
                  {
                    variableSymbol: projected.variableSymbol,
                    orderNumber: projected.orderNumber,
                    note: projected.note,
                    amountDue: projected.amountDue,
                    template: effectiveTemplate,
                    branding: brandingSnapshot,
                  },
                );

          return yield* table.insert({
            ...row,
            view: enrichedView,
            attachment: { ...row.attachment, template: effectiveTemplate },
          });
        }),
        update: table.update,
        byDocument: Effect.fn("DeliveriesRepo.byDocument")((workspaceId, documentId) =>
          table.select(workspaceId, sql`document_id = ${documentId}`, sql`order by sequence asc`),
        ),
        reminderStep: Effect.fn("DeliveriesRepo.reminderStep")((workspaceId, step) =>
          table.first(
            workspaceId,
            sql`document_id = ${step.documentId}
              and reminder_due_on = ${step.dueOn}::date
              and reminder_offset_days = ${step.offsetDays}
              and reminder_armed_by = ${step.armedBy}
              and not (status = 'skipped' and attempts = 0 and last_outcome is null)`,
          ),
        ),
        statuses: Effect.fn("DeliveriesRepo.statuses")((workspaceId, ids) =>
          ids.length === 0
            ? Effect.succeed(new Map<DeliveryId, DeliveryStatus>())
            : sql<{ readonly id: DeliveryId; readonly status: DeliveryStatus }>`
                select id, status
                from deliveries
                where workspace_id = ${workspaceId} and id in ${sql.in(ids)}
              `.pipe(
                Effect.map((rows) => new Map(Arr.map(rows, (r) => [r.id, r.status] as const))),
                Effect.catch(unavailable),
              ),
        ),
        findStaleQueuedOrSending: Effect.fn("DeliveriesRepo.findStaleQueuedOrSending")((before) =>
          table.selectGlobal(
            sql`status in ('queued', 'sending') and updated_at < ${before}::timestamptz`,
            sql`order by updated_at asc`,
          ),
        ),
      });
    }),
  );
