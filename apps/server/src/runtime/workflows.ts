/**
 * Effect Cluster Workflows for Kvitbit (core-ports.md 7.2, board #894/#908):
 * - `DocumentDeliveryWorkflow`: claim -> dispatch (with retry on `DeliveryRetry`) -> giveUp
 * - `RecurringIssuanceWorkflow`: `recurringJob.run` (issue + advance + auto-send)
 * - `DataExportWorkflow`: build ZIP (reportingTables + full workspace tables + attachments/PDFs)
 *   -> upload to `BlobStorage` -> `exportJob.finish` / `exportJob.fail`
 * - `MemberInvitationWorkflow`: `invitationJob.getPending` -> E04 invitation email ->
 *   `DurableClock.sleep` until expiry -> `invitationJob.expirePending`
 *
 * Every core step runs through `@kvitbit/core`'s sealed `CoreJobs` entry points — zero caller
 * forging.
 */
import { renderEmail } from "@kvitbit/adapters/templates/email";
import {
  deliveryJob,
  exportJob,
  InvitationTokens,
  invitationJob,
  ReportsModule,
  recurringJob,
  UserDirectory,
  WorkspacesRepo,
} from "@kvitbit/core";
import {
  DeliveryId,
  type DocumentId,
  ExportId,
  InvitationId,
  IsoDate,
  type Locale,
  ScheduleId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { type BlobKey, BlobStorage, EmailSender } from "@kvitbit/domain/ports";
import { Cause, Clock, Config, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";
import { buildZip, type ZipEntry } from "./zip";

// 1. Workflow definitions ---------------------------------------------------------------------

const DeliveryOutcome = Schema.Literals(["sent", "failed", "skipped"]);
type DeliveryOutcome = typeof DeliveryOutcome.Type;

export const DocumentDeliveryWorkflow = Workflow.make("kvitbit/DocumentDelivery", {
  payload: {
    workspaceId: WorkspaceId,
    deliveryId: DeliveryId,
    /** 0 for initial start (key = deliveryId); >0 for J1a reconcile re-execution after a finished run. */
    attempt: Schema.optional(Schema.Int),
  },
  idempotencyKey: ({ deliveryId, attempt }) =>
    attempt !== undefined && attempt > 0 ? `${deliveryId}:reconcile:${attempt}` : deliveryId,
  success: DeliveryOutcome,
});

const RecurringOutcome = Schema.Literals(["issued", "paused", "skipped"]);
type RecurringOutcome = typeof RecurringOutcome.Type;

export const RecurringIssuanceWorkflow = Workflow.make("kvitbit/RecurringIssuance", {
  payload: {
    workspaceId: WorkspaceId,
    scheduleId: ScheduleId,
    occurrence: IsoDate,
  },
  idempotencyKey: ({ scheduleId, occurrence }) => `${scheduleId}:${occurrence}`,
  success: RecurringOutcome,
});

const DataExportOutcome = Schema.Literals(["ready", "failed"]);

export const DataExportWorkflow = Workflow.make("kvitbit/DataExport", {
  payload: {
    workspaceId: WorkspaceId,
    exportId: ExportId,
  },
  idempotencyKey: ({ exportId }) => exportId,
  success: DataExportOutcome,
});

const InvitationOutcome = Schema.Literals(["sent_and_checked", "skipped"]);

export const MemberInvitationWorkflow = Workflow.make("kvitbit/MemberInvitation", {
  payload: {
    workspaceId: WorkspaceId,
    invitationId: InvitationId,
    epoch: Schema.Int,
  },
  idempotencyKey: ({ invitationId, epoch }) => `${invitationId}:${epoch}`,
  success: InvitationOutcome,
});

// 2. Options & retry policies -----------------------------------------------------------------

export interface WorkflowHandlerOptions {
  /** Public origin for invitation links, e.g. `https://kvitbit.cz`. */
  readonly appOrigin?: string | undefined;
  /** Retry policy for `DocumentDelivery` dispatch on `DeliveryRetry`. */
  readonly deliveryRetrySchedule?: Schedule.Schedule<unknown, unknown> | undefined;
  /** Override sleep duration for `MemberInvitation` expiry (tests). */
  readonly invitationExpiryDuration?: Duration.Input | undefined;
}

/**
 * Default delivery retry policy (core-ports 7.2): exponential from 30 s, capped at 1 h,
 * up to 24 h total elapsed time.
 */
export const DEFAULT_DELIVERY_RETRY_SCHEDULE = Schedule.exponential(Duration.seconds(30)).pipe(
  Schedule.while(({ elapsed }) => elapsed < Duration.toMillis(Duration.hours(24))),
);

// 3. CSV + ZIP helpers for DataExport ---------------------------------------------------------

type CsvRow = Readonly<Record<string, string | null>>;

const csvEscape = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

const rowsToCsv = (rows: ReadonlyArray<CsvRow>): Uint8Array => {
  const encoder = new TextEncoder();
  const first = rows[0];
  if (first === undefined) return new Uint8Array(0);
  const headers = Object.keys(first);
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
  ];
  return encoder.encode(`${lines.join("\r\n")}\r\n`);
};

const collectStreamBytes = (
  stream: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<Uint8Array, unknown> =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }),
  );

const EXPORT_TABLES = [
  { file: "tables/workspaces.csv", table: "workspaces", filterCol: "id" },
  { file: "tables/issuing_entities.csv", table: "issuing_entities", filterCol: "workspace_id" },
  { file: "tables/tax_regime_periods.csv", table: "tax_regime_periods", filterCol: "workspace_id" },
  { file: "tables/memberships.csv", table: "memberships", filterCol: "workspace_id" },
  { file: "tables/invitations.csv", table: "invitations", filterCol: "workspace_id" },
  { file: "tables/bank_accounts.csv", table: "bank_accounts", filterCol: "workspace_id" },
  { file: "tables/numbering_series.csv", table: "numbering_series", filterCol: "workspace_id" },
  { file: "tables/contacts.csv", table: "contacts", filterCol: "workspace_id" },
  { file: "tables/price_list_items.csv", table: "price_list_items", filterCol: "workspace_id" },
  { file: "tables/documents.csv", table: "documents", filterCol: "workspace_id" },
  { file: "tables/document_lines.csv", table: "document_lines", filterCol: "workspace_id" },
  { file: "tables/document_relations.csv", table: "document_relations", filterCol: "workspace_id" },
  { file: "tables/payments.csv", table: "payments", filterCol: "workspace_id" },
  { file: "tables/deliveries.csv", table: "deliveries", filterCol: "workspace_id" },
  { file: "tables/share_links.csv", table: "share_links", filterCol: "workspace_id" },
  { file: "tables/expenses.csv", table: "expenses", filterCol: "workspace_id" },
  { file: "tables/attachments.csv", table: "attachments", filterCol: "workspace_id" },
  { file: "tables/templates.csv", table: "templates", filterCol: "workspace_id" },
  { file: "tables/schedules.csv", table: "schedules", filterCol: "workspace_id" },
  { file: "tables/schedule_runs.csv", table: "schedule_runs", filterCol: "workspace_id" },
  { file: "tables/audit_entries.csv", table: "audit_entries", filterCol: "workspace_id" },
] as const;

const isTerminalDelivery = (status: string): status is DeliveryOutcome =>
  status === "sent" || status === "failed" || status === "skipped";

// 4. Workflow handler layers ------------------------------------------------------------------

/**
 * Registers handlers for all 4 Kvitbit workflows (`DocumentDelivery`, `RecurringIssuance`,
 * `DataExport`, `MemberInvitation`).
 */
export const makeWorkflowHandlersLayer = (options: WorkflowHandlerOptions = {}) => {
  const retrySchedule = options.deliveryRetrySchedule ?? DEFAULT_DELIVERY_RETRY_SCHEDULE;
  const normalizedOrigin = (options.appOrigin ?? "http://localhost:8080").replace(/\/+$/, "");

  const DeliveryRetryError = Schema.Struct({
    _tag: Schema.Literal("DeliveryRetry"),
    deliveryId: DeliveryId,
    cause: Schema.Literals(["not_accepted", "outcome_unknown"]),
  });

  // 1. DocumentDelivery
  const documentDeliveryLayer = DocumentDeliveryWorkflow.toLayer(({ workspaceId, deliveryId }) =>
    Effect.gen(function* () {
      const claimed = yield* Activity.make({
        name: "claim",
        success: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
        execute: deliveryJob.claim(workspaceId, deliveryId).pipe(Effect.orDie),
      });

      if (isTerminalDelivery(claimed)) {
        return claimed;
      }

      const dispatchResult = yield* Activity.make({
        name: "dispatch",
        success: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
        error: DeliveryRetryError,
        execute: deliveryJob.dispatch(workspaceId, deliveryId).pipe(
          Effect.catchTag("DeliveryRetry", (err) =>
            Effect.fail({
              _tag: "DeliveryRetry" as const,
              deliveryId: err.deliveryId,
              cause: err.cause,
            }),
          ),
          Effect.orDie,
        ),
      }).pipe(Effect.retry({ schedule: retrySchedule }), Effect.result);

      if (dispatchResult._tag === "Success") {
        return isTerminalDelivery(dispatchResult.success) ? dispatchResult.success : "failed";
      }

      const gaveUp = yield* Activity.make({
        name: "give-up",
        success: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
        execute: deliveryJob
          .giveUp(workspaceId, deliveryId, "retries_exhausted")
          .pipe(Effect.orDie),
      });
      return isTerminalDelivery(gaveUp) ? gaveUp : "failed";
    }),
  );

  // 2. RecurringIssuance
  const recurringIssuanceLayer = RecurringIssuanceWorkflow.toLayer(
    ({ workspaceId, scheduleId, occurrence }) =>
      Activity.make({
        name: "run",
        success: RecurringOutcome,
        execute: recurringJob.run(workspaceId, scheduleId, occurrence).pipe(
          Effect.map((res): RecurringOutcome => {
            switch (res.issue._tag) {
              case "Issued":
                return "issued";
              case "Paused":
                return "paused";
              case "Skipped":
                return "skipped";
              default:
                return "skipped";
            }
          }),
          Effect.orDie,
        ),
      }),
  );

  // 3. DataExport
  const dataExportLayer = DataExportWorkflow.toLayer(({ workspaceId, exportId }) =>
    Effect.gen(function* () {
      const buildOutcome = yield* Activity.make({
        name: "build",
        success: Schema.Struct({ sizeBytes: Schema.Int }),
        error: Schema.Struct({ reason: Schema.String }),
        execute: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const blobs = yield* BlobStorage;
          const entries: Array<ZipEntry> = [];

          // Determine workspace locale (fallback "cs")
          const wsRows = yield* sql<{ readonly default_language: string }>`
            SELECT default_language FROM workspaces WHERE id = ${workspaceId}
          `;
          const locale: Locale = wsRows[0]?.default_language === "en" ? "en" : "cs";

          // Canonical reporting CSVs from CoreJobs
          const reportingFiles = yield* exportJob.reportingTables(workspaceId, exportId, locale);
          for (const file of reportingFiles) {
            const bytes = yield* collectStreamBytes(file.bytes);
            entries.push({ name: file.name, bytes });
          }

          // Full workspace tables as CSVs
          for (const spec of EXPORT_TABLES) {
            // Text at the PostgreSQL boundary keeps decimals exact and avoids unregistered enum array types.
            const rows = yield* sql.unsafe<{ readonly data: CsvRow }>(
              `SELECT (SELECT jsonb_object_agg(key, value) FROM jsonb_each_text(to_jsonb(source_row))) AS data
               FROM ${spec.table} AS source_row
               WHERE ${spec.filterCol} = $1
               ORDER BY data`,
              [workspaceId],
            );
            entries.push({ name: spec.file, bytes: rowsToCsv(rows.map(({ data }) => data)) });
          }

          // Expense attachments from BlobStorage
          const attachmentRows = yield* sql<{
            readonly id: string;
            readonly file_name: string | null;
            readonly blob_key: string;
          }>`
            SELECT id, file_name, blob_key
            FROM attachments
            WHERE workspace_id = ${workspaceId} AND expense_id IS NOT NULL
          `;
          for (const att of attachmentRows) {
            const bytes = yield* blobs
              .get(att.blob_key as BlobKey)
              .pipe(Effect.flatMap((stream) => collectStreamBytes(stream)));
            const safeName = (att.file_name || "attachment").replace(/[/\\]/g, "_");
            entries.push({ name: `attachments/${att.id}-${safeName}`, bytes });
          }

          // Use a cached revision when present. An export also includes PDFs never downloaded before.
          const docRows = yield* sql<{
            readonly id: DocumentId;
            readonly number: string | null;
            readonly revision: number;
          }>`
            SELECT id, number, revision
            FROM documents
            WHERE workspace_id = ${workspaceId} AND status <> 'draft'
          `;
          for (const doc of docRows) {
            const pdfKey = `pdf/${workspaceId}/${doc.id}/${doc.revision}.pdf` as BlobKey;
            const pdf = yield* blobs
              .get(pdfKey)
              .pipe(
                Effect.catchTag("BlobMissing", () =>
                  Effect.map(
                    exportJob.documentPdf(workspaceId, exportId, doc.id),
                    (file) => file.bytes,
                  ),
                ),
              );
            const label = (doc.number ?? doc.id).replace(/[/\\]/g, "_");
            entries.push({ name: `pdfs/${label}.pdf`, bytes: yield* collectStreamBytes(pdf) });
          }

          const zipBytes = buildZip(entries);
          const blobKey = ReportsModule.exportBlobKey(workspaceId, exportId);
          yield* blobs.put(blobKey, Stream.succeed(zipBytes), {
            contentType: "application/zip",
            maxBytes: zipBytes.length,
          });

          return { sizeBytes: zipBytes.length };
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.fail({ reason: String(Cause.squash(cause)) }),
          ),
        ),
      }).pipe(Effect.result);

      if (buildOutcome._tag === "Failure") {
        yield* Activity.make({
          name: "fail",
          execute: exportJob.fail(workspaceId, exportId).pipe(Effect.asVoid, Effect.orDie),
        });
        return "failed" as const;
      }

      yield* Activity.make({
        name: "finish",
        execute: exportJob
          .finish(workspaceId, exportId, buildOutcome.success.sizeBytes)
          .pipe(Effect.asVoid, Effect.orDie),
      });
      return "ready" as const;
    }),
  );

  // 4. MemberInvitation
  const memberInvitationLayer = MemberInvitationWorkflow.toLayer(
    ({ workspaceId, invitationId, epoch }) =>
      Effect.gen(function* () {
        const sent = yield* Activity.make({
          name: "send",
          success: Schema.Struct({
            sent: Schema.Boolean,
            sleepMillis: Schema.Int,
          }),
          execute: Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const nowIso = new Date(nowMs).toISOString();
            const pending = yield* invitationJob.getPending(workspaceId, invitationId, nowIso);
            if (pending === null || pending.sendEpoch !== epoch) {
              return { sent: false, sleepMillis: 0 };
            }

            const workspacesRepo = yield* WorkspacesRepo;
            const users = yield* UserDirectory;
            const tokens = yield* InvitationTokens;
            const emailSender = yield* EmailSender;

            const ws = yield* workspacesRepo.getWorkspace(workspaceId);
            const inviterList = yield* users.lookup([pending.invitedBy]);
            const inviterName = inviterList[0]?.name ?? ws.issuingEntity.name;
            const rawToken = yield* tokens.token(invitationId, epoch);
            const inviteUrl = `${normalizedOrigin}/invite/${rawToken}`;

            const expiresMs = Date.parse(pending.expiresAt);
            const remainingMs = Math.max(0, expiresMs - nowMs);
            const validForDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
            const expiresOn = pending.expiresAt.slice(0, 10) as IsoDate;

            const rendered = renderEmail(
              {
                id: "E04",
                workspace: { name: ws.issuingEntity.name },
                inviterName,
                inviteeEmail: pending.email,
                role: pending.role,
                url: inviteUrl,
                validForDays,
                expiresOn,
              },
              ws.defaults.language,
            );

            yield* emailSender.send(
              {
                to: [pending.email],
                replyTo: ws.issuingEntity.email ?? "",
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
                attachments: [],
                tags: {
                  template: "E04",
                  workspaceId,
                  invitationId,
                  epoch: String(epoch),
                },
              },
              { idempotencyKey: `${invitationId}:${epoch}` },
            );

            return { sent: true, sleepMillis: Math.round(remainingMs) };
          }).pipe(Effect.orDie),
        });

        if (!sent.sent) {
          return "skipped" as const;
        }

        const sleepDuration = options.invitationExpiryDuration ?? Duration.millis(sent.sleepMillis);
        yield* DurableClock.sleep({ name: "expiry", duration: sleepDuration });

        yield* Activity.make({
          name: "expire",
          execute: Effect.flatMap(Clock.currentTimeMillis, (ms) =>
            invitationJob.expirePending(workspaceId, invitationId, new Date(ms).toISOString()),
          ).pipe(Effect.asVoid, Effect.orDie),
        });

        return "sent_and_checked" as const;
      }),
  );

  return Layer.mergeAll(
    documentDeliveryLayer,
    recurringIssuanceLayer,
    dataExportLayer,
    memberInvitationLayer,
  );
};

/** Live workflow handlers reading `APP_ORIGIN` from environment. */
export const WorkflowHandlersLive = Layer.unwrap(
  Effect.map(
    Config.String("APP_ORIGIN").pipe(Config.withDefault("http://localhost:8080")),
    (appOrigin) => makeWorkflowHandlersLayer({ appOrigin }),
  ),
);
