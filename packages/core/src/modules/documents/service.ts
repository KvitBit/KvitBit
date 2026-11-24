/**
 * `DocumentsLive`: the domain `Documents` tag over the method files. Every dependency is
 * captured when the layer is built, so each method only needs `CurrentCaller`.
 */
import type { CoreError, CurrentCaller, DocumentId, DocumentPatch } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import type { ExchangeRates } from "@kvitbit/domain/ports";
import { Context, Effect, Layer } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import type { IdGenerator } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import type { NumberingSeries } from "../numbering";
import { correct, previewCorrection } from "./corrections";
import { createDraft, discardDraft, editDraft, preview } from "./drafts";
import { issueFinalInvoice, previewFinalInvoice } from "./final";
import { cancel, editIssued, issue, lock, unlock } from "./lifecycle";
import type {
  DocumentContacts,
  DocumentIssuers,
  DocumentPriceList,
  DocumentRenderer,
} from "./ports";
import { get, history, list, pdf } from "./reads";
import { DocumentsRepo } from "./repo";
import { DocumentSender } from "./sender";
import { guard } from "./transitions";

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
 * `edit` dispatches on the locked row's state (transition table): drafts (P1's `editDraft`),
 * issued documents (`editIssued`: D3 diff audit, D3a freezes, D4 number, D10 parties);
 * locked documents fail with `document_locked` and cancelled ones with `illegal_transition`.
 * A `number` needs `document.overrideNumber` (owner/admin, D4) on top of `document.edit`.
 */
const edit = (id: DocumentId, patch: DocumentPatch, expectedRevision: number) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.edit");
    if (patch.number !== undefined) yield* authorizeInWorkspace("document.overrideNumber");
    const store = yield* CoreStore;
    const repo = yield* DocumentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        const row = yield* repo.getForUpdate(workspaceId, id, expectedRevision);
        yield* guard(row, "edit");
        return row.status === "draft"
          ? yield* editDraft(row, patch)
          : yield* editIssued(row, patch);
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
   * history lack Unavailable{database}. DocumentView lacks the resolved language, note and
   * series that rule C4 asks views to echo: DEFERRED for P1 (parent ruling; board #430/#478),
   * they stay on the record. No IssueCodes exist for IBAN / variable symbol / required-field
   * validation: core-wide interim is `request.malformed` + `params.reason` (#430/#478).
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
    issue: (from, opts) => run(issue(from, opts)),
    lock: (id) => run(lock(id)),
    unlock: (id, reason) => run(unlock(id, reason)),
    cancel: (id, input, opts) => run(cancel(id, input, opts)),
    correct: (id, input, opts) => run(correct(id, input, opts)),
    previewCorrection: (id, input) => run(previewCorrection(id, input)),
    issueFinalInvoice: (proforma, input, opts) => run(issueFinalInvoice(proforma, input, opts)),
    previewFinalInvoice: (proforma, input) => run(previewFinalInvoice(proforma, input)),
  };
  return Documents.of(impl as unknown as Documents["Service"]);
});

export const DocumentsLive: Layer.Layer<Documents, never, DocumentsDeps> = Layer.effect(
  Documents,
  make,
);
