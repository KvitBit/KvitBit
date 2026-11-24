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
  CurrentCaller,
  DocumentId,
  DocumentSettlement,
  DocumentView,
  IsoDate,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
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
  /** The view as of now, with the given share/deliveries context. */
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
      context?: Pick<ViewContext, "share" | "deliveries" | "language">,
    ) => Effect.Effect<DeliveryDocument, NotFound | StoreUnavailable, CurrentCaller>;
    /** `DocumentRenderer` passthrough (PDF attachment, share page download). */
    readonly render: (view: DocumentView, options: RenderOptions) => Effect.Effect<Uint8Array>;
  }
>()("kvitbit/core/documents/DocumentDeliveryReads") {}

const load = (
  workspaceId: WorkspaceId,
  id: DocumentId,
  context: Pick<ViewContext, "share" | "deliveries" | "language"> = {},
) =>
  Effect.gen(function* () {
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
    const context = yield* Effect.context<DocumentsRepo>();
    const renderer = yield* DocumentRenderer;
    return DocumentDeliveryReads.of({
      // The call site's context wins (its transaction frame).
      load: (ws, id, ctx) =>
        Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
          Effect.provideContext(load(ws, id, ctx), Context.merge(context, callSite)),
        ),
      render: (view, options) => renderer.render(view, options),
    });
  }),
);
