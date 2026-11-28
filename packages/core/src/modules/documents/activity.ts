/**
 * `DocumentActivity`: the narrow read port behind `DocumentView.share` and
 * `DocumentView.deliveries`. Documents owns the port; share links and deliveries own the data,
 * so integration binds it (compose/documentActivity.ts, from ShareLinksRepo + DeliveriesRepo)
 * without documents importing the share-links module (which imports documents).
 *
 * Required by `DocumentsLive`, whose owner reads (`get`, previews) add it (`withActivity` in
 * support.ts), so a composition without it does not compile. Write results, stored, replayed,
 * rendered and visitor views never carry it (`viewOf`).
 */
import type { DocumentId, DocumentView, WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
>()("@kvitbit/core/modules/documents/activity/DocumentActivity") {}

/** No share link, no deliveries: the same views as leaving the port out. */
export const DocumentActivityNone: Layer.Layer<DocumentActivity> = Layer.succeed(
  DocumentActivity,
  DocumentActivity.of({
    share: Effect.fn("DocumentActivity.share")(() => Effect.succeed(null)),
    deliveries: Effect.fn("DocumentActivity.deliveries")(() => Effect.succeed([])),
  }),
);
