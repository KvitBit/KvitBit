/**
 * Kvitbit's 5 ClusterCrons wired to `@kvitbit/core` sealed `CoreJobs` and `@kvitbit/adapters/jobs`:
 * - `recurringSweep`: `RecurringIssuance.sweep` starting `RecurringIssuanceWorkflow`
 * - `reminderSweep`: queries active workspaces from SQL -> `reminderJob.sweepWorkspaces`
 * - `cnbFixing`: daily CNB fixing prefetch via `FxFixings.fixing(today)`
 * - `outboxReconcile`: `deliveryJob.reconcileStaleDeliveries` + `recurringJob.reconcilePendingSends`
 *   + stale `running` exports + stale `pending` invitations
 * - `housekeeping`: expired rows and orphaned attachments, plus daily share-view rollups
 */

import { cronsLayer } from "@kvitbit/adapters/jobs";
import {
  deliveryJob,
  exportJob,
  FxFixings,
  invitationJob,
  RecurringModule,
  ReportsModule,
  recurringJob,
  reminderJob,
} from "@kvitbit/core";
import { pragueDate } from "@kvitbit/core/engines";
import type { ExportId, InvitationId, WorkspaceId } from "@kvitbit/domain/contract";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { AttachmentInventory, AttachmentInventoryLive } from "../wiring/attachmentInventory";
import {
  DataExportWorkflow,
  MemberInvitationWorkflow,
  RecurringIssuanceWorkflow,
} from "./workflows";

/** Default staleness threshold for OutboxReconcile (2 minutes, rule J1a). */
const DEFAULT_RECONCILE_STALE_MS = 2 * 60 * 1000;

/** Default retention window for `request_log` rows (24 hours, rule J3a). */
export const DEFAULT_REQUEST_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_STAGING_GRACE_MS = 24 * 60 * 60 * 1000;

interface CronHandlerOptions {
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
    yield* svc.sweep((_caller, decision) =>
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
    const workspaceIds = Arr.map(rows, (r) => r.id);
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
    const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs - staleThresholdMs));

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
      const payload = { workspaceId: row.workspace_id, exportId: row.id };
      yield* Effect.gen(function* () {
        const executionId = yield* DataExportWorkflow.executionId(payload);
        const result = yield* DataExportWorkflow.poll(executionId);
        if (Option.isNone(result)) {
          yield* DataExportWorkflow.execute(payload, { discard: true, detached: true });
          return;
        }
        if (result.value._tag === "Suspended") {
          if (result.value.failed === true) yield* DataExportWorkflow.resume(executionId);
          return;
        }
        if (Exit.isSuccess(result.value.exit) && result.value.exit.value === "ready") {
          const blobs = yield* BlobStorage;
          const bytes = yield* blobs
            .get(ReportsModule.exportBlobKey(payload.workspaceId, payload.exportId))
            .pipe(
              Effect.flatMap(
                Stream.runFold(
                  () => 0,
                  (size, chunk) => size + chunk.byteLength,
                ),
              ),
              Effect.catchTag("BlobMissing", () => Effect.succeed(null)),
            );
          if (bytes !== null) {
            yield* exportJob.finish(payload.workspaceId, payload.exportId, bytes);
            return;
          }
        }
        yield* exportJob.fail(payload.workspaceId, payload.exportId);
      }).pipe(
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
      readonly expired: boolean;
    }>`
      SELECT id, workspace_id, send_epoch, expires_at <= ${DateTime.toDateUtc(DateTime.makeUnsafe(nowMs))} AS expired
      FROM invitations
      WHERE status = 'pending'
        AND updated_at < ${cutoffIso}::timestamptz
    `;
    for (const inv of staleInvitations) {
      const payload = {
        workspaceId: inv.workspace_id,
        invitationId: inv.id,
        epoch: inv.send_epoch,
      };
      yield* Effect.gen(function* () {
        const executionId = yield* MemberInvitationWorkflow.executionId(payload);
        const result = yield* MemberInvitationWorkflow.poll(executionId);
        if (Option.isNone(result)) {
          yield* MemberInvitationWorkflow.execute(payload, { discard: true, detached: true });
          return;
        }
        if (result.value._tag === "Suspended") {
          if (result.value.failed === true) yield* MemberInvitationWorkflow.resume(executionId);
          return;
        }
        if (inv.expired) {
          yield* invitationJob.expirePending(
            payload.workspaceId,
            payload.invitationId,
            DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          );
        } else if (Exit.isFailure(result.value.exit)) {
          // A prior completed failure cannot be resumed. The epoch keeps the provider key stable.
          const recovery = { ...payload, recovery: true };
          const recoveryId = yield* MemberInvitationWorkflow.executionId(recovery);
          const recoveryResult = yield* MemberInvitationWorkflow.poll(recoveryId);
          if (Option.isNone(recoveryResult)) {
            yield* MemberInvitationWorkflow.execute(recovery, { discard: true, detached: true });
          } else if (
            recoveryResult.value._tag === "Suspended" &&
            recoveryResult.value.failed === true
          ) {
            yield* MemberInvitationWorkflow.resume(recoveryId);
          }
        }
      }).pipe(
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
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const requestLogCutoff = DateTime.formatIso(DateTime.makeUnsafe(nowMs - requestLogRetentionMs));

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

    // Keep consumed confirmations available while their core request result can still be replayed.
    yield* sql`
      DELETE FROM mcp_confirmations
      WHERE expires_at <= ${nowIso}::timestamptz
        AND (consumed_at IS NULL OR consumed_at <= ${requestLogCutoff}::timestamptz)
    `;

    yield* sql`
      INSERT INTO share_view_rollups AS existing (workspace_id, share_link_id, day, views, downloads)
      SELECT workspace_id, share_link_id, (at AT TIME ZONE 'UTC')::date,
        count(*) FILTER (WHERE kind = 'view'), count(*) FILTER (WHERE kind = 'download')
      FROM share_view_events
      WHERE at < ${`${Str.slice(0, 10)(nowIso)}T00:00:00.000Z`}::timestamptz
      GROUP BY 1, 2, 3
      ON CONFLICT (workspace_id, share_link_id, day) DO UPDATE
      SET views = EXCLUDED.views, downloads = EXCLUDED.downloads
      WHERE (existing.views, existing.downloads) IS DISTINCT FROM (EXCLUDED.views, EXCLUDED.downloads)
    `;

    const inventory = yield* AttachmentInventory;
    const blobs = yield* BlobStorage;
    yield* inventory.olderThan(nowMs - ATTACHMENT_STAGING_GRACE_MS).pipe(
      Stream.runForEach(
        Effect.fn("removeOrphanedAttachment")(function* (key) {
          const attached = yield* sql`SELECT id FROM attachments WHERE blob_key = ${key} LIMIT 1`;
          if (attached.length === 0) {
            yield* blobs
              .delete(key)
              .pipe(
                Effect.catchTag("BlobUnavailable", (error) =>
                  Effect.logWarning("Housekeeping: orphaned attachment deletion failed", error),
                ),
              );
          }
        }),
      ),
    );
  });

  return {
    recurringSweep,
    reminderSweep,
    cnbFixing,
    outboxReconcile,
    housekeeping,
  } as const;
};

/** Live ClusterCrons layer with production defaults. */
export const CronsLive = cronsLayer(makeCronHandlers()).pipe(
  Layer.provide(AttachmentInventoryLive),
);
