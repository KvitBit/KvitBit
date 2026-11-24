/**
 * Credit Note issuance (rules D6, D7), shared by `cancel` of a tax document (P2) and
 * `correct` (P3). A Credit Note is built from the corrected document's record, not through
 * `compose`: it prints the original's frozen parties, currency, rates and exchange rate, so no
 * Contact, Workspace or CNB lookup can change what is being corrected.
 *
 * Dates: `issuedOn` = `dueOn` = the day it is issued; `taxableSupplyOn` = the correction date
 * (when the correction takes effect, §42/§45). The VAT treatments, rates and the exchange rate
 * stay the original's: a documented exception to D11's re-fixing, since a correction converts
 * at the corrected supply's rate.
 */
import type {
  DocumentId,
  DocumentSettlement,
  IsoDate,
  LineId,
  NumberingSeriesId,
  VatBreakdown,
  VatBucket,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict } from "@kvitbit/domain/contract";
import { BigDecimal, Effect } from "effect";
import { ZERO } from "../../engines/decimal";
import { Numbering } from "../../engines/numbering";
import { VatMath } from "../../engines/vat";
import { appendAudit } from "../../shared/audit";
import { IdGenerator, newId } from "../../shared/ids";
import { NumberingSeries } from "../numbering";
import { mergeBuckets } from "./compose";
import type { DocumentRecord, LineRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { now } from "./support";

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));
const isZero = (v: BigDecimal.BigDecimal) => BigDecimal.isZero(v);

/** A Credit Note line before it gets its id (the original's treatment and rate, resolved). */
export type CreditLine = Omit<LineRecord, "id">;

/** What a Credit Note credits: its lines and their totals (negative amounts). */
export interface CreditSpec {
  readonly lines: ReadonlyArray<CreditLine>;
  readonly totals: VatBreakdown;
  /** Whether the line prices include VAT (the original's for a negation, else false). */
  readonly pricesIncludeVat: boolean;
}

/** The `variableSymbol` default (core-ports 4.4): the digits of the number, at most 10. */
export const digitsOf = (number: string | null): string | null =>
  number === null ? null : Numbering.variableSymbol(number);

/**
 * The original's buckets minus what its Credit Notes already credited (their buckets are
 * negative), in the original's bucket order. Buckets a Credit Note adds that the original
 * lacks are kept, so an over-credit shows as a negative remainder.
 */
export const remainingBuckets = (
  original: Pick<DocumentRecord, "totals">,
  creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>,
): ReadonlyArray<VatBucket> =>
  mergeBuckets(original.totals.buckets, ...creditNotes.map((c) => c.totals.buckets));

type Credited = Pick<DocumentRecord, "totals"> &
  Partial<Pick<DocumentRecord, "lines" | "currency" | "pricesIncludeVat">>;

const isOpenBucket = (b: VatBucket) =>
  !(isZero(b.base) && isZero(b.vat) && isZero(b.gross) && (b.vatCzk === null || isZero(b.vatCzk)));

/** The summed whole-unit rounding adjustment of the original and its Credit Notes. */
export const roundingLeft = (docs: ReadonlyArray<Pick<DocumentRecord, "totals">>) =>
  BigDecimal.normalize(
    docs.reduce((sum, d) => BigDecimal.sum(sum, d.totals.roundingAdjustment.amount), ZERO),
  );

/**
 * A Final Invoice's deductions (D8) still stand: its deduction buckets plus those its Credit
 * Notes reversed (only a full remainder credit reverses them) are not all zero. Tracked
 * apart from the net buckets, where a supply credit can offset a deduction to zero.
 */
export const deductionsOpen = (original: Credited, creditNotes: ReadonlyArray<Credited>) => {
  if (original.lines === undefined || !original.lines.some((l) => l.deducts !== null)) {
    return false;
  }
  const of = (d: Credited) =>
    d.lines === undefined
      ? []
      : deductionBucketsOf({
          lines: d.lines,
          currency: d.currency ?? original.currency ?? ("CZK" as DocumentRecord["currency"]),
          pricesIncludeVat: d.pricesIncludeVat ?? false,
        });
  return mergeBuckets(of(original), ...creditNotes.map(of)).some(isOpenBucket);
};

/**
 * Nothing of the original is left to credit: every bucket's base, VAT, gross and CZK VAT is
 * zero, so is the summed whole-unit rounding adjustment, and a Final Invoice's deductions are
 * reversed.
 */
export const isFullyCredited = (
  original: Credited,
  creditNotes: ReadonlyArray<Credited>,
): boolean =>
  !remainingBuckets(original, creditNotes).some(isOpenBucket) &&
  isZero(roundingLeft([original, ...creditNotes])) &&
  !deductionsOpen(original, creditNotes);

const sumGross = (docs: ReadonlyArray<Pick<DocumentRecord, "totals">>) =>
  docs.reduce((sum, d) => BigDecimal.sum(sum, d.totals.gross.amount), ZERO);

/**
 * What the buyer still owes before payments: the gross minus what Credit Notes credited
 * (their gross is negative). A Final Invoice's gross is already net of its deductions (D8).
 */
export const owedOf = (
  row: Pick<DocumentRecord, "totals">,
  creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">> = [],
): BigDecimal.BigDecimal =>
  BigDecimal.normalize(BigDecimal.sum(row.totals.gross.amount, sumGross(creditNotes)));

/** The open amount: owed minus paid, never below zero (ReportsSource `outstanding`). */
export const outstandingOf = (
  row: Pick<DocumentRecord, "totals" | "paidAmount" | "kind" | "status" | "links">,
  creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">> = [],
): BigDecimal.BigDecimal => {
  if (row.status !== "issued" || (row.kind !== "invoice" && row.kind !== "proforma")) return ZERO;
  // A Proforma with a Final Invoice is owed through the Final Invoice (D8).
  if (row.links.some((l) => l.relation === "final_invoice_for")) return ZERO;
  const open = BigDecimal.subtract(owedOf(row, creditNotes), row.paidAmount);
  return BigDecimal.isNegative(open) ? ZERO : BigDecimal.normalize(open);
};

/**
 * The stored settlement (core-ports 4.4, P1: from payments and Credit Notes). A Credit Note is
 * never chased (`unpaid`, never overdue); a Payment Tax Document confirms a payment already
 * received (`paid`). Otherwise `credited` once nothing is left to credit (sticky, D6), else
 * the paid total against the owed amount (`owedOf`): nothing paid on a positive amount is
 * `unpaid`, less `partially_paid`, equal `paid`, more `overpaid` (a Final Invoice covered by
 * its advances is `paid` with no payments of its own).
 */
export const settlementOf = (
  row: Pick<DocumentRecord, "kind" | "settlement" | "payments" | "paidAmount" | "totals"> &
    Partial<Pick<DocumentRecord, "lines" | "currency" | "pricesIncludeVat">>,
  creditNotes: ReadonlyArray<Credited> = [],
): DocumentSettlement => {
  if (row.kind === "credit_note") return "unpaid";
  if (row.settlement === "credited") return "credited";
  if (creditNotes.length > 0 && isFullyCredited(row, creditNotes)) return "credited";
  if (row.kind === "payment_tax_document") return "paid";
  const owed = owedOf(row, creditNotes);
  if (row.payments === 0 && BigDecimal.isPositive(owed)) return "unpaid";
  if (BigDecimal.isLessThan(row.paidAmount, owed)) return "partially_paid";
  return BigDecimal.equals(row.paidAmount, owed) ? "paid" : "overpaid";
};

export const negateBucket = (b: VatBucket): VatBucket => ({
  ...b,
  base: neg(b.base),
  vat: neg(b.vat),
  gross: neg(b.gross),
  vatCzk: b.vatCzk === null ? null : neg(b.vatCzk),
});

/** A deduction line's base (its stored amount is gross when prices include VAT). */
const deductionBase = (row: Pick<DocumentRecord, "pricesIncludeVat">, line: CreditLine) =>
  row.pricesIncludeVat
    ? BigDecimal.normalize(BigDecimal.subtract(line.amount, line.deductedVat ?? ZERO))
    : line.amount;

/**
 * The deduction buckets of a Final Invoice (rule D8) as stored on its lines (negative; a
 * Credit Note reversing them carries them positive), merged per (treatment, rate); [] when the
 * document has no deduction lines. CZK VAT only for a foreign currency.
 */
export const deductionBucketsOf = (
  row: Pick<DocumentRecord, "lines" | "currency" | "pricesIncludeVat">,
): ReadonlyArray<VatBucket> =>
  mergeBuckets(
    row.lines
      .filter((l) => l.deducts !== null)
      .map((l) => {
        const vat = l.deductedVat ?? ZERO;
        const base = deductionBase(row, l);
        return {
          treatment: l.treatment,
          ratePercent: l.ratePercent,
          base,
          vat: BigDecimal.normalize(vat),
          gross: BigDecimal.normalize(BigDecimal.sum(base, vat)),
          vatCzk: row.currency === "CZK" ? null : l.deductedVatCzk,
        };
      }),
  );

/** Sets the whole-unit rounding adjustment (outside every bucket, §36(5)) and the gross. */
export const withRounding = (
  totals: VatBreakdown,
  adjustment: BigDecimal.BigDecimal,
): VatBreakdown => ({
  ...totals,
  roundingAdjustment: { ...totals.roundingAdjustment, amount: BigDecimal.normalize(adjustment) },
  gross: {
    ...totals.gross,
    amount: BigDecimal.normalize(
      BigDecimal.sum(
        BigDecimal.subtract(totals.gross.amount, totals.roundingAdjustment.amount),
        adjustment,
      ),
    ),
  },
});

/**
 * The Credit Note for the uncorrected remainder (rule D6). Without earlier Credit Notes it
 * negates every line and the totals exactly (`VatMath.negate`). After partial corrections it
 * credits one line per bucket with a remainder, and its totals are the negated remainders
 * (base, VAT, gross and CZK VAT per bucket, plus the uncredited rounding adjustment), so the
 * cumulative credits close the original to zero whatever `pricesIncludeVat` was.
 */
export const remainderSpec = (
  original: DocumentRecord,
  creditNotes: ReadonlyArray<DocumentRecord>,
): CreditSpec => {
  if (creditNotes.length === 0) {
    return {
      lines: original.lines.map(({ id: _id, ...l }) => ({
        ...l,
        quantity: neg(l.quantity),
        amount: neg(l.amount),
        // A Final Invoice's deductions are reversed with it (their stored VAT negated).
        deductedVat: l.deductedVat === null ? null : neg(l.deductedVat),
        deductedVatCzk: l.deductedVatCzk === null ? null : neg(l.deductedVatCzk),
      })),
      totals: VatMath.negate(original.totals),
      pricesIncludeVat: original.pricesIncludeVat,
    };
  }
  // A Final Invoice's deductions are never credited partially (corrections.ts), so they are
  // all still open here: reverse them as their own lines and credit the supply remainder.
  const deductions = original.lines.filter((l) => l.deducts !== null);
  const deducted = deductionBucketsOf(original);
  const remaining = remainingBuckets(original, creditNotes);
  // Supply lines carry document-currency amounts only: a bucket whose base, VAT and gross are
  // closed gets no line, even with a CZK residual (the deductions' CZK VAT is at the PTDs'
  // fixings, the Final Invoice's at its own, D8); the totals below close the CZK VAT exactly.
  const left = (
    deducted.length === 0 ? remaining : mergeBuckets(remaining, deducted.map(negateBucket))
  ).filter((b) => !(isZero(b.base) && isZero(b.vat) && isZero(b.gross)));
  const label = original.language === "cs" ? "Oprava" : "Correction of";
  const reversed = deductions.map(({ id: _id, ...l }): CreditLine => {
    const base = deductionBase(original, l);
    return {
      ...l,
      quantity: BigDecimal.fromBigInt(1n),
      unitPrice: neg(base),
      amount: neg(base),
      deductedVat: l.deductedVat === null ? null : neg(l.deductedVat),
      deductedVatCzk: l.deductedVatCzk === null ? null : neg(l.deductedVatCzk),
    };
  });
  const supply = left.flatMap(
    (b): ReadonlyArray<CreditLine> => [
      {
        item: null,
        description: `${label} ${original.number ?? ""}`.trim(),
        quantity: BigDecimal.fromBigInt(-1n),
        unit: null,
        unitPrice: b.base,
        itemPrice: null,
        vat: b.treatment,
        itemVat: null,
        treatment: b.treatment,
        ratePercent: b.ratePercent,
        amount: neg(b.base),
        deducts: null,
        deductedVat: null,
        deductedVatCzk: null,
      },
    ],
  );
  return {
    lines: [...supply, ...reversed],
    totals: withRounding(
      VatMath.negate(VatMath.fromBuckets(remaining.filter(isOpenBucket), original.currency)),
      neg(
        [original, ...creditNotes].reduce(
          (sum, d) => BigDecimal.sum(sum, d.totals.roundingAdjustment.amount),
          ZERO,
        ),
      ),
    ),
    pricesIncludeVat: false,
  };
};

export interface IssueCreditNoteInput {
  readonly reason: string;
  /** Prague today: the Credit Note's issue (and due) date and its numbering period. */
  readonly issuedOn: IsoDate;
  /** The correction's tax point; the caller checks it against the original and today. */
  readonly correctedOn: IsoDate;
  readonly credit: CreditSpec;
}

/**
 * The Credit Note record (pure, no numbering or storage), for `issueCreditNote` and P3's
 * `previewCorrection` (which passes a placeholder number).
 */
export const creditNoteRecord = (
  original: DocumentRecord,
  input: IssueCreditNoteInput,
  number: {
    readonly id: DocumentId;
    readonly number: string | null;
    readonly seriesId: NumberingSeriesId | null;
    readonly lines: ReadonlyArray<LineRecord>;
    readonly at: string;
  },
): DocumentRecord => ({
  id: number.id,
  workspaceId: original.workspaceId,
  revision: 1,
  kind: "credit_note",
  status: "issued",
  locked: false,
  lockedAt: null,
  number: number.number,
  seriesId: number.seriesId,
  contactId: original.contactId,
  contact: original.contact,
  issuer: original.issuer,
  given: {
    currency: original.currency,
    issuedOn: input.issuedOn,
    taxableSupplyOn: input.correctedOn,
    due: { on: input.issuedOn },
    language: original.language,
    ...(number.seriesId === null ? {} : { series: number.seriesId }),
    paymentMethod: original.paymentMethod,
  },
  currency: original.currency,
  language: original.language,
  paymentMethod: original.paymentMethod,
  note: null,
  issuedOn: input.issuedOn,
  taxableSupplyOn: input.correctedOn,
  dueOn: input.issuedOn,
  pricesIncludeVat: input.credit.pricesIncludeVat,
  // D4 / core-ports 4.4: the digits of its own number (follows a later override).
  variableSymbol: digitsOf(number.number),
  orderNumber: original.orderNumber,
  lines: number.lines,
  totals: input.credit.totals,
  fx: original.fx,
  fxOverride: original.fxOverride,
  taxDocument: original.taxDocument,
  paymentRounding: original.paymentRounding,
  remindersChoice: "off",
  remindersOn: false,
  links: [{ relation: "corrects", id: original.id }],
  paidAmount: ZERO,
  payments: 0,
  settlement: "unpaid",
  scheduleId: null,
  occurrence: null,
  cancelledOn: null,
  correctedNumber: original.number,
  reason: input.reason,
  createdAt: number.at,
  updatedAt: number.at,
  issuedAt: number.at,
});

/**
 * Issues a Credit Note against `original`, which the caller has row-locked (S4: the root
 * document first, then the credit_note counter): numbers it from the Workspace's default
 * credit_note series, links both documents (`corrects` / `corrected_by`), sets the original's
 * settlement to `credited` when nothing is left to credit, and audits the Credit Note's issue.
 * The caller audits its own action on the original (`document.cancel`, `document.correct`)
 * and checks D7's per-bucket cap before calling.
 */
export const issueCreditNote = (original: DocumentRecord, input: IssueCreditNoteInput) =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const numbering = yield* NumberingSeries;
    const ids = yield* IdGenerator;
    const { at } = yield* now;
    const workspaceId: WorkspaceId = original.workspaceId;
    const id = yield* newId<DocumentId>();
    const series = yield* numbering.resolve(workspaceId, "credit_note");
    const allocation = yield* numbering.allocate({
      workspaceId,
      kind: "credit_note",
      seriesId: series.id,
      documentId: id,
      issuedOn: input.issuedOn,
    });
    const lines: Array<LineRecord> = [];
    for (const l of input.credit.lines) lines.push({ ...l, id: (yield* ids.next) as LineId });

    const creditNote = yield* repo
      .insert(
        creditNoteRecord(original, input, {
          id,
          number: allocation.number,
          seriesId: allocation.seriesId,
          lines,
          at,
        }),
      )
      // The allocator reserved the number for this document, so the index cannot break.
      .pipe(Effect.catchTag("UniqueViolation", () => new Conflict({ reason: "duplicate" })));

    const earlier = yield* repo.getMany(
      workspaceId,
      original.links.filter((l) => l.relation === "corrected_by").map((l) => l.id),
    );
    const updated = yield* repo
      .update(
        {
          ...original,
          links: [...original.links, { relation: "corrected_by", id: creditNote.id }],
          // Credited in full, or the amount owed dropped by the credited gross.
          settlement: settlementOf(original, [...earlier, creditNote]),
          updatedAt: at,
        },
        original.revision,
      )
      .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
    yield* appendAudit({
      workspaceId,
      subject: { entity: "Document", id: creditNote.id },
      action: "document.issue",
      revision: creditNote.revision,
      changes: [
        { path: "number", before: null, after: creditNote.number },
        { path: "corrects", before: null, after: original.id },
      ],
      reason: input.reason,
    });
    return { original: updated, creditNote } as const;
  });
