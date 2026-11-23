/**
 * `DeliveryStatusLookup`: the narrow read port `Templates.runs` joins delivery status through
 * (core-ports 4.8: "delivery status is joined from `deliveries`"). The Documents module owns
 * deliveries; integration provides this from its repository. No authorize, no audit; runs inside
 * the caller's transaction. Board seam #399.
 */
import type { DeliveryId, WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";

export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "skipped";

export class DeliveryStatusLookup extends Context.Service<
  DeliveryStatusLookup,
  {
    /** Status of each delivery of the Workspace; unknown and other-Workspace ids are absent. */
    readonly statuses: (
      workspaceId: WorkspaceId,
      ids: ReadonlyArray<DeliveryId>,
    ) => Effect.Effect<ReadonlyMap<DeliveryId, DeliveryStatus>, StoreUnavailable>;
  }
>()("kvitbit/core/DeliveryStatusLookup") {}

/** In-memory fake: `set` records a delivery's status; the lookup reads them back. Tests only. */
export class FakeDeliveryStatuses extends Context.Service<
  FakeDeliveryStatuses,
  {
    readonly set: (
      workspaceId: WorkspaceId,
      id: DeliveryId,
      status: DeliveryStatus,
    ) => Effect.Effect<void>;
  }
>()("kvitbit/core/testing/FakeDeliveryStatuses") {
  static readonly layer: Layer.Layer<DeliveryStatusLookup | FakeDeliveryStatuses> =
    Layer.effectContext(
      Effect.map(Ref.make(new Map<string, DeliveryStatus>()), (ref) => {
        const key = (ws: WorkspaceId, id: DeliveryId) => `${ws}/${id}`;
        return Context.make(
          FakeDeliveryStatuses,
          FakeDeliveryStatuses.of({
            set: (ws, id, status) => Ref.update(ref, (m) => new Map(m).set(key(ws, id), status)),
          }),
        ).pipe(
          Context.add(
            DeliveryStatusLookup,
            DeliveryStatusLookup.of({
              statuses: (ws, ids) =>
                Effect.map(Ref.get(ref), (m) => {
                  const out = new Map<DeliveryId, DeliveryStatus>();
                  for (const id of ids) {
                    const status = m.get(key(ws, id));
                    if (status !== undefined) out.set(id, status);
                  }
                  return out;
                }),
            }),
          ),
        );
      }),
    );
}
