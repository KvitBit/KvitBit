/**
 * Payments module (core-ports 4.5). `PaymentsLive` implements the domain `Payments` tag.
 *
 * Files:
 * - record.ts   `PaymentRecord` (`payments` table, soft delete via `removedAt`), the concrete
 *               `PaymentViewData` behind the domain placeholder, the C3 codecs, and
 *               `reportPayment(row, fx)` for the ReportsSource adapter (board #397/#580).
 * - repo.ts     `PaymentsRepo` (get/lock/insert/update, `liveFor(target)`, `paidBetween(range)`)
 *               + `PaymentsRepoMemory`.
 * - ports.ts    narrow ports bound at integration: `ExpensePayables` (= ce-expenses' tag, same key
 *               and shape, board #395/#409/#579) and `PaymentSettings` (Workspace setting
 *               `autoSendPaymentTaxDocument`, board #581).
 * - fakes.ts    `PaymentFakesLive`: ExpensePayables, PaymentSettings and a recording
 *               `DocumentSender`, seeded and inspected via `PaymentFixtures`.
 * - service.ts  record, remove, listFor.
 *
 * Documents are reached only through documents' payments seam `DocumentPayments` (board
 * #554/#571; it runs inside this module's transaction and never authorizes), the narrow read
 * port `PaymentDocuments` (documentReads.ts: exists, printed paymentMethod, view; bound by
 * `PaymentDocumentsLive` to documents' exported `DocumentsRepo`/`viewOf`, board #386
 * amendment) and `DocumentSender.send` (PTD auto-send).
 *
 * Rules:
 * - Authorization: `payment.write` for record/remove, `payment.read` for listFor, before the
 *   request-log replay (R1a). Another Workspace's payment or target is NotFound (R2).
 * - record: one transaction under the request key (C3). Lock order S4/P2a: the Proforma first
 *   (`DocumentPayments.lock`), then the Final Invoice, then the PTD counter. A payment on a
 *   Proforma that has a Final Invoice is stored against and settles the Final Invoice (D8).
 *   Amount defaults to what is outstanding (owed - paid, credit aware; nothing outstanding ->
 *   Invalid{amount, required}), paidOn to today (Prague), method to the document's printed one
 *   (bank_transfer for expenses); the amount must be positive, within the currency's minor unit
 *   and numeric(18,2) (scale <= 2 even for three-decimal currencies), and in the target's currency (P1, Invalid{payment.currency_mismatch}).
 *   Only issued, not fully credited Invoices and Proformas take payments, locked ones too (P4).
 *   The target's paid total is recomputed from its live rows; documents derives the settlement
 *   and writes the one audit entry on the Document (payment.record, with the payment's
 *   particulars). On a Proforma, P2 issues the Payment Tax Document (null unless vat_payer on
 *   paidOn), links it to the payment and, when `autoSendPaymentTaxDocument` is on and the caller
 *   may `document.send`, sends it in the same transaction.
 * - Expense targets: incomplete -> Invalid{expense.incomplete}; currency P1; the audit entry is
 *   written here on the Expense subject (ExpensePayables does not audit).
 * - remove: idempotent by state (C6; a removed payment returns), reason required. Locks the
 *   target before the payment row; P3 via `DocumentPayments.removalBlocked` (reverse the Final
 *   Invoice first, then credit the PTD) -> Conflict{illegal_transition, payment.has_tax_document}.
 * - listFor: live payments of the target (for a Proforma: the advances it settled), oldest first.
 * - Auto-send gap (P2): a caller without `document.send` gets the PTD unsent, audited on the PTD
 *   as `payment.autoSendSkipped` (open for the design owner: a narrow automatic enqueue).
 * - Credit Notes take no payments (documents refuses with Conflict{illegal_transition}); refunds
 *   of an overpaid or credited document are `Payable.refundDue`, not payment rows, in v1.
 *
 * Known contract gaps: none (the domain signatures carry every error the methods yield). db gap:
 * none (the row maps 1:1 onto `payments`).
 */
import { Layer } from "effect";
import { DocumentsTestLayer } from "../documents";
import { PaymentDocumentsLive } from "./documentReads";
import { PaymentFakesLive } from "./fakes";
import { PaymentsRepoMemory } from "./repo";
import { PaymentsLive } from "./service";

export { PaymentDocuments, PaymentDocumentsLive } from "./documentReads";
export type { SeedExpense } from "./fakes";
export { PaymentFakesLive, PaymentFixtures } from "./fakes";
export type { ExpensePayable, ExpenseSettlement } from "./ports";
export { ExpensePayables, PaymentSettings } from "./ports";
export type { RecordResult, ReportPayment } from "./record";
export {
  PaymentRecord,
  PaymentsTable,
  PaymentTargetSchema,
  PaymentViewCodec,
  PaymentViewData,
  RecordPaymentInputSchema,
  RecordResultCodec,
  reportPayment,
  targetOf,
  toView,
} from "./record";
export type { PaymentTargetRef } from "./repo";
export { PaymentsRepo, PaymentsRepoMemory } from "./repo";
export type { PaymentsDeps } from "./service";
export { listFor, PaymentsLive, record, remove } from "./service";

/**
 * `Payments` on the memory repo and the port fakes (whose recording `DocumentSender` replaces
 * documents' stub), over `DocumentsTestLayer`. Requires `InMemoryPortsLive`.
 */
export const PaymentsTestLayer = PaymentsLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PaymentDocumentsLive.pipe(Layer.provide(DocumentsTestLayer)),
      DocumentsTestLayer,
      PaymentsRepoMemory,
      PaymentFakesLive,
    ),
  ),
);
