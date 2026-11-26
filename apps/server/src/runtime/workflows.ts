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
  type Documents,
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
import { MAX_ZIP_BYTES, streamZip, type ZipEntry } from "./zip";

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
}).annotate(Workflow.SuspendOnFailure, true);

const InvitationOutcome = Schema.Literals(["sent_and_checked", "skipped"]);

export const MemberInvitationWorkflow = Workflow.make("kvitbit/MemberInvitation", {
  payload: {
    workspaceId: WorkspaceId,
    invitationId: InvitationId,
    epoch: Schema.Int,
    recovery: Schema.optional(Schema.Boolean),
  },
  idempotencyKey: ({ invitationId, epoch, recovery }) =>
    recovery === true ? `${invitationId}:${epoch}:reconcile` : `${invitationId}:${epoch}`,
  success: InvitationOutcome,
}).annotate(Workflow.SuspendOnFailure, true);

// 2. Options & retry policies -----------------------------------------------------------------

export interface WorkflowHandlerOptions {
  /** Public origin for invitation links, e.g. `https://kvitbit.cz`. */
  readonly appOrigin?: string | undefined;
  /** Retry policy for `DocumentDelivery` dispatch on `DeliveryRetry`. */
  readonly deliveryRetrySchedule?: Schedule.Schedule<unknown, unknown> | undefined;
  /** Override sleep duration for `MemberInvitation` expiry (tests). */
  readonly invitationExpiryDuration?: Duration.Input | undefined;
}

const DELIVERY_RETRY_WINDOW_MS = Duration.toMillis(Duration.hours(24));

/**
 * Default delivery retry policy (core-ports 7.2): exponential from 30 s, capped at 1 h,
 * up to 24 h total elapsed time.
 */
export const DEFAULT_DELIVERY_RETRY_SCHEDULE = Schedule.exponential(Duration.seconds(30)).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.hours(1)))),
  Schedule.while(
    ({ elapsed, duration }) => elapsed + Duration.toMillis(duration) <= DELIVERY_RETRY_WINDOW_MS,
  ),
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

const csvEncoder = new TextEncoder();
const csvLine = (fields: ReadonlyArray<string | null | undefined>) =>
  csvEncoder.encode(`${fields.map(csvEscape).join(",")}\r\n`);

// Workspace-owned data only. Auth secrets, request replays, and global cache rows are operational data.
const EXPORT_TABLES = [
  "workspaces",
  "workspace_slug_aliases",
  "issuing_entities",
  "tax_regime_periods",
  "memberships",
  "invitations",
  "bank_accounts",
  "numbering_series",
  "numbering_counters",
  "number_reservations",
  "contacts",
  "contact_preferred_series",
  "price_list_items",
  "documents",
  "document_lines",
  "document_relations",
  "payments",
  "deliveries",
  "share_links",
  "share_view_events",
  "share_view_rollups",
  "expenses",
  "attachments",
  "templates",
  "template_lines",
  "schedules",
  "schedule_runs",
  "audit_entries",
  "exports",
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
    cause: Schema.Literals(["not_accepted", "outcome_unknown", "retry_window_closed"]),
  });

  // 1. DocumentDelivery
  const documentDeliveryLayer = DocumentDeliveryWorkflow.toLayer(({ workspaceId, deliveryId }) =>
    Effect.gen(function* () {
      const claimed = yield* Activity.make({
        name: "claim",
        success: Schema.Struct({
          status: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
          deadline: Schema.Number,
        }),
        execute: Effect.gen(function* () {
          const status = yield* deliveryJob.claim(workspaceId, deliveryId).pipe(Effect.orDie);
          return { status, deadline: (yield* Clock.currentTimeMillis) + DELIVERY_RETRY_WINDOW_MS };
        }),
      });

      if (isTerminalDelivery(claimed.status)) return claimed.status;

      const nextRetry = yield* Schedule.toStep(retrySchedule);
      let scheduledElapsed = 0;
      let retryNumber = 0;
      const dispatchResult = yield* Activity.make({
        name: "dispatch",
        success: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
        error: DeliveryRetryError,
        execute: Effect.gen(function* () {
          const attempt = yield* Activity.CurrentAttempt;
          const now = yield* Clock.currentTimeMillis;
          if (attempt > 1 && now >= claimed.deadline) {
            return yield* Effect.fail({
              _tag: "DeliveryRetry" as const,
              deliveryId,
              cause: "retry_window_closed" as const,
            });
          }
          return yield* deliveryJob
            .dispatch(workspaceId, deliveryId)
            .pipe(Effect.catchIf((err) => err._tag !== "DeliveryRetry", Effect.die));
        }),
      }).pipe(
        Activity.retry({
          while: (failure) =>
            Effect.gen(function* () {
              if (failure.cause === "retry_window_closed") return false;
              // Rebuild identical timer names and delays when the workflow resumes.
              const retry = yield* nextRetry(scheduledElapsed, failure).pipe(
                Effect.catchIf(Cause.isDone, () => Effect.succeed(null)),
              );
              if (retry === null) return false;
              const [, duration] = retry;
              scheduledElapsed += Duration.toMillis(duration);
              retryNumber += 1;
              yield* DurableClock.sleep({
                name: `dispatch-retry-${retryNumber}`,
                duration,
                inMemoryThreshold: Duration.zero,
              });
              return true;
            }),
        }),
        Effect.result,
      );

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
          const entries: Array<ZipEntry<unknown, Documents>> = [];

          // Determine workspace locale (fallback "cs")
          const wsRows = yield* sql<{ readonly default_language: string }>`
            SELECT default_language FROM workspaces WHERE id = ${workspaceId}
          `;
          const locale: Locale = wsRows[0]?.default_language === "en" ? "en" : "cs";

          // Canonical reporting CSVs from CoreJobs
          const reportingFiles = yield* exportJob.reportingTables(workspaceId, exportId, locale);
          for (const file of reportingFiles) {
            entries.push({ name: file.name, bytes: file.bytes });
          }

          // Full workspace tables as CSVs
          const tableColumns = yield* sql<{
            readonly table_name: string;
            readonly headers: ReadonlyArray<string>;
          }>`
            SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS headers
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ANY(${[...EXPORT_TABLES]}::text[])
            GROUP BY table_name
          `;
          const headersByTable = new Map(
            tableColumns.map(({ table_name, headers }) => [table_name, headers]),
          );
          for (const table of EXPORT_TABLES) {
            const workspaceColumn = table === "workspaces" ? "id" : "workspace_id";
            const headers = headersByTable.get(table);
            if (headers === undefined) {
              return yield* Effect.die(new Error(`Missing export table permissions: ${table}`));
            }
            // Text at the PostgreSQL boundary keeps decimals exact and avoids unregistered enum array types.
            const rows = sql.unsafe<{ readonly data: CsvRow }>(
              `SELECT (SELECT jsonb_object_agg(key, value) FROM jsonb_each_text(to_jsonb(source_row))) AS data
               FROM ${table} AS source_row
               WHERE ${workspaceColumn} = $1
               ORDER BY data`,
              [workspaceId],
            ).stream;
            entries.push({
              name: `tables/${table}.csv`,
              bytes: Stream.concat(
                Stream.succeed(csvLine(headers)),
                rows.pipe(Stream.map(({ data }) => csvLine(headers.map((name) => data[name])))),
              ),
            });
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
            const safeName = (att.file_name || "attachment").replace(/[/\\]/g, "_");
            entries.push({
              name: `attachments/${att.id}-${safeName}`,
              bytes: Stream.unwrap(blobs.get(att.blob_key as BlobKey)),
            });
          }

          const docRows = yield* sql<{
            readonly id: DocumentId;
            readonly number: string | null;
          }>`
            SELECT id, number
            FROM documents
            WHERE workspace_id = ${workspaceId}
            ORDER BY id
          `;
          for (const doc of docRows) {
            const number = doc.number?.replace(/[^\p{L}\p{N}._-]+/gu, "-") ?? "draft";
            const pdf = exportJob.documentPdf(workspaceId, exportId, doc.id);
            entries.push({
              name: `pdfs/${number}-${doc.id}.pdf`,
              bytes: Stream.unwrap(Effect.map(pdf, (file) => file.bytes)),
            });
          }

          const services = yield* Effect.context<Documents>();
          const archive = streamZip(entries).pipe(Stream.provideContext(services), Stream.orDie);
          const blobKey = ReportsModule.exportBlobKey(workspaceId, exportId);
          const stored = yield* blobs.put(blobKey, archive, {
            contentType: "application/zip",
            maxBytes: MAX_ZIP_BYTES,
          });

          return { sizeBytes: stored.bytes };
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
            if (pending === null) {
              // An invitation can expire while a send is waiting for recovery.
              yield* invitationJob.expirePending(workspaceId, invitationId, nowIso);
              return { sent: false, sleepMillis: 0 };
            }
            if (pending.sendEpoch !== epoch) {
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
