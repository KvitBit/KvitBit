/**
 * `ContactSeriesLookup`: the narrow port Contacts uses to check a Contact's
 * `preferredSeriesByKind` (core-ports 4.2): each referenced Numbering Series must exist in the
 * caller's Workspace and number that document kind. The numbering module owns series; the
 * parent provides this port from it at integration. In-memory fake below for tests.
 */
import type { DocumentKind, NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";

export class ContactSeriesLookup extends Context.Service<
  ContactSeriesLookup,
  {
    /**
     * The kind of each given series that exists in `workspaceId`; ids of another Workspace or
     * unknown ids are absent from the result (rule R2). Runs inside the caller's transaction.
     */
    readonly kindsOf: (
      workspaceId: WorkspaceId,
      ids: ReadonlyArray<NumberingSeriesId>,
    ) => Effect.Effect<ReadonlyMap<NumberingSeriesId, DocumentKind>, StoreUnavailable>;
  }
>()("kvitbit/core/ContactSeriesLookup") {}

/** A series as the fake knows it. */
export interface FakeSeries {
  readonly workspaceId: WorkspaceId;
  readonly id: NumberingSeriesId;
  readonly kind: DocumentKind;
}

/** Test control for the in-memory `ContactSeriesLookup`. */
export class FakeContactSeries extends Context.Service<
  FakeContactSeries,
  { readonly series: Ref.Ref<ReadonlyArray<FakeSeries>> }
>()("kvitbit/core/testing/FakeContactSeries") {
  static readonly layer: Layer.Layer<FakeContactSeries | ContactSeriesLookup> = Layer.effect(
    ContactSeriesLookup,
    Effect.map(FakeContactSeries, (fake) => ({
      kindsOf: (workspaceId: WorkspaceId, ids: ReadonlyArray<NumberingSeriesId>) =>
        Effect.map(
          Ref.get(fake.series),
          (all) =>
            new Map(
              all
                .filter((s) => s.workspaceId === workspaceId && ids.includes(s.id))
                .map((s) => [s.id, s.kind] as const),
            ),
        ),
    })),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        FakeContactSeries,
        Effect.map(Ref.make<ReadonlyArray<FakeSeries>>([]), (series) => ({ series })),
      ),
    ),
  );
}
