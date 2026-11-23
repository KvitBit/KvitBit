/**
 * `ExpenseRecords`: the read seam Reports uses (board #397/#401/#404, agreement=current).
 * Read-only, no authorize or audit, called inside the caller's transaction. Removed Expenses
 * and other Workspaces' rows are never returned; incomplete Expenses are left out and counted.
 */
import type {
  ContactId,
  CurrencyCode,
  ExpenseId,
  IsoDate,
  VatBreakdown,
  VatBucket,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { BigDecimal } from "effect";
import { Context, Effect, Layer } from "effect";
import type { FxRate } from "../../engines/fx";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { ExpenseRow } from "./model";
import { ExpensesRepo } from "./repo";

export interface ExpenseRecord {
  readonly id: ExpenseId;
  readonly supplierDocumentNumber: string | null;
  readonly supplier: {
    readonly contactId: ContactId | null;
    readonly name: string | null;
    readonly ico: string | null;
    readonly dic: string | null;
  } | null;
  readonly category: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly issuedOn: IsoDate;
  /** taxableSupplyOn ?? issuedOn. */
  readonly taxPoint: IsoDate;
  readonly currency: CurrencyCode;
  /** Supplier figures; reverse_charge buckets at vat 0; a receipt with no VAT lines is one outside_scope bucket. */
  readonly totals: VatBreakdown;
  /** reverse_charge buckets as the recipient self-assesses them. */
  readonly selfAssessed: ReadonlyArray<VatBucket>;
  readonly fx: FxRate | null;
  /** 0..100 share of input VAT the Workspace may claim. */
  readonly deductiblePercent: number;
  readonly deductibleVat: BigDecimal.BigDecimal;
  readonly deductibleVatCzk: BigDecimal.BigDecimal;
  readonly paid: BigDecimal.BigDecimal;
  readonly payments: number;
}

export interface ExpenseRange {
  readonly field: "issuedOn" | "taxPoint";
  /** Inclusive. */
  readonly from: IsoDate;
  /** Inclusive. */
  readonly to: IsoDate;
}

export class ExpenseRecords extends Context.Service<
  ExpenseRecords,
  {
    readonly complete: (
      workspaceId: WorkspaceId,
      range: ExpenseRange,
    ) => Effect.Effect<ReadonlyArray<ExpenseRecord>, StoreUnavailable>;
    readonly incompleteCount: (workspaceId: WorkspaceId) => Effect.Effect<number, StoreUnavailable>;
  }
>()("kvitbit/core/ExpenseRecords") {}

/** A complete row's record; null for a row without figures (incomplete). */
export const toRecord = (row: ExpenseRow): ExpenseRecord | null => {
  const f = row.figures;
  if (f === null || row.issuedOn === null || row.currency === null) return null;
  return {
    id: row.id,
    supplierDocumentNumber: row.supplierDocumentNumber,
    supplier: row.supplier,
    category: row.category,
    tags: row.tags,
    issuedOn: row.issuedOn,
    taxPoint: f.taxPoint,
    currency: row.currency,
    totals: f.totals,
    selfAssessed: f.selfAssessed,
    fx: f.fx,
    deductiblePercent: row.deductiblePercent,
    deductibleVat: f.deductibleVat,
    deductibleVatCzk: f.deductibleVatCzk,
    paid: row.paid,
    payments: row.payments,
  };
};

export const ExpenseRecordsLive: Layer.Layer<ExpenseRecords, never, ExpensesRepo> = Layer.effect(
  ExpenseRecords,
  Effect.map(ExpensesRepo, (repo) => ({
    complete: (workspaceId, range) =>
      Effect.map(repo.completeIn(workspaceId, range), (rows) =>
        rows.flatMap((row) => {
          const record = toRecord(row);
          return record === null ? [] : [record];
        }),
      ),
    incompleteCount: (workspaceId) => repo.countIncomplete(workspaceId),
  })),
);
