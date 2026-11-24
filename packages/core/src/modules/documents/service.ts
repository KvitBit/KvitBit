/**
 * `DocumentsLive`: the domain `Documents` tag over the method files. Every dependency is
 * captured when the layer is built, so each method only needs `CurrentCaller`.
 */
import type { CoreError, DocumentId, DocumentPatch, DocumentView } from "@kvitbit/domain/contract";
import { CurrentCaller, Documents } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import { FxFixings } from "../../shared/fx";
import { IdGenerator } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { NumberingSeries } from "../numbering";
import { DocumentActivity } from "./activity";
import { correct, previewCorrection } from "./corrections";
import { createDraft, discardDraft, editDraft, preview } from "./drafts";
import { issueFinalInvoice, previewFinalInvoice } from "./final";
import { cancel, editIssued, issue, lock, unlock } from "./lifecycle";
import { DocumentContacts, DocumentIssuers, DocumentPriceList, DocumentRenderer } from "./ports";
import { get, history, list, pdf } from "./reads";
import { DocumentsRepo } from "./repo";
import { DocumentSender } from "./sender";
import { withActivity } from "./support";
import { guard } from "./transitions";

/** Everything `DocumentsLive` requires. */
export type DocumentsDeps =
  | CoreStore
  | IdGenerator
  | DocumentsRepo
  | NumberingSeries
  | FxFixings
  | DocumentContacts
  | DocumentIssuers
  | DocumentPriceList
  | DocumentRenderer
  | DocumentSender
  | DocumentActivity;

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
        const view =
          row.status === "draft" ? yield* editDraft(row, patch) : yield* editIssued(row, patch);
        return yield* withActivity(workspaceId, view);
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

/**
 * The owner-facing view of a read or dry run: `share` and `deliveries` added after the method.
 * Writes add them themselves, inside their transaction (`withIdempotency`'s `present`), so a
 * failing activity read rolls the write back instead of failing after it committed.
 */
const enriched = <E, R>(effect: Effect.Effect<DocumentView, E, R>) =>
  Effect.gen(function* () {
    const view = yield* effect;
    const caller = yield* CurrentCaller;
    // A successful method had a Workspace caller (authorizeInWorkspace).
    return caller._tag === "Member" || caller._tag === "System"
      ? yield* withActivity(caller.workspaceId, view)
      : view;
  }).pipe(orUnavailable);

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const context = Context.pick(
    CoreStore,
    IdGenerator,
    DocumentsRepo,
    NumberingSeries,
    FxFixings,
    DocumentContacts,
    DocumentIssuers,
    DocumentPriceList,
    DocumentRenderer,
    DocumentSender,
    DocumentActivity,
  )(yield* Effect.context<DocumentsDeps>());
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
    preview: (input) => run(enriched(preview(input))),
    createDraft: (input, opts) => run(createDraft(input, opts)),
    discardDraft: (id, expectedRevision) => run(discardDraft(id, expectedRevision)),
    edit: (id, patch, expectedRevision) => run(edit(id, patch, expectedRevision)),
    get: (id) => run(enriched(get(id))),
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
    previewCorrection: (id, input) => run(enriched(previewCorrection(id, input))),
    issueFinalInvoice: (proforma, input, opts) => run(issueFinalInvoice(proforma, input, opts)),
    previewFinalInvoice: (proforma, input) => run(enriched(previewFinalInvoice(proforma, input))),
  };
  return Documents.of(impl as unknown as Documents["Service"]);
});

export const DocumentsLive: Layer.Layer<Documents, never, DocumentsDeps> = Layer.effect(
  Documents,
  make,
);
