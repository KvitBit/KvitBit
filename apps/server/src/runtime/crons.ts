/**
 * Kvitbit's 5 ClusterCrons wired to `@kvitbit/core` sealed `CoreJobs` and `@kvitbit/adapters/jobs`:
 * - `recurringSweep`: `RecurringIssuance.sweep` starting `RecurringIssuanceWorkflow`
 * - `reminderSweep`: queries active workspaces from SQL -> `reminderJob.sweepWorkspaces`
 * - `cnbFixing`: daily CNB fixing prefetch via `FxFixings.fixing(today)`
 * - `outboxReconcile`: `deliveryJob.reconcileStaleDeliveries` + `recurringJob.reconcilePendingSends`
 *   + stale `running` exports + stale `pending` invitations
 * - `housekeeping`: `exportJob.purgeExpired` + expired `request_log` (>24h) + expired `altcha_replays`
 */
import { type CronLayerOptions, cronsLayer } from "@kvitbit/adapters/jobs";
import {
  deliveryJob,
  exportJob,
  FxFixings,
  RecurringModule,
  recurringJob,
  reminderJob,
} from "@kvitbit/core";
import { pragueDate } from "@kvitbit/core/engines";
import type { ExportId, InvitationId, WorkspaceId } from "@kvitbit/domain/contract";
import { Cause, Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  DataExportWorkflow,
  MemberInvitationWorkflow,
  RecurringIssuanceWorkflow,
} from "./workflows";

/** Default staleness threshold for OutboxReconcile (2 minutes, rule J1a). */
export const DEFAULT_RECONCILE_STALE_MS = 2 * 60 * 1000;

/** Default retention window for `request_log` rows (24 hours, rule J3a). */
export const DEFAULT_REQUEST_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CronHandlerOptions {
  readonly staleThresholdMs?: number | undefined;
  readonly requestLogRetentionMs?: number | undefined;
}

/** Builds the 5 cron handler effects (exported individually for direct unit/integration tests). */
export const makeCronHandlers = (options: CronHandlerOptions = {}) => {
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_RECONCILE_STALE_MS;
  const requestLogRetentionMs = options.requestLogRetentionMs ?? DEFAULT_REQUEST_LOG_RETENTION_MS;

  const recurringSweep = Effect.gen(function* () {
    const svc = yield* RecurringModule.RecurringIssuance;
    const engine = yield* WorkflowEngine.WorkflowEngine;
    yield* svc.sweep((decision) =>
      RecurringIssuanceWorkflow.execute(
        {
          workspaceId: decision.workspaceId,
          scheduleId: decision.scheduleId,
          occurrence: decision.occurrence,
        },
        { discard: true, detached: true },
      ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine), Effect.asVoid),
    );
  });

  const reminderSweep = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const today = pragueDate(nowMs);
    const rows = yield* sql<{ readonly id: WorkspaceId }>`
      SELECT id FROM workspaces WHERE closed_at IS NULL
    `;
    const workspaceIds = rows.map((r) => r.id);
    if (workspaceIds.length === 0) return;
    yield* reminderJob.sweepWorkspaces(workspaceIds, today);
  });

  const cnbFixing = Effect.gen(function* () {
    const fx = yield* FxFixings;
    const nowMs = yield* Clock.currentTimeMillis;
    const today = pragueDate(nowMs);
    yield* fx
      .fixing(today)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("CnbFixingWarmup: failed to prefetch fixing", { today }, cause),
        ),
      );
  });

  const outboxReconcile = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - staleThresholdMs).toISOString();

    // 1. Stale queued/sending deliveries
    yield* deliveryJob
      .reconcileStaleDeliveries(staleThresholdMs)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: stale deliveries sweep failed", cause),
        ),
      );

    // 2. Pending recurring auto-sends
    yield* recurringJob
      .reconcilePendingSends(staleThresholdMs)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: recurring pending sends failed", cause),
        ),
      );

    // 3. Stale running exports
    const staleExports = yield* sql<{
      readonly id: ExportId;
      readonly workspace_id: WorkspaceId;
    }>`
      SELECT id, workspace_id
      FROM exports
      WHERE status = 'running' AND created_at < ${cutoffIso}::timestamptz
    `;
    for (const row of staleExports) {
      yield* DataExportWorkflow.execute(
        { workspaceId: row.workspace_id, exportId: row.id },
        { discard: true, detached: true },
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: stale export start failed", row, cause),
        ),
      );
    }

    // 4. Stale pending invitations
    const staleInvitations = yield* sql<{
      readonly id: InvitationId;
      readonly workspace_id: WorkspaceId;
      readonly send_epoch: number;
    }>`
      SELECT id, workspace_id, send_epoch
      FROM invitations
      WHERE status = 'pending'
        AND expires_at > ${nowIso}::timestamptz
        AND updated_at < ${cutoffIso}::timestamptz
    `;
    for (const inv of staleInvitations) {
      yield* MemberInvitationWorkflow.execute(
        { workspaceId: inv.workspace_id, invitationId: inv.id, epoch: inv.send_epoch },
        { discard: true, detached: true },
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: stale invitation start failed", inv, cause),
        ),
      );
    }
  });

  const housekeeping = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = new Date(nowMs).toISOString();
    const requestLogCutoff = new Date(nowMs - requestLogRetentionMs).toISOString();

    // 1. Expired ready & old failed exports (ZIP blobs + rows)
    yield* exportJob.purgeExpired.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Housekeeping: export purge failed", cause),
      ),
    );

    // 2. Expired idempotency request_log rows (> 24h)
    yield* sql`
      DELETE FROM request_log WHERE created_at < ${requestLogCutoff}::timestamptz
    `;

    // 3. Expired ALTCHA replay rows
    yield* sql`
      DELETE FROM altcha_replays WHERE expires_at < ${nowIso}::timestamptz
    `;
  });

  return {
    recurringSweep,
    reminderSweep,
    cnbFixing,
    outboxReconcile,
    housekeeping,
  } as const;
};

/** Registers all 5 Kvitbit ClusterCrons on the active `Sharding` layer. */
export const makeCronsLayer = (options?: CronHandlerOptions & CronLayerOptions) =>
  cronsLayer(makeCronHandlers(options), options);

/** Live ClusterCrons layer with production defaults. */
export const CronsLive = makeCronsLayer();
