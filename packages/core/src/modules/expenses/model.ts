/**
 * Expense model (core-ports 4.7): the concrete fields the domain leaves open in `ExpenseInput`,
 * `ExpenseView` and `ExpenseSummary`, the stored rows, and the pure rules (required fields,
 * VAT arithmetic, FX, deductibility, settlement).
 *
 * Open fields cross the domain tag in their JSON form (BigDecimal as string), because the domain
 * schemas declare them `Unknown` and HttpApi passes them through undecoded. `decodeFields`
 * decodes that form; `encodeView` / `encodeSummary` encode back to it.
 *
 * Tax scope (the spec fixes none of this; ce-expenses decisions, reported as gaps):
 * - Deductibility: "full" (default), "none" or `{ partial: 1..99 }` percent of the input VAT
 *   (supplier VAT plus self-assessed VAT), rounded once per Expense. The Tax Regime exclusion
 *   (non_vat_payer claims nothing) is applied by Reports, which knows the regime on the date.
 * - Self-assessment: lines with treatment `reverse_charge` (§92a, §108(1)(c) services) or
 *   `exempt_intra_eu_goods` (§25 acquisition of goods) carry the VAT the recipient self-assesses,
 *   at `selfAssessed` ("standard" by default) in force on the tax point, rounded once per
 *   (treatment, rate) bucket (#377). The supplier's own buckets stay at VAT 0 for these.
 * - Payment rounding of cash receipts is not modelled; the supplier's gross is taken as entered.
 * - Validation issues use `request.malformed` + `params.reason`: the frozen IssueCode union has
 *   no expense codes (domain gap, same exception as core-identity, board #430).
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
import { BigDecimal, Effect, type Result, Schema, SchemaIssue } from "effect";
import { divideRound, HUNDRED, roundAt, sumAll, ZERO } from "../../engines/decimal";
import type { FxRate } from "../../engines/fx";
import { Fx } from "../../engines/fx";
import { TREATMENTS, VAT_RATE_TABLE, VatMath } from "../../engines/vat";

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

/** The rate a self-assessed line (reverse charge, intra-EU acquisition) is taxed at. */
export const SelfAssessedTreatment = Schema.Literals(["standard", "reduced"]);
export type SelfAssessedTreatment = typeof SelfAssessedTreatment.Type;

/** One line of the received document's VAT breakdown, as the supplier printed it. */
export const VatLineInput = Schema.Struct({
  treatment: VatTreatment,
  base: Schema.BigDecimal,
  /** Supplier VAT. Must be 0 for non-rated treatments (reverse charge included). */
  vat: Schema.optional(Schema.BigDecimal),
  /** reverse_charge and exempt_intra_eu_goods only (self-assessed by the recipient); default "standard". */
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
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

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

const toSegment = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
};

/**
 * Decodes the open part of an `ExpenseInput` / `ExpensePatch` strictly: unknown keys and wrong
 * shapes are `request.malformed`, one issue per failing path.
 */
export const decodeFields = (input: unknown): Effect.Effect<ExpenseFields, Invalid> =>
  Schema.decodeUnknownEffect(ExpenseFieldsJson)(input, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.mapError((error) => {
      const seen = new Set<string>();
      const issues: Array<Issue> = [];
      for (const i of formatIssues(error.issue).issues) {
        const path = (i.path ?? []).map(toSegment);
        const key = JSON.stringify(path);
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(issue("request.malformed", path));
      }
      const [first, ...rest] = issues;
      return new Invalid({ issues: [first ?? issue("request.malformed", []), ...rest] });
    }),
  );

/** Plain JSON data (what the wire delivers); anything else in an open field is malformed. */
export const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    return (
      (proto === Object.prototype || proto === null) && Object.values(value).every(isJsonValue)
    );
  }
  return false;
};

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
  /** reverse_charge and exempt_intra_eu_goods buckets as the recipient self-assesses them. */
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
    issues.push(
      issue("request.malformed", [row.taxableSupplyOn === null ? "issuedOn" : "taxableSupplyOn"], {
        reason: "before_vat_table",
      }),
    );
    return issues;
  }
  lines.forEach((line, i) => {
    if (scaleOf(line.base) > scale) tooPrecise(["vat", i, "base"]);
    if (scaleOf(line.vat) > scale) tooPrecise(["vat", i, "vat"]);
    const rated = BigDecimal.isPositive(VatMath.rateFor(line.treatment, taxPoint));
    if (!rated && !BigDecimal.isZero(line.vat)) {
      issues.push(issue("request.malformed", ["vat", i, "vat"], { reason: "vat_not_allowed" }));
    }
    if (line.selfAssessed !== null && !SELF_ASSESSED.has(line.treatment)) {
      issues.push(
        issue("request.malformed", ["vat", i, "selfAssessed"], {
          reason: "self_assessment_not_allowed",
        }),
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

/** Treatments whose recipient self-assesses the VAT. */
const SELF_ASSESSED: ReadonlySet<VatTreatment> = new Set([
  "reverse_charge",
  "exempt_intra_eu_goods",
]);

const byTreatment = <A>(entries: ReadonlyArray<readonly [VatTreatment, A]>) =>
  [...entries].sort((a, b) => TREATMENTS.indexOf(a[0]) - TREATMENTS.indexOf(b[0]));

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
  return byTreatment([...groups]).map(([treatment, g]) => ({
    treatment,
    ratePercent: VatMath.rateFor(treatment, taxPoint),
    base: BigDecimal.normalize(g.base),
    vat: BigDecimal.normalize(g.vat),
    gross: BigDecimal.normalize(BigDecimal.sum(g.base, g.vat)),
    vatCzk: foreign ? czkOf(g.vat, fx) : null,
  }));
};

/** Self-assessment: VAT the recipient computes on the base, rounded once per bucket (#377). */
const selfAssessedBuckets = (
  lines: ReadonlyArray<StoredVatLine>,
  taxPoint: IsoDate,
  fx: FxRate | null,
): ReadonlyArray<VatBucket> => {
  const groups = new Map<
    string,
    { treatment: VatTreatment; as: SelfAssessedTreatment; base: BigDecimal.BigDecimal }
  >();
  for (const line of lines) {
    if (!SELF_ASSESSED.has(line.treatment)) continue;
    const as = line.selfAssessed ?? "standard";
    const key = `${line.treatment}/${as}`;
    const g = groups.get(key) ?? { treatment: line.treatment, as, base: ZERO };
    groups.set(key, { ...g, base: BigDecimal.sum(g.base, line.base) });
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      TREATMENTS.indexOf(a.treatment) - TREATMENTS.indexOf(b.treatment) ||
      (a.as === b.as ? 0 : a.as === "standard" ? -1 : 1),
  );
  return ordered.map(({ treatment, as, base }) => {
    const ratePercent = VatMath.rateFor(as, taxPoint);
    const vat = divideRound(BigDecimal.multiply(base, ratePercent), HUNDRED, 2);
    return {
      treatment,
      ratePercent,
      base: BigDecimal.normalize(base),
      vat,
      gross: BigDecimal.normalize(BigDecimal.sum(base, vat)),
      vatCzk: fx === null ? null : czkOf(vat, fx),
    };
  });
};

/**
 * The Expense's rate: null for CZK, else the CNB fixing for the tax point (`fixing`, fetched with
 * `ExchangeRates.fixing(taxPoint)`); a currency CNB does not quote is `Invalid{fx.rate_missing}`.
 * Manual rates are not offered for Expenses (core-ports 4.7 stores the CNB fixing).
 */
export const resolveFx = (
  row: ExpenseRow,
  fixing: CnbFixing | null,
): Result.Result<FxRate | null, Invalid> =>
  Fx.resolve({ currency: row.currency as CurrencyCode, override: null, fixing });

/** Derived figures of a valid complete Expense at rate `fx` (null for CZK). */
export const computeFigures = (row: ExpenseRow, fx: FxRate | null): ExpenseFigures => {
  const currency = row.currency as CurrencyCode;
  const total = row.total as BigDecimal.BigDecimal;
  const taxPoint = taxPointOf(row) as IsoDate;
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
  return {
    taxPoint,
    totals,
    selfAssessed,
    fx,
    totalCzk: roundAt(czkOf(total, fx), 2),
    deductibleVat: share(claimable),
    deductibleVatCzk: share(claimableCzk),
  };
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
  /** As entered; shown even before a currency is chosen (incomplete). */
  total: Schema.NullOr(Schema.BigDecimal),
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
  /** As entered; shown even before a currency is chosen (incomplete). */
  total: Schema.NullOr(Schema.BigDecimal),
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
  total: row.total,
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
  total: row.total,
  category: row.category,
  tags: row.tags,
  attachments,
  settlement: settlementOf(row),
});

/** JSON encoders for the open domain views (the domain schemas carry these fields as Unknown). */
export const encodeView = Schema.encodeSync(Schema.toCodecJson(ExpenseViewFields));
export const encodeSummary = Schema.encodeSync(Schema.toCodecJson(ExpenseSummaryFields));
/** `attach`'s result: the attachment plus the Expense revision after it (attach bumps it). */
export const AttachResultFields = Schema.Struct({
  ...AttachmentViewFields.fields,
  expenseRevision: Schema.Int,
});
export type AttachResultFields = typeof AttachResultFields.Type;
export const encodeAttachment = Schema.encodeSync(Schema.toCodecJson(AttachResultFields));
/** Decoders for tests and in-process callers that read the open views back. */
export const decodeView = Schema.decodeUnknownSync(Schema.toCodecJson(ExpenseViewFields));
export const decodeSummary = Schema.decodeUnknownSync(Schema.toCodecJson(ExpenseSummaryFields));

export type { VatBreakdown };
