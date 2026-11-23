/**
 * Expenses module (core-ports 4.7): `ExpensesLive` implements the domain `Expenses` tag;
 * `ExpensePayables` is the seam Payments uses (board #395); `ExpenseRecords` is the read seam
 * Reports uses (board #404); `ExpenseSuppliers` is the narrow Contacts port the integration
 * implements on the domain `Contacts` tag.
 */
import { Layer } from "effect";
import { ExpensePayablesLive } from "./payables";
import { ExpenseRecordsLive } from "./records";
import { ExpensesRepoMemory } from "./repo";
import { ExpensesLive } from "./service";
import { FakeExpenseSuppliers } from "./suppliers";

export type {
  AttachmentViewFields,
  AttachResultFields,
  Deductibility,
  ExpenseFields,
  ExpenseFigures,
  ExpenseSettlement,
  ExpenseSummaryFields,
  ExpenseViewFields,
  SupplierRecord,
  SupplierRef,
} from "./model";
export {
  AttachmentRow,
  decodeSummary,
  decodeView,
  ExpenseRow,
  settlementOf,
} from "./model";
export type { PaidState, Payable } from "./payables";
export { ExpensePayables, ExpensePayablesLive } from "./payables";
export type { ExpenseRange, ExpenseRecord } from "./records";
export { ExpenseRecords, ExpenseRecordsLive } from "./records";
export type { ExpensePageRequest } from "./repo";
export {
  ATTACHMENT_SHA_UNIQUE,
  AttachmentsTable,
  ExpensesRepo,
  ExpensesRepoMemory,
  ExpensesTable,
} from "./repo";
export type { ExpensesImpl, ExpensesOptions } from "./service";
export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  attachmentKey,
  ExpensesLive,
  makeExpenses,
  makeExpensesLive,
} from "./service";
export { matchesType, SNIFFABLE_TYPES } from "./sniff";
export type { FakeSupplier } from "./suppliers";
export { ExpenseSuppliers, FakeExpenseSuppliers, FakeSupplierDirectory } from "./suppliers";

/**
 * `Expenses`, `ExpensePayables` and `ExpenseRecords` on the in-memory repo and the fake
 * supplier port (with its `FakeSupplierDirectory` control); needs `InMemoryPortsLive`.
 */
export const ExpensesTestLayer = Layer.mergeAll(
  ExpensesLive,
  ExpensePayablesLive,
  ExpenseRecordsLive,
).pipe(Layer.provideMerge(FakeExpenseSuppliers), Layer.provideMerge(ExpensesRepoMemory));
