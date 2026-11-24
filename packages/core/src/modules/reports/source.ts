/**
 * `ReportsSource`: the read seam Reports runs on (board #397 documents/payments, #400/#401
 * expenses). Integration provides it from the documents, payments and expenses repositories.
 * Every operation is read-only, Workspace-scoped (another Workspace's rows are never returned),
 * runs inside the caller's `CoreStore.transaction`, and fails only with `StoreUnavailable`.
 */
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  ExpenseId,
  IsoDate,
  Money,
  PaymentId,
  TaxRegime,
  VatBreakdown,
  VatBucket,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { BigDecimal } from "effect";
import { Context, Effect, Layer, Ref } from "effect";
import { StoreUnavailable } from "../../store/CoreStore";

/** A stored CNB (or manual) fixing: `amount × rate / quantity` is CZK. */
export interface StoredFx {
  readonly rate: BigDecimal.BigDecimal;
  readonly quantity: number;
}

/** An issued or cancelled document (never a draft) as Reports needs it. */
export interface ReportDocument {
  readonly id: DocumentId;
  readonly workspaceId: WorkspaceId;
  readonly kind: DocumentKind;
  /** An Invoice that settles a Proforma (rule D8). */
  readonly finalInvoice: boolean;
  /** Credit Notes: the kind of the corrected document; null otherwise. */
  readonly correctsKind: DocumentKind | null;
  readonly status: "issued" | "cancelled";
  readonly number: string | null;
  readonly contact: { readonly id: ContactId | null; readonly name: string };
  readonly currency: CurrencyCode;
  readonly issuedOn: IsoDate;
  /** DUZP; null for a Proforma (not a tax document). */
  readonly taxPoint: IsoDate | null;
  readonly dueOn: IsoDate | null;
  /**
   * Signed as stored: Credit Notes are negative (`VatMath.negate` convention). A Final Invoice
   * (and a Credit Note correcting one) carries the FULL supply, before advance deductions.
   */
  readonly totals: VatBreakdown;
  /** The fixing stored on the document; null for CZK. */
  readonly fx: StoredFx | null;
  /**
   * Advance (Payment Tax Document) buckets the document deducts, in its own currency: positive
   * on a Final Invoice, negative on a Credit Note reversing one; empty otherwise (#397, #477).
   * A deduction of Proforma cash no PTD covers is not one (it was never taxed as an advance).
   */
  readonly advanceDeductions: ReadonlyArray<VatBucket>;
  readonly settlement: DocumentSettlement;
  /** What the buyer still owes, in the document currency, >= 0. */
  readonly outstanding: BigDecimal.BigDecimal;
}

export interface ReportPayment {
  readonly id: PaymentId;
  readonly workspaceId: WorkspaceId;
  /** `in`: a payment of a document; `out`: a payment of an Expense. */
  readonly direction: "in" | "out";
  readonly target: { readonly document: DocumentId } | { readonly expense: ExpenseId };
  readonly paidOn: IsoDate;
  readonly amount: Money;
  /** The target's stored fixing (reports never use today's rate); null for CZK. */
  readonly fx: StoredFx | null;
}

/** A complete Expense (ce-expenses `ExpenseRecord`, board #400). */
export interface ReportExpense {
  readonly id: ExpenseId;
  readonly workspaceId: WorkspaceId;
  readonly supplierDocumentNumber: string | null;
  readonly supplier: { readonly contactId: ContactId | null; readonly name: string | null } | null;
  readonly category: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly issuedOn: IsoDate;
  /** taxableSupplyOn ?? issuedOn. */
  readonly taxPoint: IsoDate;
  readonly currency: CurrencyCode;
  /** Supplier figures as entered; reverse-charge buckets carry vat 0. */
  readonly totals: VatBreakdown;
  /** Reverse charge only: the VAT the recipient self-assesses (output and input VAT). */
  readonly selfAssessed: ReadonlyArray<VatBucket>;
  readonly fx: StoredFx | null;
  /** Share of the input VAT the Workspace may deduct, 0..100. */
  readonly deductiblePercent: number;
}

export interface DateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export interface ReportsSourceShape {
  /** Issued and cancelled documents whose `field` lies in the range (inclusive). */
  readonly documents: (
    workspaceId: WorkspaceId,
    range: DateRange & { readonly field: "issuedOn" | "taxPoint" },
  ) => Effect.Effect<ReadonlyArray<ReportDocument>, StoreUnavailable>;
  /** Documents a buyer still owes on (`outstanding > 0`). */
  readonly openReceivables: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<ReportDocument>, StoreUnavailable>;
  /** Live (not removed) payments, both directions, `paidOn` in the range. */
  readonly payments: (
    workspaceId: WorkspaceId,
    range: DateRange,
  ) => Effect.Effect<ReadonlyArray<ReportPayment>, StoreUnavailable>;
  /** Complete Expenses whose `field` lies in the range (inclusive). */
  readonly expenses: (
    workspaceId: WorkspaceId,
    range: DateRange & { readonly field: "issuedOn" | "taxPoint" },
  ) => Effect.Effect<ReadonlyArray<ReportExpense>, StoreUnavailable>;
  readonly incompleteExpenses: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<number, StoreUnavailable>;
  /**
   * The Workspace's Tax Regime history in stored order; the regime on a date is the latest
   * `effectiveFrom <= date`, the last in stored order on a tie. `[]` for an unknown Workspace
   * (total over Workspace ids like every read here; Reports asks only after authorizing it).
   */
  readonly taxRegimes: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<TaxRegimePeriod>, StoreUnavailable>;
}

export interface TaxRegimePeriod {
  readonly effectiveFrom: IsoDate;
  readonly regime: TaxRegime;
}

export class ReportsSource extends Context.Service<ReportsSource, ReportsSourceShape>()(
  "kvitbit/core/ReportsSource",
) {}

// In-memory fake ------------------------------------------------------------------------------

export interface ReportsSourceData {
  readonly documents: ReadonlyArray<ReportDocument>;
  readonly payments: ReadonlyArray<ReportPayment>;
  readonly expenses: ReadonlyArray<ReportExpense>;
  readonly incompleteExpenses: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly id: ExpenseId;
  }>;
  readonly taxRegimes: ReadonlyArray<TaxRegimePeriod & { readonly workspaceId: WorkspaceId }>;
}

const EMPTY: ReportsSourceData = {
  documents: [],
  payments: [],
  expenses: [],
  incompleteExpenses: [],
  taxRegimes: [],
};

const inRange = (date: IsoDate | null, range: DateRange) =>
  date !== null && range.from <= date && date <= range.to;

/** Test control of `ReportsSourceMemory`: the rows it serves (any order) and an outage flag. */
export class ReportsSourceFake extends Context.Service<
  ReportsSourceFake,
  {
    readonly data: Ref.Ref<ReportsSourceData>;
    readonly unavailable: Ref.Ref<boolean>;
    /** Adds rows to what is served. */
    readonly seed: (rows: Partial<ReportsSourceData>) => Effect.Effect<void>;
  }
>()("kvitbit/core/testing/ReportsSourceFake") {}

const makeFake = Effect.gen(function* () {
  const data = yield* Ref.make(EMPTY);
  const unavailable = yield* Ref.make(false);
  return {
    data,
    unavailable,
    seed: (rows: Partial<ReportsSourceData>) =>
      Ref.update(data, (d) => ({
        documents: [...d.documents, ...(rows.documents ?? [])],
        payments: [...d.payments, ...(rows.payments ?? [])],
        expenses: [...d.expenses, ...(rows.expenses ?? [])],
        incompleteExpenses: [...d.incompleteExpenses, ...(rows.incompleteExpenses ?? [])],
        taxRegimes: [...d.taxRegimes, ...(rows.taxRegimes ?? [])],
      })),
  };
});

/** In-memory `ReportsSource` serving the rows seeded through `ReportsSourceFake`. */
export const ReportsSourceMemory: Layer.Layer<ReportsSource | ReportsSourceFake> = Layer.effect(
  ReportsSource,
  Effect.map(ReportsSourceFake, (fake): ReportsSourceShape => {
    const read = <A>(f: (d: ReportsSourceData) => A) =>
      Effect.gen(function* () {
        if (yield* Ref.get(fake.unavailable)) {
          return yield* new StoreUnavailable({});
        }
        return f(yield* Ref.get(fake.data));
      });
    return {
      documents: (workspaceId, range) =>
        read((d) =>
          d.documents.filter(
            (row) => row.workspaceId === workspaceId && inRange(row[range.field], range),
          ),
        ),
      openReceivables: (workspaceId) =>
        read((d) =>
          d.documents.filter(
            (row) =>
              row.workspaceId === workspaceId &&
              row.status === "issued" &&
              row.outstanding.value > 0n,
          ),
        ),
      payments: (workspaceId, range) =>
        read((d) =>
          d.payments.filter((row) => row.workspaceId === workspaceId && inRange(row.paidOn, range)),
        ),
      expenses: (workspaceId, range) =>
        read((d) =>
          d.expenses.filter(
            (row) => row.workspaceId === workspaceId && inRange(row[range.field], range),
          ),
        ),
      incompleteExpenses: (workspaceId) =>
        read((d) => d.incompleteExpenses.filter((row) => row.workspaceId === workspaceId).length),
      taxRegimes: (workspaceId) =>
        read((d) =>
          d.taxRegimes
            .filter((row) => row.workspaceId === workspaceId)
            .map(({ effectiveFrom, regime }) => ({ effectiveFrom, regime })),
        ),
    };
  }),
).pipe(Layer.provideMerge(Layer.effect(ReportsSourceFake, makeFake)));
