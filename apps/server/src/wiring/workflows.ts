/**
 * Workflow starter ports (`DeliveryJobs`, `InvitationDelivery`, `ExportWorkflow`) backed by
 * Effect Cluster's `WorkflowEngine` (core-ports 7.1-7.2).
 */
import { DeliveryJobs, ExportWorkflow, InvitationDelivery } from "@kvitbit/core";
import { Clock, Effect, Layer, Option } from "effect";
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
 * fresh reconcile execution so `deliver` actually runs again (still using `deliveryId` as the
 * email provider idempotency key per J2).
 */
export const DeliveryJobsLive: Layer.Layer<DeliveryJobs, never, WorkflowEngine.WorkflowEngine> =
  Layer.effect(
    DeliveryJobs,
    Effect.map(Effect.context<WorkflowEngine.WorkflowEngine>(), (ctx) =>
      DeliveryJobs.of({
        start: (workspaceId, deliveryId) =>
          Effect.gen(function* () {
            const basePayload = { workspaceId, deliveryId, attempt: 0 };
            const execId = yield* DocumentDeliveryWorkflow.executionId(basePayload);
            const status = yield* DocumentDeliveryWorkflow.poll(execId);

            if (Option.isSome(status) && status.value._tag === "Complete") {
              const attempt = Math.max(1, yield* Clock.currentTimeMillis);
              yield* DocumentDeliveryWorkflow.execute(
                { workspaceId, deliveryId, attempt },
                { discard: true, detached: true },
              );
              return;
            }

            yield* DocumentDeliveryWorkflow.execute(basePayload, {
              discard: true,
              detached: true,
            });
          }).pipe(Effect.provide(ctx), Effect.asVoid),
      }),
    ),
  );

/** `InvitationDelivery` bound to `MemberInvitationWorkflow` (`${invitationId}:${epoch}`). */
export const InvitationDeliveryLive: Layer.Layer<
  InvitationDelivery,
  never,
  WorkflowEngine.WorkflowEngine
> = Layer.effect(
  InvitationDelivery,
  Effect.map(Effect.context<WorkflowEngine.WorkflowEngine>(), (ctx) =>
    InvitationDelivery.of({
      start: (send) =>
        MemberInvitationWorkflow.execute(
          {
            workspaceId: send.workspaceId,
            invitationId: send.invitationId,
            epoch: send.epoch,
          },
          { discard: true, detached: true },
        ).pipe(Effect.provide(ctx), Effect.asVoid),
    }),
  ),
);

/** `ExportWorkflow` bound to `DataExportWorkflow` (`exportId`). */
export const ExportWorkflowLive: Layer.Layer<ExportWorkflow, never, WorkflowEngine.WorkflowEngine> =
  Layer.effect(
    ExportWorkflow,
    Effect.map(Effect.context<WorkflowEngine.WorkflowEngine>(), (ctx) =>
      ExportWorkflow.of({
        start: (job) =>
          DataExportWorkflow.execute(
            { workspaceId: job.workspaceId, exportId: job.exportId },
            { discard: true, detached: true },
          ).pipe(Effect.provide(ctx), Effect.asVoid),
      }),
    ),
  );

/** All three workflow starter ports merged. */
export const WorkflowStartersLive: Layer.Layer<
  DeliveryJobs | InvitationDelivery | ExportWorkflow,
  never,
  WorkflowEngine.WorkflowEngine
> = Layer.mergeAll(DeliveryJobsLive, InvitationDeliveryLive, ExportWorkflowLive);
