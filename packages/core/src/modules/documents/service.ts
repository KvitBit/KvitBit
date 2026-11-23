/**
 * `DocumentsLive`: the domain `Documents` tag over the method files. Every dependency is
 * captured when the layer is built, so each method only needs `CurrentCaller`.
 */
import type { CoreError, CurrentCaller, DocumentId, DocumentPatch } from "@kvitbit/domain/contract";
import { Conflict, Documents } from "@kvitbit/domain/contract";
import type { ExchangeRates } from "@kvitbit/domain/ports";
import { Context, Effect, Layer } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import type { IdGenerator } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import type { NumberingSeries } from "../numbering";
import { createDraft, discardDraft, editDraft, preview } from "./drafts";
import type {
  DocumentContacts,
  DocumentIssuers,
  DocumentPriceList,
  DocumentRenderer,
} from "./ports";
import { get, history, list, pdf } from "./reads";
import { DocumentsRepo } from "./repo";
import { DocumentSender } from "./sender";
import { notImplemented } from "./support";

/** Everything `DocumentsLive` requires. */
export type DocumentsDeps =
  | CoreStore
  | IdGenerator
  | DocumentsRepo
  | NumberingSeries
  | ExchangeRates
  | DocumentContacts
  | DocumentIssuers
  | DocumentPriceList
  | DocumentRenderer
  | DocumentSender;

/**
 * `edit` dispatches on the locked row's state: drafts here (P1); issued documents are P2's
 * (`editIssued`: D3 field diff audit, D3a freezes, D4 number, D5 lock, D10 refreshParties);
 * a cancelled document accepts no edits (D3a).
 */
const edit = (id: DocumentId, patch: DocumentPatch, expectedRevision: number) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.edit");
    const store = yield* CoreStore;
    const repo = yield* DocumentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        const row = yield* repo.getForUpdate(workspaceId, id, expectedRevision);
        switch (row.status) {
          case "draft":
            return yield* editDraft(row, patch);
          case "cancelled":
            return yield* new Conflict({ reason: "illegal_transition" });
          case "issued":
            return yield* notImplemented("edit (issued document)", "P2");
        }
      }),
    );
  }).pipe(orUnavailable);

type DocumentsShape = Documents["Service"];
/** The domain shape with every method's error channel widened to `CoreError`. */
type WideDocuments = {
  readonly [K in keyof DocumentsShape]: (
    ...args: Parameters<DocumentsShape[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<DocumentsShape[K]>>, CoreError, CurrentCaller>;
};

const make = Effect.gen(function* () {
  const context = yield* Effect.context<DocumentsDeps>();
  const sender = yield* DocumentSender;
  /**
   * Provides the captured dependencies under the call-time context, which wins: the caller,
   * `RequestOutcome` and the CoreStore transaction frame of an enclosing transaction (nested
   * calls, e.g. recurring issuance, run as savepoints) all come from the call site.
   */
  const run = <A, E>(effect: Effect.Effect<A, E, DocumentsDeps | CurrentCaller>) =>
    Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  /**
   * The one cast at the layer boundary (same approach as Contacts/Workspaces, board #341):
   * methods keep their honest error types. Domain signature gaps, for a domain fix at
   * integration: preview lacks NotFound (missing Contact/item/bank/series/Workspace);
   * createDraft lacks Conflict{idempotency_mismatch} (C3); discardDraft, get, list and
   * history lack Unavailable{database}.
   */
  const impl: WideDocuments = {
    preview: (input) => run(preview(input)),
    createDraft: (input, opts) => run(createDraft(input, opts)),
    discardDraft: (id, expectedRevision) => run(discardDraft(id, expectedRevision)),
    edit: (id, patch, expectedRevision) => run(edit(id, patch, expectedRevision)),
    get: (id) => run(get(id)),
    list: (q) => run(list(q)),
    history: (id) => run(history(id)),
    pdf: (id, opts) => run(pdf(id, opts)),
    // Delivery seam (stage 2): delegated unchanged.
    send: (id, input, opts) => sender.send(id, input, opts),
    previewSend: (id, input) => sender.previewSend(id, input),
    // P2: issue (numbering, snapshots), lock/unlock, cancel.
    issue: () => notImplemented("issue", "P2"),
    lock: () => notImplemented("lock", "P2"),
    unlock: () => notImplemented("unlock", "P2"),
    cancel: () => notImplemented("cancel", "P2"),
    // P3: corrections, Final Invoice.
    correct: () => notImplemented("correct", "P3"),
    previewCorrection: () => notImplemented("previewCorrection", "P3"),
    issueFinalInvoice: () => notImplemented("issueFinalInvoice", "P3"),
    previewFinalInvoice: () => notImplemented("previewFinalInvoice", "P3"),
  };
  return Documents.of(impl as unknown as Documents["Service"]);
});

export const DocumentsLive: Layer.Layer<Documents, never, DocumentsDeps> = Layer.effect(
  Documents,
  make,
);
