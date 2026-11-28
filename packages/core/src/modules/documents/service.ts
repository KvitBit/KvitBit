/**
 * `DocumentsLive`: the domain `Documents` tag over the method files. Every dependency is
 * captured when the layer is built, so each method needs only its explicit `caller`.
 */
import type { Caller, DocumentId, DocumentPatch, DocumentView } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
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
  function* (caller: Caller, id: DocumentId, patch: DocumentPatch, expectedRevision: number) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.edit");
    if (patch.number !== undefined) yield* authorizeInWorkspace(caller, "document.overrideNumber");
    const store = yield* CoreStore;
    const repo = yield* DocumentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        const row = yield* repo.getForUpdate(workspaceId, id, expectedRevision);
        yield* guard(row, "edit");
        return row.status === "draft"
          ? yield* editDraft(caller, row, patch)
          : yield* editIssued(caller, row, patch);
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
  function* <E, R>(caller: Caller, effect: Effect.Effect<DocumentView, E, R>) {
    const view = yield* effect;
    // A successful method had a Workspace caller (authorizeInWorkspace).
    return caller._tag === "Member" || caller._tag === "System"
      ? yield* withActivity(caller.workspaceId, view, can(caller, "share.read"))
      : view;
  },
  (_) => orUnavailable(_),
);

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a RequestOutcome
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
  const run = <A, E>(effect: Effect.Effect<A, E, DocumentsDeps>) =>
    Effect.flatMap(Effect.context<never>(), (callSite) =>
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
    preview: Effect.fn("Documents.preview")((caller, input) =>
      run(enriched(caller, preview(caller, input))),
    ),
    createDraft: Effect.fn("Documents.createDraft")((caller, input, opts) =>
      run(createDraft(caller, input, opts)),
    ),
    discardDraft: Effect.fn("Documents.discardDraft")((caller, id, expectedRevision) =>
      run(discardDraft(caller, id, expectedRevision)),
    ),
    edit: Effect.fn("Documents.edit")((caller, id, patch, expectedRevision) =>
      run(edit(caller, id, patch, expectedRevision)),
    ),
    get: Effect.fn("Documents.get")((caller, id) => run(enriched(caller, get(caller, id)))),
    list: Effect.fn("Documents.list")((caller, q) => run(list(caller, q))),
    history: Effect.fn("Documents.history")((caller, id) => run(history(caller, id))),
    pdf: Effect.fn("Documents.pdf")((caller, id, opts) => run(pdf(caller, id, opts))),
    send: Effect.fn("Documents.send")((caller, id, input, opts) =>
      sender.send(caller, id, input, opts),
    ),
    previewSend: Effect.fn("Documents.previewSend")((caller, id, input) =>
      sender.previewSend(caller, id, input),
    ),
    issue: Effect.fn("Documents.issue")((caller, from, opts) => run(issue(caller, from, opts))),
    lock: Effect.fn("Documents.lock")((caller, id) => run(lock(caller, id))),
    unlock: Effect.fn("Documents.unlock")((caller, id, reason) => run(unlock(caller, id, reason))),
    cancel: Effect.fn("Documents.cancel")((caller, id, input, opts) =>
      run(cancel(caller, id, input, opts)),
    ),
    correct: Effect.fn("Documents.correct")((caller, id, input, opts) =>
      run(correct(caller, id, input, opts)),
    ),
    previewCorrection: Effect.fn("Documents.previewCorrection")((caller, id, input) =>
      run(enriched(caller, previewCorrection(caller, id, input))),
    ),
    issueFinalInvoice: Effect.fn("Documents.issueFinalInvoice")((caller, proforma, input, opts) =>
      run(issueFinalInvoice(caller, proforma, input, opts)),
    ),
    previewFinalInvoice: Effect.fn("Documents.previewFinalInvoice")((caller, proforma, input) =>
      run(enriched(caller, previewFinalInvoice(caller, proforma, input))),
    ),
  });
});

export const DocumentsLive: Layer.Layer<Documents, never, DocumentsDeps> = Layer.effect(
  Documents,
  make,
);
