/**
 * `DocumentActivity`: the narrow read port behind `DocumentView.share` and
 * `DocumentView.deliveries`. Documents owns the port; share links and deliveries own the data,
 * so integration binds it (compose/documentActivity.ts, from ShareLinksRepo + DeliveriesRepo)
 * without documents importing the share-links module (which imports documents).
 *
 * Optional, like `RequestOutcome`: `viewOf` reads it with `Effect.serviceOption`, so it never
 * appears in a method's `R`. Without it a view carries `share: null` and `deliveries: []`.
 * It reaches the methods through the context `DocumentsLive` (and the other documents layers)
 * captured when built, so provide it to those layers.
 */
import type { DocumentId, DocumentView, WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";

export class DocumentActivity extends Context.Service<
  DocumentActivity,
  {
    /** The active share link and its view statistics; null when there is none. */
    readonly share: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<DocumentView["share"], StoreUnavailable>;
    /** The document's deliveries in queueing order. */
    readonly deliveries: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<DocumentView["deliveries"], StoreUnavailable>;
  }
>()("kvitbit/core/documents/DocumentActivity") {}

/** No share link, no deliveries: the same views as leaving the port out. */
export const DocumentActivityNone: Layer.Layer<DocumentActivity> = Layer.succeed(
  DocumentActivity,
  DocumentActivity.of({
    share: () => Effect.succeed(null),
    deliveries: () => Effect.succeed([]),
  }),
);
