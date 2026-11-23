/**
 * Documents module (core-ports 4.4): Invoice, Proforma, Payment Tax Document, Credit Note.
 * `DocumentsLive` implements the domain `Documents` tag.
 *
 * Internal structure (files in this directory):
 * - record.ts   the stored aggregate `DocumentRecord` (`documents` table, `DocumentsTable`,
 *               unique `documents_number_per_kind`): kind, status, lock, number/series, frozen
 *               contact + issuer snapshots, the caller's `given` fields next to their resolved
 *               values, lines (resolved treatment/rate, `deducts` for Final Invoice deductions),
 *               totals (VatBreakdown), fx + manual override, taxDocument, reminder choice as
 *               given (`remindersChoice`, `remindersOn`), links (DocumentRelation), paid totals
 *               (`paidAmount`, `payments`) with the stored `settlement`, cancel date, timestamps.
 * - repo.ts     `DocumentsRepo` port (get/getMany/getForUpdate/lock/insert/update/remove/search,
 *               linkSchedule for recurring issuance, board #450)
 *               + `DocumentsRepoMemory`.
 * - ports.ts    read ports `DocumentContacts`, `DocumentPriceList` (= core-identity #402),
 *               `DocumentIssuers` (#407) and `DocumentRenderer` (view -> PDF bytes);
 *               fakes.ts holds their in-memory fakes, seeded via `DocumentFixtures`.
 * - sender.ts   delivery seam `DocumentSender` (= domain send/previewSend; Live delegates to
 *               it) and `DocumentSenderStub`.
 * - compose.ts  the shared computation (rule D15): `DocumentSpec` (from input, record or
 *               record + patch) -> resolved defaults, D9 treatments/validation, D11 rate,
 *               VatMath totals. Every write and dry run goes through `compose`.
 * - view.ts     record -> DocumentView/DocumentSummary, concrete codecs for the domain
 *               placeholders (`DocumentViewCodec` is the C3 result codec).
 * - support.ts  `now`, `newDraftRecord`, `viewOf`/`relatedOf`,
 *               `notImplemented`.
 * - drafts.ts   preview, createDraft, discardDraft, editDraft (P1).
 * - reads.ts    get, list, history, pdf (P1).
 * - service.ts  `DocumentsLive`: captures `DocumentsDeps`, wires the method files, dispatches
 *               `edit` by state, and stubs later-phase methods with `notImplemented`.
 *
 * Known contract gaps (domain frozen; listed for phase2a-core in board #430/#478): C4 resolved
 * language/note/series are on the record but not in DocumentView (deferred for P1); validation
 * issues use `request.malformed` + `params.reason`; error channels are widened through one cast
 * in service.ts (#341 approach). Payment QR amount exception: see qr.ts.
 *
 * Extension points:
 * - P2 (issue, state machine): add lifecycle.ts with `issue` (recompose via `compose` with
 *   `today`, then `NumberingSeries.resolve` + `allocate` after the row lock, S4; fresh
 *   snapshots at issue, D10; audit "document.issue"), `lock`/`unlock`/`cancel`, and
 *   `editIssued` (D3/D3a/D4/D5/D10 via `compose`'s `freeze` option). Put the transition table
 *   (state x operation -> next state | Conflict{illegal_transition}) in transitions.ts and
 *   route `edit`'s "issued"/"cancelled" branches and the stubbed methods in service.ts to it.
 * - P3 (corrections, final invoice, PTD, stage-2 seams): corrections.ts / final.ts build
 *   `DocumentSpec`s (negated or deduction lines with `deducts`) and run `compose`; links go in
 *   `DocumentRecord.links`; payments.ts is the payments seam (lock Proforma first, S2-S4;
 *   write `paidAmount`/`payments`/`settlement`; PTD via VatMath.splitAdvance). Stage-2
 *   deliveries/share links read records through `DocumentsRepo` + `viewOf` and pass
 *   `share`/`deliveries` into `toView`'s `ViewContext`.
 */
import { Layer } from "effect";
import { NumberingTestLayer } from "../numbering";
import { DocumentFakesLive } from "./fakes";
import { DocumentsRepoMemory } from "./repo";
import { DocumentSenderStub } from "./sender";
import { DocumentsLive } from "./service";

export type { Composed, ComposeOptions, DocumentSpec, LineSpec } from "./compose";
export {
  applyPatch,
  compose,
  defaultTreatment,
  expandLines,
  isTaxDocument,
  specFromInput,
  specFromRecord,
} from "./compose";
export type { RenderCall } from "./fakes";
export { DocumentFakesLive, DocumentFixtures, fakePdfBytes } from "./fakes";
export type {
  ContactForDocument,
  IssuerBankAccount,
  IssuerForDocument,
  PriceListItemForLine,
  RenderOptions,
} from "./ports";
export { DocumentContacts, DocumentIssuers, DocumentPriceList, DocumentRenderer } from "./ports";
export type {
  AddressRecord,
  BankAccountRecord,
  ContactSnapshotRecord,
  DraftableKind,
  FxRecord,
  GivenFields,
  IssuerSnapshotRecord,
  LineRecord,
  LinkRecord,
} from "./record";
export {
  DocumentRecord,
  DocumentsTable,
  isOverdue,
  NUMBER_PER_KIND,
  SCHEDULE_OCCURRENCE,
} from "./record";
export type { DocumentPage, DocumentSearch } from "./repo";
export { DocumentsRepo, DocumentsRepoMemory } from "./repo";
export { DocumentSender, DocumentSenderStub } from "./sender";
export type { DocumentsDeps } from "./service";
export { DocumentsLive } from "./service";
export {
  newDraftRecord,
  notImplemented,
  now,
  relatedOf,
  viewOf,
} from "./support";
export type { RelatedDocument, ViewContext } from "./view";
export {
  DocumentSummaryCodec,
  DocumentSummaryData,
  DocumentViewCodec,
  DocumentViewData,
  LineViewData,
  toLineView,
  toSummary,
  toView,
} from "./view";

/**
 * `Documents` on the memory repo, the in-memory numbering module, the port fakes and the
 * sender stub, exposing `DocumentsRepo`, `NumberingSeries` and `DocumentFixtures` for seeding.
 * Requires `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator, ExchangeRates).
 */
export const DocumentsTestLayer = DocumentsLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(DocumentsRepoMemory, NumberingTestLayer, DocumentFakesLive, DocumentSenderStub),
  ),
);
