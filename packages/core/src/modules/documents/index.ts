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
 * - support.ts  `now`, `newDraftRecord`, `viewOf` (the stored view: no share, no deliveries),
 *               `withActivity` (the owner-facing view), `relatedOf`.
 * - activity.ts `DocumentActivity`, the read port behind `DocumentView.share` and `deliveries`
 *               (bound at integration, compose/documentActivity.ts), required by
 *               `DocumentsLive` for its owner reads;
 *               `DocumentActivityNone` for module tests (`share: null`, `deliveries: []`).
 * - drafts.ts   preview, createDraft, discardDraft, editDraft (P1).
 * - reads.ts    get, list, history, pdf (P1).
 * - transitions.ts  the state machine: `TRANSITIONS` (lifecycle state x action -> ok | noop |
 *               Conflict reason), `guard`, and the kind/payment/link guards (`hasDependents`,
 *               `hasFinalInvoice`, `paymentsBlockCancel`). Every method checks state through it.
 * - lifecycle.ts  issue (numbering after the row lock, fresh snapshots, pinned defaults),
 *               editIssued (D3/D3a/D4/D10), lock, unlock, cancel (P2).
 * - credit.ts   Credit Note issuance from a corrected record (`issueCreditNote`, the uncorrected
 *               remainder `remainderSpec`, `remainingBuckets`/`isFullyCredited`) and the stored
 *               settlement: `settlementOf(row, creditNotes)` against `owedOf` (gross minus
 *               credited gross), `outstandingOf`.
 * - corrections.ts  correct, previewCorrection (P3, D7): "full" = the remainder; partial picks
 *               negate a line's quantity at the original's rate, fx and price basis; D7 cap per
 *               bucket against `remainingBuckets` (`credit_note.exceeds_original`).
 * - final.ts    issueFinalInvoice, previewFinalInvoice (P3, D8): the Proforma's lines and terms
 *               + patch, then deduction lines (`deducts`; a PTD bucket's VAT/CZK VAT frozen on
 *               the line as `deductedVat`/`deductedVatCzk`, which `compose` adds as stored;
 *               outside vat_payer one `outside_scope` line for the amount paid). Locks the
 *               Proforma first (S4), links `final_invoice_for` once (`Conflict{duplicate}`).
 * - payments.ts PAYMENTS SEAM (stage 2, cd-payments; board #529), tag `DocumentPayments`
 *               (`DocumentPaymentsLive`), inside the caller's CoreStore transaction, no
 *               authorize, port failures raw (caller maps orUnavailable):
 *               lock(ws, id) -> PaymentTargets {requested, settleOn, proforma} (S4: the
 *                 Proforma first; a Proforma with a Final Invoice settles on the Invoice, D8);
 *               settle(caller, ws, id, {amount, payments}, {action: payment.record|payment.remove,
 *                 reason?, details?}) -> Payable (stores paid total + count, credit-aware
 *                 settlement, revision bump, one audit entry on the Document); Payable carries
 *                 gross/credited/owed/paid/refundDue, regime, finalInvoice/proforma/taxDocuments;
 *               issuePaymentTaxDocument(caller, ws, proforma, {amount, paidOn}) -> DocumentView | null
 *                 (P2: null unless vat_payer on paidOn; VatMath.splitAdvance with the CNB
 *                 fixing for paidOn; PTD series counter after the Proforma lock);
 *               removalBlocked(ws, target, ptd | null) -> "final_invoice_deducts" |
 *                 "tax_document_open" | null (P3: reverse the Final Invoice, then credit the PTD).
 * - delivery.ts DELIVERY READ SEAM (stage 2, cd-delivery and share links; board #529), tag
 *               `DocumentDeliveryReads` (`DocumentDeliveryReadsLive`): load(ws, id, ctx?) ->
 *               {record, view, contactId, dueOn, reminders {choice, on}, settlement, overdue};
 *               render(view, options, workspaceId) (DocumentRenderer). send/previewSend stay `DocumentSender`.
 * - reports.ts  `reportFigures(record)` for the ReportsSource adapter (#384): full totals and
 *               the advance deduction buckets of a Final Invoice (or its Credit Note).
 * - deliveries/ `DocumentSenderLive` (send/previewSend), `DeliveriesRepo`, `DeliveryJobs` and the
 *               DocumentDelivery job steps (claim/dispatch/giveUp); its index.ts maps the files.
 * - reminders/  rule D16 at selection time (`effectiveReminders`, `selectDueReminders`,
 *               `enqueueReminder`); no stored schedule, dates follow the due date.
 * - service.ts  `DocumentsLive`: captures `DocumentsDeps`, wires the method files, dispatches
 *               `edit` by state.
 *
 * Links (`DocumentRecord.links`). Canonical forward relations (the SQL `document_relations`
 * rows): Credit Note `corrects` original; Proforma `final_invoice_for` its Final Invoice;
 * PTD and Final Invoice `advance_of` their Proforma; Final Invoice `deducts` each deducted PTD.
 * The record also stores the read-side inverses for navigation: original `corrected_by` its
 * Credit Notes, Proforma `tax_document_for` each PTD (PTD -> Final Invoice goes through the
 * Proforma).
 *
 * Rules P3 settles (council, design note /home/dev/.t3/orchestrator-state/cd-lc-final-design.md):
 * settlement is a stored cache rebuilt under the row lock from paid totals and Credit Notes
 * (`settlementOf`); a Final Invoice covered by its advances is `paid` with no payments; a PTD
 * is `paid` until fully credited; a Proforma with a Final Invoice is never overdue and owes
 * nothing (`outstandingOf`), its later payments settle on the Final Invoice. A partial
 * correction credits magnitudes against the line's sign, zero effects are refused, partial
 * credits are capped by the uncredited supply (a prepaid Final Invoice stays creditable), CZK
 * VAT included; a Final Invoice's deductions are reversed only by a full remainder credit and
 * it is `credited` only then. A PTD that a live Final Invoice deducts is neither corrected nor
 * cancelled (Proforma locked first, S4), and a Proforma with a Final Invoice gets no more
 * PTDs. A non-tax document with a Credit Note is not cancelled (the credit would count twice). Final Invoice
 * deductions: each PTD's uncredited buckets as stored (own rate and CZK fixing, even when the
 * bucket goes negative: amount due below zero is allowed, user-flows 3.8), plus paid cash no
 * PTD covers as one `outside_scope` line. One Final Invoice per Proforma, also after it is
 * credited or cancelled (unique `final_invoice_for`); a cancelled one releases payment
 * removal. A PTD needs `vat_payer` on `paidOn` (else none); its prices are gross, so VAT is
 * top-down (rule 4) on issue and on partial correction.
 *
 * Known contract gaps (listed for phase2a-core in board #430/#478): C4 resolved
 * language/note/series are on the record but not in DocumentView (deferred for P1); validation
 * issues use `request.malformed` + `params.reason`. `DocumentView.paymentQr` is always null:
 * rule D12 waits on the PaymentQr engine (core-ports 5.3, src/engines; parent ruling, handoff in
 * ~/.t3/orchestrator-state/cd-lifecycle-paymentqr-handoff/). When it lands, run it in `compose`
 * (validation, with the allocated number at issue) and in `toView`.
 */
import type { DocumentView } from "@kvitbit/domain/contract";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { NumberingTestLayer } from "../numbering";
import { type DocumentActivity, DocumentActivityNone } from "./activity";
import { DeliveriesRepoMemory, DeliveryJobsMemory, DocumentSenderLive } from "./deliveries";
import { DocumentDeliveryReadsLive } from "./delivery";
import { DocumentFakesLive } from "./fakes";
import { DocumentPaymentsLive } from "./payments";
import { DocumentsRepoMemory } from "./repo";
import { DocumentSenderStub } from "./sender";
import { DocumentsLive } from "./service";
import { DocumentViewCodec as ConcreteDocumentViewCodec } from "./view";

export const DocumentViewCodec: Schema.Codec<DocumentView, unknown> = ConcreteDocumentViewCodec;

export { DocumentActivity, DocumentActivityNone } from "./activity";
export type { Composed, ComposeOptions, Deduction, DocumentSpec, LineSpec } from "./compose";
export {
  applyPatch,
  compose,
  defaultTreatment,
  expandLines,
  isTaxDocument,
  mergeBuckets,
  specFromInput,
  specFromRecord,
} from "./compose";
export { correct, loadForCredit, previewCorrection } from "./corrections";
export type { CreditLine, CreditSpec, IssueCreditNoteInput } from "./credit";
export {
  creditNoteRecord,
  deductionBucketsOf,
  deductionsOpen,
  digitsOf,
  isFullyCredited,
  issueCreditNote,
  outstandingOf,
  owedOf,
  remainderSpec,
  remainingBuckets,
  roundingLeft,
  settlementOf,
  withRounding,
} from "./credit";
export * from "./deliveries";
export type { DeliveryDocument } from "./delivery";
export { DocumentDeliveryReads, DocumentDeliveryReadsLive } from "./delivery";
export type { RenderCall } from "./fakes";
export { DocumentFakesLive, DocumentFixtures, DocumentRendererFake, fakePdfBytes } from "./fakes";
export { issueFinalInvoice, previewFinalInvoice } from "./final";
export type { CancelInput, CancelResult, IssueFrom } from "./lifecycle";
export {
  CancelResultCodec,
  cancel,
  diffRecords,
  editIssued,
  issue,
  lock,
  numbered,
  unlock,
} from "./lifecycle";
export type { Payable, PaymentTargets, RemovalBlock, SettleAudit } from "./payments";
export {
  DocumentPayments,
  DocumentPaymentsLive,
  payableOf,
  paymentTaxDocumentRecord,
} from "./payments";
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
export * from "./reminders";
export type { DocumentPage, DocumentSearch } from "./repo";
export { DocumentsRepo, DocumentsRepoMemory } from "./repo";
export { reportFigures } from "./reports";
export { DocumentSender, DocumentSenderStub } from "./sender";
export type { DocumentsDeps } from "./service";
export { DocumentsLive } from "./service";
export {
  newDraftRecord,
  now,
  relatedOf,
  viewOf,
  withActivity,
} from "./support";
export type { LifecycleAction, LifecycleState, TransitionOutcome } from "./transitions";
export {
  guard,
  hasDependents,
  hasFinalInvoice,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  outcomeOf,
  paymentsBlockCancel,
  stateOf,
  TRANSITIONS,
} from "./transitions";
export type { RelatedDocument, ViewContext } from "./view";
export {
  DocumentSummaryCodec,
  DocumentSummaryData,
  DocumentViewData,
  LineViewData,
  toLineView,
  toSummary,
  toView,
} from "./view";

/**
 * `Documents` plus both stage-2 seams (`DocumentPayments`, `DocumentDeliveryReads`) on the
 * memory repo, the in-memory numbering module, the port fakes and the sender stub, exposing
 * `DocumentsRepo`, `NumberingSeries` and `DocumentFixtures` for seeding.
 * Requires `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator, ExchangeRates).
 */
export const DocumentsTestLayer = Layer.mergeAll(
  DocumentsLive,
  DocumentPaymentsLive,
  DocumentDeliveryReadsLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      DocumentsRepoMemory,
      NumberingTestLayer,
      DocumentFakesLive,
      DocumentSenderStub,
      DocumentActivityNone,
    ),
  ),
);

/**
 * `DocumentsTestLayer` with the real `DocumentSenderLive` instead of the stub, plus the memory
 * `DeliveriesRepo` and `DeliveryJobs`; exposes `DeliveriesRepo` and `StartedDeliveries`, with
 * the given `DocumentActivity` (compose tests bind `DocumentActivityLive`).
 * Requires `InMemoryPortsLive` (also EmailSender via CaptureEmailSender).
 */
export const documentsDeliveryTestLayer = <R>(activity: Layer.Layer<DocumentActivity, never, R>) =>
  Layer.mergeAll(DocumentsLive, DocumentPaymentsLive, DocumentDeliveryReadsLive).pipe(
    Layer.provideMerge(DocumentSenderLive),
    Layer.provideMerge(
      Layer.mergeAll(
        DocumentsRepoMemory,
        NumberingTestLayer,
        DocumentFakesLive,
        DeliveriesRepoMemory,
        DeliveryJobsMemory,
        activity,
      ),
    ),
  );

/** `documentsDeliveryTestLayer` without share links or deliveries in views. */
export const DocumentsDeliveryTestLayer = documentsDeliveryTestLayer(DocumentActivityNone);
