/**
 * Expense model (core-ports 4.7): the concrete fields the domain leaves open in `ExpenseInput`,
 * `ExpenseView` and `ExpenseSummary`, the stored rows, and the pure rules (required fields,
 * VAT arithmetic, FX, deductibility, settlement).
 *
 * Open fields cross the domain tag in their JSON form (BigDecimal as string), because the domain
 * schemas declare them `Unknown` and HttpApi passes them through undecoded. `decodeFields`
 * decodes that form; `toView` / `toSummary` encode back to it.
 */
import type { Issue, IssueCode, VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import {
  AttachmentId,
  ContactId,
  CurrencyCode,
  ExpenseId,
  ExpenseStatus,
  Invalid,
  IsoDate,
  Money,
  MoneyMath,
  VatBreakdown as VatBreakdownSchema,
  VatBucket as VatBucketSchema,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Result, Schema } from "effect";
import { divideRound, HUNDRED, roundAt, sumAll, ZERO } from "../../engines/decimal";
import type { FxRate } from "../../engines/fx";
import { Fx } from "../../engines/fx";
import { VAT_RATE_TABLE, VatMath } from "../../engines/vat";

const CZK = "CZK" as CurrencyCode;

// Input --------------------------------------------------------------------------------------

/** Supplier: a saved Contact, an IČO resolved to a supplier Contact, or typed by hand. */
export const SupplierRef = Schema.Union([
  Schema.Struct({ contact: ContactId }),
  Schema.Struct({ ico: Schema.String }),
  Schema.Struct({
    manual: Schema.Struct({
      name: Schema.String,
      ico: Schema.optional(Schema.NullOr(Schema.String)),
      dic: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
]);
export type SupplierRef = typeof SupplierRef.Type;

/** The VAT treatment a reverse-charge line is self-assessed at (§108(1)(c)). */
export const SelfAssessedTreatment = Schema.Literals(["standard", "reduced"]);
export type SelfAssessedTreatment = typeof SelfAssessedTreatment.Type;

/** One line of the received document's VAT breakdown, as the supplier printed it. */
export const VatLineInput = Schema.Struct({
  treatment: VatTreatment,
  base: Schema.BigDecimal,
  /** Supplier VAT. Must be 0 for non-rated treatments (reverse charge included). */
  vat: Schema.optional(Schema.BigDecimal),
  /** reverse_charge only; default "standard". */
  selfAssessed: Schema.optional(SelfAssessedTreatment),
});
export type VatLineInput = typeof VatLineInput.Type;

/** Input VAT deductibility: full, none, or a partial percentage (coefficient, §76). */
export const Deductibility = Schema.Union([
  Schema.Literals(["full", "none"]),
  Schema.Struct({
    partial: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 99 }))),
  }),
]);
export type Deductibility = typeof Deductibility.Type;

const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/** The concrete `ExpenseInput` / `ExpensePatch` fields. Every field is optional on the wire. */
export const ExpenseFields = Schema.Struct({
  status: Schema.optional(ExpenseStatus),
  supplier: optionalNullable(SupplierRef),
  supplierDocumentNumber: optionalNullable(Schema.String),
  issuedOn: optionalNullable(IsoDate),
  taxableSupplyOn: optionalNullable(IsoDate),
  dueOn: optionalNullable(IsoDate),
  currency: optionalNullable(CurrencyCode),
  /** Gross amount of the received document in `currency`. */
  total: optionalNullable(Schema.BigDecimal),
  /** Absent or null: a receipt with a single total and no VAT lines. */
  vat: optionalNullable(Schema.Array(VatLineInput)),
  deductibility: Schema.optional(Deductibility),
  category: optionalNullable(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  note: optionalNullable(Schema.String),
});
export type ExpenseFields = typeof ExpenseFields.Type;

const ExpenseFieldsJson = Schema.toCodecJson(ExpenseFields);

export const invalid = (
  code: IssueCode,
  path: ReadonlyArray<string | number>,
  params?: Record<string, string>,
): Invalid => new Invalid({ issues: [issue(code, path, params)] });

const issue = (
  code: IssueCode,
  path: ReadonlyArray<string | number>,
  params?: Record<string, string>,
): Issue => ({ path: [...path], code, ...(params ? { params } : {}) });

/** Decodes the open part of an `ExpenseInput` / `ExpensePatch`; wrong shapes are `request.malformed`. */
export const decodeFields = (input: unknown): Effect.Effect<ExpenseFields, Invalid> =>
  Schema.decodeUnknownEffect(ExpenseFieldsJson)(input).pipe(
    Effect.mapError(() => invalid("request.malformed", [])),
  );

// Rows ---------------------------------------------------------------------------------------

export const SupplierRecord = Schema.Struct({
  contactId: Schema.NullOr(ContactId),
  name: Schema.NullOr(Schema.String),
  ico: Schema.NullOr(Schema.String),
  dic: Schema.NullOr(Schema.String),
});
export type SupplierRecord = typeof SupplierRecord.Type;

export const StoredVatLine = Schema.Struct({
  treatment: VatTreatment,
  base: Schema.BigDecimal,
  vat: Schema.BigDecimal,
  selfAssessed: Schema.NullOr(SelfAssessedTreatment),
});
export type StoredVatLine = typeof StoredVatLine.Type;

export const StoredFx = Schema.Struct({
  rate: Schema.BigDecimal,
  quantity: Schema.Int,
  fixingDate: Schema.NullOr(IsoDate),
  source: Schema.Literals(["cnb", "manual"]),
});

/** Figures derived when a complete Expense is saved; null while incomplete. */
export const ExpenseFigures = Schema.Struct({
  taxPoint: IsoDate,
  /** Supplier figures, one bucket per (treatment, ratePercent); vatCzk filled for non-CZK. */
  totals: VatBreakdownSchema,
  /** reverse_charge buckets as the recipient self-assesses them. */
  selfAssessed: Schema.Array(VatBucketSchema),
  fx: Schema.NullOr(StoredFx),
  totalCzk: Schema.BigDecimal,
  deductibleVat: Schema.BigDecimal,
  deductibleVatCzk: Schema.BigDecimal,
});
export type ExpenseFigures = typeof ExpenseFigures.Type;

export const ExpenseRow = Schema.Struct({
  id: ExpenseId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
  status: ExpenseStatus,
  supplier: Schema.NullOr(SupplierRecord),
  supplierDocumentNumber: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(IsoDate),
  taxableSupplyOn: Schema.NullOr(IsoDate),
  dueOn: Schema.NullOr(IsoDate),
  currency: Schema.NullOr(CurrencyCode),
  total: Schema.NullOr(Schema.BigDecimal),
  vatLines: Schema.NullOr(Schema.Array(StoredVatLine)),
  deductiblePercent: Schema.Int,
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
  figures: Schema.NullOr(ExpenseFigures),
  /** Sum of live Payments in `currency`, kept by `ExpensePayables.settle`. */
  paid: Schema.BigDecimal,
  payments: Schema.Int,
  /** Soft removal: a removed Expense is NotFound everywhere. */
  removedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ExpenseRow = typeof ExpenseRow.Type;

export const AttachmentRow = Schema.Struct({
  id: AttachmentId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
  expenseId: ExpenseId,
  blobKey: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  createdAt: Schema.String,
});
export type AttachmentRow = typeof AttachmentRow.Type;

// Rules --------------------------------------------------------------------------------------

export const percentOf = (d: Deductibility): number =>
  d === "full" ? 100 : d === "none" ? 0 : d.partial;

export const deductibilityOf = (percent: number): Deductibility =>
  percent === 100 ? "full" : percent === 0 ? "none" : { partial: percent };

/** The Expense's tax point: taxable supply date, else issue date. */
export const taxPointOf = (row: Pick<ExpenseRow, "issuedOn" | "taxableSupplyOn">) =>
  row.taxableSupplyOn ?? row.issuedOn;

const scaleOf = (value: BigDecimal.BigDecimal) => BigDecimal.normalize(value).scale;

/**
 * Required fields and arithmetic of a complete Expense. Returns every issue at once; the
 * supplier's figures are checked, never recalculated (core-ports 4.7).
 */
export const validateComplete = (row: ExpenseRow): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = [];
  const required = (path: string) =>
    issues.push(issue("request.malformed", [path], { reason: "required" }));
  if (row.issuedOn === null) required("issuedOn");
  if (row.currency === null) required("currency");
  if (row.total === null) required("total");
  if (row.currency === null || row.total === null || row.issuedOn === null) return issues;

  const scale = MoneyMath.minorUnitScale(row.currency);
  const tooPrecise = (path: ReadonlyArray<string | number>) =>
    issues.push(issue("request.malformed", path, { reason: "precision", scale: String(scale) }));
  if (scaleOf(row.total) > scale) tooPrecise(["total"]);

  const taxPoint = taxPointOf(row) as IsoDate;
  const lines = row.vatLines ?? [];
  if (lines.length > 0 && taxPoint < (VAT_RATE_TABLE[0]?.from ?? taxPoint)) {
    issues.push(issue("request.malformed", ["taxableSupplyOn"], { reason: "before_vat_table" }));
    return issues;
  }
  lines.forEach((line, i) => {
    if (scaleOf(line.base) > scale) tooPrecise(["vat", i, "base"]);
    if (scaleOf(line.vat) > scale) tooPrecise(["vat", i, "vat"]);
    const rated = BigDecimal.isPositive(VatMath.rateFor(line.treatment, taxPoint));
    if (!rated && !BigDecimal.isZero(line.vat)) {
      issues.push(issue("request.malformed", ["vat", i, "vat"], { reason: "vat_not_allowed" }));
    }
    if (line.selfAssessed !== null && line.treatment !== "reverse_charge") {
      issues.push(
        issue("request.malformed", ["vat", i, "selfAssessed"], { reason: "reverse_charge_only" }),
      );
    }
  });
  if (lines.length > 0) {
    const gross = sumAll(lines.map((l) => BigDecimal.sum(l.base, l.vat)));
    if (!BigDecimal.equals(gross, row.total)) {
      issues.push(
        issue("request.malformed", ["vat"], {
          reason: "vat_total_mismatch",
          expected: BigDecimal.format(BigDecimal.normalize(row.total)),
          actual: BigDecimal.format(BigDecimal.normalize(gross)),
        }),
      );
    }
  }
  return issues;
};

const czkOf = (amount: BigDecimal.BigDecimal, fx: FxRate | null) =>
  fx === null ? amount : Fx.toCzk(amount, fx);

/** The buckets of the supplier's lines: one per treatment (one rate per tax point), summed as entered. */
const supplierBuckets = (
  lines: ReadonlyArray<StoredVatLine>,
  total: BigDecimal.BigDecimal,
  taxPoint: IsoDate,
  fx: FxRate | null,
): ReadonlyArray<VatBucket> => {
  const foreign = fx !== null;
  if (lines.length === 0) {
    return [
      {
        treatment: "outside_scope",
        ratePercent: ZERO,
        base: total,
        vat: ZERO,
        gross: total,
        vatCzk: foreign ? ZERO : null,
      },
    ];
  }
  const groups = new Map<
    VatTreatment,
    { base: BigDecimal.BigDecimal; vat: BigDecimal.BigDecimal }
  >();
  for (const line of lines) {
    const g = groups.get(line.treatment) ?? { base: ZERO, vat: ZERO };
    groups.set(line.treatment, {
      base: BigDecimal.sum(g.base, line.base),
      vat: BigDecimal.sum(g.vat, line.vat),
    });
  }
  return [...groups].map(([treatment, g]) => ({
    treatment,
    ratePercent: VatMath.rateFor(treatment, taxPoint),
    base: BigDecimal.normalize(g.base),
    vat: BigDecimal.normalize(g.vat),
    gross: BigDecimal.normalize(BigDecimal.sum(g.base, g.vat)),
    vatCzk: foreign ? czkOf(g.vat, fx) : null,
  }));
};

/** Reverse-charge self-assessment: VAT the recipient computes on the base, rounded once per bucket (#377). */
const selfAssessedBuckets = (
  lines: ReadonlyArray<StoredVatLine>,
  taxPoint: IsoDate,
  fx: FxRate | null,
): ReadonlyArray<VatBucket> => {
  const groups = new Map<SelfAssessedTreatment, BigDecimal.BigDecimal>();
  for (const line of lines) {
    if (line.treatment !== "reverse_charge") continue;
    const as = line.selfAssessed ?? "standard";
    groups.set(as, BigDecimal.sum(groups.get(as) ?? ZERO, line.base));
  }
  return [...groups].map(([as, base]) => {
    const ratePercent = VatMath.rateFor(as, taxPoint);
    const vat = divideRound(BigDecimal.multiply(base, ratePercent), HUNDRED, 2);
    return {
      treatment: "reverse_charge" as const,
      ratePercent,
      base: BigDecimal.normalize(base),
      vat,
      gross: BigDecimal.normalize(BigDecimal.sum(base, vat)),
      vatCzk: fx === null ? null : czkOf(vat, fx),
    };
  });
};

/**
 * Derived figures of a valid complete Expense. `fixing` is the CNB fixing for the tax point
 * (null for CZK); a currency CNB does not quote is `Invalid{fx.rate_missing}`.
 */
export const computeFigures = (
  row: ExpenseRow,
  fixing: CnbFixing | null,
): Result.Result<ExpenseFigures, Invalid> => {
  const currency = row.currency as CurrencyCode;
  const total = row.total as BigDecimal.BigDecimal;
  const taxPoint = taxPointOf(row) as IsoDate;
  const fxResult = Fx.resolve({ currency, override: null, fixing });
  if (Result.isFailure(fxResult)) return Result.fail(fxResult.failure);
  const fx = fxResult.success;
  const lines = row.vatLines ?? [];
  const totals = VatMath.fromBuckets(supplierBuckets(lines, total, taxPoint, fx), currency);
  const selfAssessed = selfAssessedBuckets(lines, taxPoint, fx);
  const claimable = BigDecimal.sum(totals.vat.amount, sumAll(selfAssessed.map((b) => b.vat)));
  const claimableCzk =
    fx === null
      ? claimable
      : BigDecimal.sum(
          sumAll(totals.buckets.map((b) => b.vatCzk ?? ZERO)),
          sumAll(selfAssessed.map((b) => b.vatCzk ?? ZERO)),
        );
  const share = (amount: BigDecimal.BigDecimal) =>
    divideRound(
      BigDecimal.multiply(amount, BigDecimal.fromBigInt(BigInt(row.deductiblePercent))),
      HUNDRED,
      2,
    );
  return Result.succeed({
    taxPoint,
    totals,
    selfAssessed,
    fx,
    totalCzk: roundAt(czkOf(total, fx), 2),
    deductibleVat: share(claimable),
    deductibleVatCzk: share(claimableCzk),
  });
};

/** Whether `computeFigures` needs a CNB fixing. */
export const needsFixing = (row: ExpenseRow) => row.currency !== null && row.currency !== CZK;

export type ExpenseSettlement = "unpaid" | "partially_paid" | "paid" | "overpaid";

/** Settlement derived from the paid sum and the current total (rule P1: never stored). */
export const settlementOf = (row: ExpenseRow): ExpenseSettlement => {
  if (row.payments === 0 || BigDecimal.isZero(row.paid)) return "unpaid";
  if (row.total === null) return "partially_paid";
  if (BigDecimal.isLessThan(row.paid, row.total)) return "partially_paid";
  return BigDecimal.equals(row.paid, row.total) ? "paid" : "overpaid";
};

// Views --------------------------------------------------------------------------------------

export const AttachmentViewFields = Schema.Struct({
  id: AttachmentId,
  expenseId: ExpenseId,
  name: Schema.String,
  contentType: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  createdAt: Schema.String,
});
export type AttachmentViewFields = typeof AttachmentViewFields.Type;

const NullableMoney = Schema.NullOr(Money);

/** The concrete `ExpenseView`. */
export const ExpenseViewFields = Schema.Struct({
  id: ExpenseId,
  revision: Schema.Int,
  status: ExpenseStatus,
  supplier: Schema.NullOr(SupplierRecord),
  supplierDocumentNumber: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(IsoDate),
  taxableSupplyOn: Schema.NullOr(IsoDate),
  dueOn: Schema.NullOr(IsoDate),
  currency: Schema.NullOr(CurrencyCode),
  total: NullableMoney,
  vat: Schema.NullOr(Schema.Array(StoredVatLine)),
  totals: Schema.NullOr(VatBreakdownSchema),
  selfAssessed: Schema.Array(VatBucketSchema),
  fx: Schema.NullOr(StoredFx),
  totalCzk: Schema.NullOr(Schema.BigDecimal),
  deductibility: Deductibility,
  deductibleVat: NullableMoney,
  deductibleVatCzk: Schema.NullOr(Schema.BigDecimal),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
  attachments: Schema.Array(AttachmentViewFields),
  payment: Schema.Struct({
    settlement: Schema.Literals(["unpaid", "partially_paid", "paid", "overpaid"]),
    paid: NullableMoney,
    payments: Schema.Int,
  }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ExpenseViewFields = typeof ExpenseViewFields.Type;

/** The concrete `ExpenseSummary`. */
export const ExpenseSummaryFields = Schema.Struct({
  id: ExpenseId,
  revision: Schema.Int,
  status: ExpenseStatus,
  supplierName: Schema.NullOr(Schema.String),
  supplierDocumentNumber: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(IsoDate),
  total: NullableMoney,
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  attachments: Schema.Int,
  settlement: Schema.Literals(["unpaid", "partially_paid", "paid", "overpaid"]),
});
export type ExpenseSummaryFields = typeof ExpenseSummaryFields.Type;

const money = (amount: BigDecimal.BigDecimal | null, currency: CurrencyCode | null) =>
  amount === null || currency === null
    ? null
    : MoneyMath.make(BigDecimal.normalize(amount), currency);

export const attachmentFields = (a: AttachmentRow): AttachmentViewFields => ({
  id: a.id,
  expenseId: a.expenseId,
  name: a.name,
  contentType: a.contentType,
  bytes: a.bytes,
  sha256: a.sha256,
  createdAt: a.createdAt,
});

export const viewFields = (
  row: ExpenseRow,
  attachments: ReadonlyArray<AttachmentRow>,
): ExpenseViewFields => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  supplier: row.supplier,
  supplierDocumentNumber: row.supplierDocumentNumber,
  issuedOn: row.issuedOn,
  taxableSupplyOn: row.taxableSupplyOn,
  dueOn: row.dueOn,
  currency: row.currency,
  total: money(row.total, row.currency),
  vat: row.vatLines,
  totals: row.figures?.totals ?? null,
  selfAssessed: row.figures?.selfAssessed ?? [],
  fx: row.figures?.fx ?? null,
  totalCzk: row.figures?.totalCzk ?? null,
  deductibility: deductibilityOf(row.deductiblePercent),
  deductibleVat: money(row.figures?.deductibleVat ?? null, row.currency),
  deductibleVatCzk: row.figures?.deductibleVatCzk ?? null,
  category: row.category,
  tags: row.tags,
  note: row.note,
  attachments: attachments.map(attachmentFields),
  payment: {
    settlement: settlementOf(row),
    paid: row.payments === 0 ? null : money(row.paid, row.currency),
    payments: row.payments,
  },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const summaryFields = (row: ExpenseRow, attachments: number): ExpenseSummaryFields => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  supplierName: row.supplier?.name ?? null,
  supplierDocumentNumber: row.supplierDocumentNumber,
  issuedOn: row.issuedOn,
  total: money(row.total, row.currency),
  category: row.category,
  tags: row.tags,
  attachments,
  settlement: settlementOf(row),
});

/** JSON encoders for the open domain views (the domain schemas carry these fields as Unknown). */
export const encodeView = Schema.encodeSync(Schema.toCodecJson(ExpenseViewFields));
export const encodeSummary = Schema.encodeSync(Schema.toCodecJson(ExpenseSummaryFields));
export const encodeAttachment = Schema.encodeSync(Schema.toCodecJson(AttachmentViewFields));
/** Decoders for tests and in-process callers that read the open views back. */
export const decodeView = Schema.decodeUnknownSync(Schema.toCodecJson(ExpenseViewFields));
export const decodeSummary = Schema.decodeUnknownSync(Schema.toCodecJson(ExpenseSummaryFields));

export type { VatBreakdown };
