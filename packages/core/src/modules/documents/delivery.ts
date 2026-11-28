/**
 * Delivery read seam (stage 2: cd-delivery under documents/deliveries/**, and the share-links
 * module; board #529). `DocumentSender` (sender.ts) carries send/previewSend; this tag gives
 * those streams what they read about a document. No authorize (the caller has), Workspace
 * scoped (other Workspace -> NotFound{Document}), runs inside the caller's transaction when
 * there is one. Writes of the reminder choice/outcome from documents/deliveries go through
 * `DocumentsRepo` with a revision bump.
 */
import type {
  ContactId,
  DocumentId,
  DocumentSettlement,
  DocumentView,
  IsoDate,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { RenderOptions } from "./ports";
import { DocumentRenderer } from "./ports";
import type { DocumentRecord } from "./record";
import { isOverdue } from "./record";
import { DocumentsRepo } from "./repo";
import { now, viewOf } from "./support";
import type { ViewContext } from "./view";

export interface DeliveryDocument {
  readonly record: DocumentRecord;
  /** The stored view as of now (`viewOf`: no share, no deliveries). */
  readonly view: DocumentView;
  readonly contactId: ContactId;
  readonly dueOn: IsoDate;
  /** What a `send` stored (rule D16) and the outcome of the last arm. */
  readonly reminders: { readonly choice: DocumentRecord["remindersChoice"]; readonly on: boolean };
  readonly settlement: DocumentSettlement;
  readonly overdue: boolean;
}

export class DocumentDeliveryReads extends Context.Service<
  DocumentDeliveryReads,
  {
    readonly load: (
      workspaceId: WorkspaceId,
      id: DocumentId,
      context?: Pick<ViewContext, "language">,
    ) => Effect.Effect<DeliveryDocument, NotFound | StoreUnavailable>;
    /** `DocumentRenderer` passthrough (PDF attachment, share page download). */
    readonly render: (
      view: DocumentView,
      options: RenderOptions,
      workspaceId?: WorkspaceId,
    ) => Effect.Effect<Uint8Array>;
  }
>()("@kvitbit/core/modules/documents/delivery/DocumentDeliveryReads") {}

const load = Effect.fn("load")(function* (
  workspaceId: WorkspaceId,
  id: DocumentId,
  context: Pick<ViewContext, "language"> = {},
) {
  const record = yield* (yield* DocumentsRepo).get(workspaceId, id);
  const { today } = yield* now;
  return {
    record,
    view: yield* viewOf(record, context),
    contactId: record.contactId,
    dueOn: record.dueOn,
    reminders: { choice: record.remindersChoice, on: record.remindersOn },
    settlement: record.settlement,
    overdue: isOverdue(record, today),
  } satisfies DeliveryDocument;
});

export const DocumentDeliveryReadsLive: Layer.Layer<
  DocumentDeliveryReads,
  never,
  DocumentsRepo | DocumentRenderer
> = Layer.effect(
  DocumentDeliveryReads,
  Effect.gen(function* () {
    // Only the build dependencies: the build-time context may hold a RequestOutcome
    // or transaction frame, and providing them per call would override the caller's own.
    const buildContext = yield* Effect.context<DocumentsRepo>();
    const context = Context.pick(DocumentsRepo)(buildContext);
    const renderer = yield* DocumentRenderer;
    return DocumentDeliveryReads.of({
      // The call site's context wins (its transaction frame).
      load: Effect.fn("DocumentDeliveryReads.load")((ws, id, ctx) =>
        Effect.flatMap(Effect.context<never>(), (callSite) =>
          Effect.provideContext(load(ws, id, ctx), Context.merge(context, callSite)),
        ),
      ),
      render: Effect.fn("DocumentDeliveryReads.render")((view, options, workspaceId) =>
        renderer.render(view, options, workspaceId),
      ),
    });
  }),
);
