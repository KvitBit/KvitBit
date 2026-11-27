/**
 * `DeliveryJobs`: starts the delivery job for a queued delivery after the queueing transaction
 * commits (rule J1). Integration binds it to `Workflow.execute(DocumentDelivery, ...)` with the
 * delivery id as key; reconcile (J1a, `reconcileStaleDeliveries`) re-starts queued/sending rows
 * through the same `start`. `DeliveryJobsMemory`
 * records the started ids so tests run the job steps themselves.
 */
import type { DeliveryId, WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface StartedDelivery {
  readonly workspaceId: WorkspaceId;
  readonly deliveryId: DeliveryId;
}

export class DeliveryJobs extends Context.Service<
  DeliveryJobs,
  {
    /**
     * Ensures a DocumentDelivery job is running for the delivery. A start while an execution is
     * live (running or waiting to retry) attaches to it. `reconcileStaleDeliveries` calls this
     * only for rows still `queued` or `sending`, so when the binding finds an execution that
     * already finished (its exit persisted, the row still non-terminal: the job failed after
     * `claim` or after the provider call), it must run `deliver` again, for example as a new
     * execution, and not just return the stored exit (J1a: intent rows are the record). The
     * provider key stays the delivery id whatever the execution key (`dispatch`, J2).
     */
    readonly start: (workspaceId: WorkspaceId, deliveryId: DeliveryId) => Effect.Effect<void>;
  }
>()("@kvitbit/core/modules/documents/deliveries/jobs/DeliveryJobs") {}

export class StartedDeliveries extends Context.Service<
  StartedDeliveries,
  Ref.Ref<ReadonlyArray<StartedDelivery>>
>()("@kvitbit/core/modules/documents/deliveries/jobs/StartedDeliveries") {}

export const DeliveryJobsMemory: Layer.Layer<DeliveryJobs | StartedDeliveries> = Layer.effect(
  DeliveryJobs,
  Effect.map(StartedDeliveries, (started) =>
    DeliveryJobs.of({
      start: Effect.fn("DeliveryJobs.start")((workspaceId, deliveryId) =>
        Ref.update(started, (all) => [...all, { workspaceId, deliveryId }]),
      ),
    }),
  ),
).pipe(
  Layer.provideMerge(Layer.effect(StartedDeliveries, Ref.make<ReadonlyArray<StartedDelivery>>([]))),
);
