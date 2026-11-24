/**
 * `PaymentDocuments`: the three document reads Payments needs beyond the `DocumentPayments`
 * seam (board #386 amendment), as a narrow port so the documents repository stays behind it.
 * `PaymentDocumentsLive` binds it to documents' exported `DocumentsRepo` and `viewOf`; all reads
 * are Workspace-scoped (another Workspace's document is NotFound{Document}). `view` is the stored
 * view (no share, no deliveries): `Payments.record` returns and replays it as is (rule C3).
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
import { DocumentsRepo, viewOf } from "../documents";

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
  }
>()("kvitbit/core/payments/PaymentDocuments") {}

export const PaymentDocumentsLive: Layer.Layer<PaymentDocuments, never, DocumentsRepo> =
  Layer.effect(
    PaymentDocuments,
    // Only the repo is captured: the caller's transaction frame stays the call site's.
    Effect.gen(function* () {
      const repo = yield* DocumentsRepo;
      return PaymentDocuments.of({
        exists: (workspaceId, id) => Effect.asVoid(repo.get(workspaceId, id)),
        paymentMethod: (workspaceId, id) =>
          Effect.map(repo.get(workspaceId, id), (r) => r.paymentMethod),
        view: (workspaceId, id) =>
          Effect.flatMap(repo.get(workspaceId, id), (r) =>
            Effect.provideService(viewOf(r), DocumentsRepo, repo),
          ),
      });
    }),
  );
