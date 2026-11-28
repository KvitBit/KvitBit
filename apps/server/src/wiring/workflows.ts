/**
 * Workflow starter ports (`DeliveryJobs`, `InvitationDelivery`, `ExportWorkflow`) backed by
 * Effect Cluster's `WorkflowEngine` (core-ports 7.1-7.2).
 */
import { DeliveryJobs, ExportWorkflow, InvitationDelivery } from "@kvitbit/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  DataExportWorkflow,
  DocumentDeliveryWorkflow,
  MemberInvitationWorkflow,
} from "../runtime/workflows";

/**
 * `DeliveryJobs` bound to `DocumentDeliveryWorkflow`.
 *
 * Implements rule J1a: if execution 0 (keyed by `deliveryId`) already completed while the
 * intent row is still `queued` or `sending` (e.g. crash after claim/provider call), starts a
 * fresh reconcile execution. The intent row identifies the active attempt even when older
 * workflow history is pruned. Every run uses `deliveryId` as the provider idempotency key.
 */
export const DeliveryJobsLive: Layer.Layer<
  DeliveryJobs,
  never,
  WorkflowEngine.WorkflowEngine | SqlClient.SqlClient
> = Layer.effect(
  DeliveryJobs,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ctx = yield* Effect.context<WorkflowEngine.WorkflowEngine>();
    return DeliveryJobs.of({
      start: Effect.fn("DeliveryJobs.start")(
        function* (workspaceId, deliveryId) {
          const currentAttempt = sql<{ readonly workflow_attempt: number }>`
              SELECT workflow_attempt FROM deliveries
              WHERE workspace_id = ${workspaceId} AND id = ${deliveryId}
                AND status IN ('queued', 'sending')
            `;
          let [row] = yield* currentAttempt;
          while (row !== undefined) {
            const payload = { workspaceId, deliveryId, attempt: row.workflow_attempt };
            const execId = yield* DocumentDeliveryWorkflow.executionId(payload);
            const status = yield* DocumentDeliveryWorkflow.poll(execId);

            if (Option.isNone(status)) {
              yield* DocumentDeliveryWorkflow.execute(payload, { discard: true, detached: true });
              return;
            }
            if (status.value._tag === "Suspended") {
              if (status.value.failed === true) yield* DocumentDeliveryWorkflow.resume(execId);
              return;
            }

            // Claim the next execution before submitting it. Another sweep steps in after a
            // crash here, or reads the winner's attempt after a concurrent update.
            yield* sql`
              UPDATE deliveries SET workflow_attempt = workflow_attempt + 1
              WHERE workspace_id = ${workspaceId} AND id = ${deliveryId}
                AND status IN ('queued', 'sending') AND workflow_attempt = ${row.workflow_attempt}
            `;
            [row] = yield* currentAttempt;
          }
        },
        Effect.provide(ctx),
        Effect.orDie,
      ),
    });
  }),
);

/** `InvitationDelivery` bound to `MemberInvitationWorkflow` (`${invitationId}:${epoch}`). */
const InvitationDeliveryLive: Layer.Layer<
  InvitationDelivery,
  never,
  WorkflowEngine.WorkflowEngine
> = Layer.effect(
  InvitationDelivery,
  Effect.map(Effect.context<WorkflowEngine.WorkflowEngine>(), (ctx) =>
    InvitationDelivery.of({
      start: Effect.fn("InvitationDelivery.start")((send) =>
        MemberInvitationWorkflow.execute(
          {
            workspaceId: send.workspaceId,
            invitationId: send.invitationId,
            epoch: send.epoch,
          },
          { discard: true, detached: true },
        ).pipe(Effect.provide(ctx), Effect.asVoid),
      ),
    }),
  ),
);

/** `ExportWorkflow` bound to `DataExportWorkflow` (`exportId`). */
const ExportWorkflowLive: Layer.Layer<ExportWorkflow, never, WorkflowEngine.WorkflowEngine> =
  Layer.effect(
    ExportWorkflow,
    Effect.map(Effect.context<WorkflowEngine.WorkflowEngine>(), (ctx) =>
      ExportWorkflow.of({
        start: Effect.fn("ExportWorkflow.start")((job) =>
          DataExportWorkflow.execute(
            { workspaceId: job.workspaceId, exportId: job.exportId },
            { discard: true, detached: true },
          ).pipe(Effect.provide(ctx), Effect.asVoid),
        ),
      }),
    ),
  );

/** All three workflow starter ports merged. */
export const WorkflowStartersLive: Layer.Layer<
  DeliveryJobs | InvitationDelivery | ExportWorkflow,
  never,
  WorkflowEngine.WorkflowEngine | SqlClient.SqlClient
> = Layer.mergeAll(DeliveryJobsLive, InvitationDeliveryLive, ExportWorkflowLive);
