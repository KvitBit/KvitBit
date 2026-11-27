/**
 * `DocumentsLive`: the domain `Documents` tag over the method files. Every dependency is
 * captured when the layer is built, so each method only needs `CurrentCaller`.
 */
import type { DocumentId, DocumentPatch, DocumentView } from "@kvitbit/domain/contract";
import { CurrentCaller, Documents } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { can } from "../../policy/can";
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
const edit = Effect.fn("edit")(
  function* (id: DocumentId, patch: DocumentPatch, expectedRevision: number) {
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
  },
  (_) => orUnavailable(_),
);

/**
 * The owner-facing view of a read or dry run: `share` and `deliveries` added after the method.
 * Write results are never enriched (`share: null`, `deliveries: []`), so a keyed replay
 * returns exactly the stored result (rule C3) and an activity read never touches a write.
 */
const enriched = Effect.fn("enriched")(
  function* <E, R>(effect: Effect.Effect<DocumentView, E, R>) {
    const view = yield* effect;
    const caller = yield* CurrentCaller;
    // A successful method had a Workspace caller (authorizeInWorkspace).
    return caller._tag === "Member" || caller._tag === "System"
      ? yield* withActivity(caller.workspaceId, view, can(caller, "share.read"))
      : view;
  },
  (_) => orUnavailable(_),
);

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const buildContext = yield* Effect.context<DocumentsDeps>();
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
  )(buildContext);
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
   * Every method's honest error channel fits the domain signature, so there is no cast.
   * DocumentView lacks the resolved language, note and series that rule C4 asks views to echo:
   * DEFERRED for P1 (parent ruling; board #430/#478), they stay on the record. No IssueCodes
   * exist for IBAN / variable symbol / required-field validation: core-wide interim is
   * `request.malformed` + `params.reason` (#430/#478).
   */
  return Documents.of({
    preview: Effect.fn("Documents.preview")((input) => preview(input).pipe(enriched, run)),
    createDraft: Effect.fn("Documents.createDraft")((input, opts) => run(createDraft(input, opts))),
    discardDraft: Effect.fn("Documents.discardDraft")((id, expectedRevision) =>
      run(discardDraft(id, expectedRevision)),
    ),
    edit: Effect.fn("Documents.edit")((id, patch, expectedRevision) =>
      run(edit(id, patch, expectedRevision)),
    ),
    get: Effect.fn("Documents.get")((id) => get(id).pipe(enriched, run)),
    list: Effect.fn("Documents.list")((q) => run(list(q))),
    history: Effect.fn("Documents.history")((id) => run(history(id))),
    pdf: Effect.fn("Documents.pdf")((id, opts) => run(pdf(id, opts))),
    send: Effect.fn("Documents.send")(function* (id, input, opts) {
      const caller = yield* CurrentCaller;
      return yield* sender.send(caller, id, input, opts);
    }),
    previewSend: Effect.fn("Documents.previewSend")(function* (id, input) {
      const caller = yield* CurrentCaller;
      return yield* sender.previewSend(caller, id, input);
    }),
    issue: Effect.fn("Documents.issue")((from, opts) => run(issue(from, opts))),
    lock: Effect.fn("Documents.lock")((id) => run(lock(id))),
    unlock: Effect.fn("Documents.unlock")((id, reason) => run(unlock(id, reason))),
    cancel: Effect.fn("Documents.cancel")((id, input, opts) => run(cancel(id, input, opts))),
    correct: Effect.fn("Documents.correct")((id, input, opts) => run(correct(id, input, opts))),
    previewCorrection: Effect.fn("Documents.previewCorrection")((id, input) =>
      previewCorrection(id, input).pipe(enriched, run),
    ),
    issueFinalInvoice: Effect.fn("Documents.issueFinalInvoice")((proforma, input, opts) =>
      run(issueFinalInvoice(proforma, input, opts)),
    ),
    previewFinalInvoice: Effect.fn("Documents.previewFinalInvoice")((proforma, input) =>
      previewFinalInvoice(proforma, input).pipe(enriched, run),
    ),
  });
});

export const DocumentsLive: Layer.Layer<Documents, never, DocumentsDeps> = Layer.effect(
  Documents,
  make,
);
