/**
 * `DeliveryJobs`: starts the delivery job for a queued delivery after the queueing transaction
 * commits (rule J1). Integration binds it to `Workflow.execute(DocumentDelivery, ...)` with the
 * delivery id as key; reconcile (J1a) re-starts queued/sending rows. `DeliveryJobsMemory`
 * records the started ids so tests run the job steps themselves.
 */
import type { DeliveryId, WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref } from "effect";

export interface StartedDelivery {
  readonly workspaceId: WorkspaceId;
  readonly deliveryId: DeliveryId;
}

export class DeliveryJobs extends Context.Service<
  DeliveryJobs,
  { readonly start: (workspaceId: WorkspaceId, deliveryId: DeliveryId) => Effect.Effect<void> }
>()("kvitbit/core/documents/DeliveryJobs") {}

export class StartedDeliveries extends Context.Service<
  StartedDeliveries,
  Ref.Ref<ReadonlyArray<StartedDelivery>>
>()("kvitbit/core/testing/StartedDeliveries") {}

export const DeliveryJobsMemory: Layer.Layer<DeliveryJobs | StartedDeliveries> = Layer.effect(
  DeliveryJobs,
  Effect.map(StartedDeliveries, (started) =>
    DeliveryJobs.of({
      start: (workspaceId, deliveryId) =>
        Ref.update(started, (all) => [...all, { workspaceId, deliveryId }]),
    }),
  ),
).pipe(
  Layer.provideMerge(Layer.effect(StartedDeliveries, Ref.make<ReadonlyArray<StartedDelivery>>([]))),
);
