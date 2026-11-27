/**
 * System-caller job entry points for workflows and crons (core-ports 7.2, 7.3, rule R4/R5/J5;
 * closes board #894). Each entry point mints the sealed `SystemCaller` inside `@kvitbit/core`
 * via `./internal/system` so `apps/server` workflows and crons never need to forge callers.
 */
import type {
  DeliveryId,
  ExportId,
  InvitationId,
  Locale,
  ScheduleId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, DocumentId, Documents, IsoDate } from "@kvitbit/domain/contract";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { systemCaller } from "./internal/system";
import * as deliveries from "./modules/documents/deliveries/steps";
import type { DueReminder } from "./modules/documents/reminders/select";
import { enqueueReminder, selectDueReminders } from "./modules/documents/reminders/select";
import { RecurringIssuance } from "./modules/recurring/issuance";
import { CSV_CONTENT_TYPE, type CsvTable, csvStream } from "./modules/reports/csv";
import { ExportJobs, REPORTING_FILES } from "./modules/reports/exports";
import { ReportsSource } from "./modules/reports/source";
import { documentsTable, expensesTable, paymentsTable } from "./modules/reports/tables";
import { WorkspacesRepo } from "./modules/workspaces/repo";
import { CoreStore, type StoreUnavailable } from "./store/CoreStore";

const asDeliverySystem = (workspaceId: WorkspaceId, deliveryId: DeliveryId) =>
  Effect.provideService(
    CurrentCaller,
    systemCaller(workspaceId, { _tag: "DocumentDelivery", deliveryId }),
  );

// The workspace selection phase has no individual document.
const workspaceReminderDocument = DocumentId.make("00000000-0000-7000-8000-000000000000");

const asReminderSystem = (workspaceId: WorkspaceId, documentId: DocumentId) =>
  Effect.provideService(
    CurrentCaller,
    systemCaller(workspaceId, { _tag: "PaymentReminders", documentId }),
  );

const asRecurringSystem = (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
  Effect.provideService(
    CurrentCaller,
    systemCaller(workspaceId, { _tag: "RecurringIssuance", scheduleId, occurrence }),
  );

const asExportSystem = (workspaceId: WorkspaceId, exportId: ExportId) =>
  Effect.provideService(CurrentCaller, systemCaller(workspaceId, { _tag: "DataExport", exportId }));

// 1. DocumentDelivery -------------------------------------------------------------------------

export const deliveryJob = {
  /** `queued -> sending | skipped` (J3 re-check), run as `System{DocumentDelivery, deliveryId}`. */
  claim: (workspaceId: WorkspaceId, deliveryId: DeliveryId) =>
    deliveries.claim(workspaceId, deliveryId).pipe(asDeliverySystem(workspaceId, deliveryId)),

  /** `sending -> sent | failed` (or `DeliveryRetry`), run as `System{DocumentDelivery, deliveryId}`. */
  dispatch: (workspaceId: WorkspaceId, deliveryId: DeliveryId) =>
    deliveries.dispatch(workspaceId, deliveryId).pipe(asDeliverySystem(workspaceId, deliveryId)),

  /** `sending -> failed` once retries are exhausted, run as `System{DocumentDelivery, deliveryId}`. */
  giveUp: (workspaceId: WorkspaceId, deliveryId: DeliveryId, reason = "retries_exhausted") =>
    deliveries
      .giveUpWithReason(workspaceId, deliveryId, reason)
      .pipe(asDeliverySystem(workspaceId, deliveryId)),

  /** `claim`, then `dispatch` when claimed, run as `System{DocumentDelivery, deliveryId}`. */
  deliver: (workspaceId: WorkspaceId, deliveryId: DeliveryId) =>
    deliveries.deliver(workspaceId, deliveryId).pipe(asDeliverySystem(workspaceId, deliveryId)),

  /** Cross-tenant OutboxReconcile for stale `queued`/`sending` deliveries (J1a). */
  reconcileStaleDeliveries: (olderThanMillis: number) =>
    deliveries.reconcileStaleDeliveries(olderThanMillis),
} as const;

// 2. PaymentReminders -------------------------------------------------------------------------

export interface WorkspaceReminderSweepResult {
  readonly workspaceId: WorkspaceId;
  readonly deliveryIds: ReadonlyArray<DeliveryId>;
}

/**
 * Selects and enqueues every due reminder in `workspaceId` on `today`. One document's
 * non-interrupt failure is logged and does not stop the remaining reminders.
 */
const sweepWorkspace = Effect.fn("sweepWorkspace")(function* (
  workspaceId: WorkspaceId,
  today: IsoDate,
) {
  const due = yield* selectDueReminders(workspaceId, today).pipe(
    asReminderSystem(workspaceId, workspaceReminderDocument),
  );
  const deliveryIds: Array<DeliveryId> = [];
  for (const reminder of due) {
    const queued = yield* enqueueReminder(workspaceId, reminder).pipe(
      asReminderSystem(workspaceId, reminder.documentId),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              "PaymentReminders: enqueue failed",
              { workspaceId, documentId: reminder.documentId },
              cause,
            ).pipe(Effect.as(null)),
      ),
    );
    if (queued !== null) deliveryIds.push(queued);
  }
  return { workspaceId, deliveryIds } satisfies WorkspaceReminderSweepResult;
});

export const reminderJob = {
  /** Selects all reminders due in `workspaceId` on `today`, run as `System{PaymentReminders}`. */
  selectDue: (workspaceId: WorkspaceId, today: IsoDate) =>
    selectDueReminders(workspaceId, today).pipe(
      asReminderSystem(workspaceId, workspaceReminderDocument),
    ),

  /** Enqueues one due reminder, run as `System{PaymentReminders, documentId}`. */
  enqueue: (workspaceId: WorkspaceId, reminder: DueReminder) =>
    enqueueReminder(workspaceId, reminder).pipe(asReminderSystem(workspaceId, reminder.documentId)),

  sweepWorkspace,

  /**
   * Cross-tenant sweep over caller-supplied active workspace ids (the server queries active
   * workspace ids from SQL and passes them here). One workspace's non-interrupt failure is
   * logged and does not stop the others.
   */
  sweepWorkspaces: Effect.fn("sweepWorkspaces")(function* (
    workspaceIds: ReadonlyArray<WorkspaceId>,
    today: IsoDate,
  ) {
    const results: Array<WorkspaceReminderSweepResult> = [];
    for (const workspaceId of workspaceIds) {
      const res = yield* sweepWorkspace(workspaceId, today).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning(
                "PaymentReminders: workspace sweep failed",
                { workspaceId },
                cause,
              ).pipe(
                Effect.as({
                  workspaceId,
                  deliveryIds: [],
                } satisfies WorkspaceReminderSweepResult),
              ),
        ),
      );
      results.push(res);
    }
    return results;
  }),
} as const;

// 3. RecurringIssuance ------------------------------------------------------------------------

export const recurringJob = {
  /** Activity "issue" + "advance", run as `System{RecurringIssuance, scheduleId, occurrence}`. */
  issue: (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
    Effect.flatMap(RecurringIssuance, (svc) => svc.issue(scheduleId, occurrence)).pipe(
      asRecurringSystem(workspaceId, scheduleId, occurrence),
    ),

  /** Activity "enqueue-delivery", run as `System{RecurringIssuance, scheduleId, occurrence}`. */
  send: (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
    Effect.flatMap(RecurringIssuance, (svc) => svc.send(scheduleId, occurrence)).pipe(
      asRecurringSystem(workspaceId, scheduleId, occurrence),
    ),

  /** Full occurrence workflow body (issue then send if pending), safe to rerun. */
  run: (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
    Effect.flatMap(RecurringIssuance, (svc) => svc.run(scheduleId, occurrence)).pipe(
      asRecurringSystem(workspaceId, scheduleId, occurrence),
    ),

  /** Pauses a schedule that exceeded its catch-up cap (`schedule.missed_occurrences`). */
  pauseMissed: (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
    Effect.flatMap(RecurringIssuance, (svc) => svc.pauseMissed(scheduleId, occurrence)).pipe(
      asRecurringSystem(workspaceId, scheduleId, occurrence),
    ),

  /**
   * Cross-tenant OutboxReconcile for issued recurring runs whose `send` is still pending
   * past `olderThanMillis`. Reruns `run` as each occurrence's System caller (sends only).
   */
  reconcilePendingSends: Effect.fn("reconcilePendingSends")(function* (olderThanMillis: number) {
    const svc = yield* RecurringIssuance;
    const pending = yield* svc.pendingSends(olderThanMillis);
    for (const item of pending) {
      yield* svc.run(item.scheduleId, item.occurrence).pipe(
        asRecurringSystem(item.workspaceId, item.scheduleId, item.occurrence),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: recurring pending send failed", item, cause),
        ),
      );
    }
    return pending;
  }),
} as const;

// 4. DataExport -------------------------------------------------------------------------------

const allReportDates = { from: IsoDate.make("0000-01-01"), to: IsoDate.make("9999-12-31") };
const issuedReportDates = { ...allReportDates, field: "issuedOn" } as const;

export const exportJob = {
  /** Builds the reporting CSV tables as `System{DataExport, exportId}`. */
  reportingTables: (workspaceId: WorkspaceId, exportId: ExportId, locale: Locale) =>
    Effect.flatMap(ExportJobs, (svc) => svc.reportingTables(workspaceId, locale)).pipe(
      asExportSystem(workspaceId, exportId),
    ),

  /** Uses the archive's ID-ordered pages to read and encode the canonical CSVs on demand. */
  reportingFiles: <E, R>(
    workspaceId: WorkspaceId,
    exportId: ExportId,
    locale: Locale,
    pages: <Row>(
      table: keyof typeof REPORTING_FILES,
      read: Effect.Effect<ReadonlyArray<Row>, StoreUnavailable>,
    ) => Stream.Stream<ReadonlyArray<Row>, E, R>,
  ) =>
    Effect.map(ReportsSource, (source) => {
      const file = <Row>(
        table: keyof typeof REPORTING_FILES,
        read: Effect.Effect<ReadonlyArray<Row>, StoreUnavailable>,
        format: (rows: ReadonlyArray<Row>) => CsvTable,
      ) => ({
        name: REPORTING_FILES[table],
        contentType: CSV_CONTENT_TYPE,
        bytes: Stream.concat(
          csvStream(format([]), locale),
          pages(table, read.pipe(asExportSystem(workspaceId, exportId))).pipe(
            Stream.flatMap((rows) => csvStream(format(rows), locale).pipe(Stream.drop(1))),
          ),
        ),
      });
      return [
        file("documents", source.documents(workspaceId, issuedReportDates), documentsTable),
        file("payments", source.payments(workspaceId, allReportDates), paymentsTable),
        file("expenses", source.expenses(workspaceId, issuedReportDates), expensesTable),
      ];
    }),

  /** Renders an uncached document PDF as the read-only DataExport System caller. */
  documentPdf: (workspaceId: WorkspaceId, exportId: ExportId, documentId: DocumentId) =>
    Effect.flatMap(Documents, (svc) => svc.pdf(documentId)).pipe(
      asExportSystem(workspaceId, exportId),
    ),

  /** Marks an export `ready` with its ZIP size and 7-day retention window. */
  finish: (workspaceId: WorkspaceId, exportId: ExportId, sizeBytes: number) =>
    Effect.flatMap(ExportJobs, (svc) => svc.finish(workspaceId, exportId, sizeBytes)).pipe(
      asExportSystem(workspaceId, exportId),
    ),

  /** Marks an export `failed`. */
  fail: (workspaceId: WorkspaceId, exportId: ExportId) =>
    Effect.flatMap(ExportJobs, (svc) => svc.fail(workspaceId, exportId)).pipe(
      asExportSystem(workspaceId, exportId),
    ),

  /** Housekeeping: deletes expired ready exports (blob + row) and old failed exports. */
  purgeExpired: Effect.flatMap(ExportJobs, (svc) => svc.purgeExpired),
} as const;

// 5. MemberInvitation -------------------------------------------------------------------------

export const invitationJob = {
  /**
   * Reads an invitation if it is still `pending` and has not passed `nowIso`; returns `null`
   * when revoked, accepted, already expired, or missing.
   */
  getPending: (workspaceId: WorkspaceId, invitationId: InvitationId, nowIso: string) =>
    Effect.flatMap(CoreStore, (store) =>
      store.transaction(
        Effect.gen(function* () {
          const repo = yield* WorkspacesRepo;
          const row = yield* repo
            .getInvitation(workspaceId, invitationId)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
          if (row === null || row.status !== "pending" || row.expiresAt <= nowIso) {
            return null;
          }
          return row;
        }),
      ),
    ),

  /**
   * Transitions a `pending` invitation to `expired` if `expiresAt <= nowIso`. Idempotent:
   * already-terminal or non-expired invitations are returned unchanged (`false` when untouched).
   */
  expirePending: (workspaceId: WorkspaceId, invitationId: InvitationId, nowIso: string) =>
    Effect.flatMap(CoreStore, (store) =>
      store.transaction(
        Effect.gen(function* () {
          const repo = yield* WorkspacesRepo;
          const row = yield* repo
            .lockInvitation(workspaceId, invitationId)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
          if (row === null || row.status !== "pending" || row.expiresAt > nowIso) {
            return false;
          }
          yield* repo
            .updateInvitation({ ...row, status: "expired" }, row.revision)
            .pipe(Effect.catchTag(["Conflict", "UniqueViolation"], (e) => Effect.die(e)));
          return true;
        }),
      ),
    ),
} as const;
