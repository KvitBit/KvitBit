/**
 * `PaymentDocuments`: the three document reads Payments needs beyond the `DocumentPayments`
 * seam (board #386 amendment), as a narrow port so the documents repository stays behind it.
 * `PaymentDocumentsLive` binds it to documents' exported `DocumentsRepo`, `viewOf` and
 * `withActivity`; all reads are Workspace-scoped (another Workspace's document is
 * NotFound{Document}). `view` is the stored view (no share, no deliveries: it lands in the
 * `Payments.record` idempotency result); `withActivity` makes it owner-facing at the boundary.
 */
import type {
  DocumentId,
  DocumentView,
  NotFound,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";
import { DocumentActivity, DocumentsRepo, viewOf, withActivity } from "../documents";

type ReadError = NotFound | StoreUnavailable;

export class PaymentDocuments extends Context.Service<
  PaymentDocuments,
  {
    /** listFor's existence check. */
    readonly exists: (workspaceId: WorkspaceId, id: DocumentId) => Effect.Effect<void, ReadError>;
    /** The payment method the document prints (C4 default of `record`). */
    readonly paymentMethod: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<PaymentMethod, ReadError>;
    /** The document's current stored view (the PTD after its auto-send). */
    readonly view: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<DocumentView, ReadError>;
    /** `view` plus its share link and deliveries, for the caller (after the idempotent body). */
    readonly withActivity: (
      workspaceId: WorkspaceId,
      view: DocumentView,
    ) => Effect.Effect<DocumentView, StoreUnavailable>;
  }
>()("kvitbit/core/payments/PaymentDocuments") {}

export const PaymentDocumentsLive: Layer.Layer<
  PaymentDocuments,
  never,
  DocumentsRepo | DocumentActivity
> = Layer.effect(
  PaymentDocuments,
  // Only the repo and activity port are captured: the caller's transaction frame stays the call
  // site's.
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const activity = yield* DocumentActivity;
    return PaymentDocuments.of({
      exists: (workspaceId, id) => Effect.asVoid(repo.get(workspaceId, id)),
      paymentMethod: (workspaceId, id) =>
        Effect.map(repo.get(workspaceId, id), (r) => r.paymentMethod),
      view: (workspaceId, id) =>
        Effect.flatMap(repo.get(workspaceId, id), (r) =>
          Effect.provideService(viewOf(r), DocumentsRepo, repo),
        ),
      withActivity: (workspaceId, view) =>
        Effect.provideService(withActivity(workspaceId, view), DocumentActivity, activity),
    });
  }),
);
