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

const bucketKey = (b: Pick<VatBucket, "treatment" | "ratePercent">) =>
  `${b.treatment}|${BigDecimal.format(BigDecimal.normalize(b.ratePercent))}`;

const addOpt = (a: BigDecimal.BigDecimal | null, b: BigDecimal.BigDecimal | null) =>
  a === null ? b : b === null ? a : BigDecimal.sum(a, b);

/**
 * The original's buckets minus what its Credit Notes already credited (their buckets are
 * negative), in the original's bucket order. Buckets a Credit Note adds that the original
 * lacks are kept, so an over-credit shows as a negative remainder.
 */
export const remainingBuckets = (
  original: Pick<DocumentRecord, "totals">,
  creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>,
): ReadonlyArray<VatBucket> => {
  const byKey = new Map<string, VatBucket>();
  for (const b of [...original.totals.buckets, ...creditNotes.flatMap((c) => c.totals.buckets)]) {
    const key = bucketKey(b);
    const prev = byKey.get(key);
    byKey.set(
      key,
      prev === undefined
        ? b
        : {
            ...prev,
            base: BigDecimal.normalize(BigDecimal.sum(prev.base, b.base)),
            vat: BigDecimal.normalize(BigDecimal.sum(prev.vat, b.vat)),
            gross: BigDecimal.normalize(BigDecimal.sum(prev.gross, b.gross)),
            vatCzk: addOpt(prev.vatCzk, b.vatCzk),
          },
    );
  }
  return [...byKey.values()];
};

/**
 * Nothing of the original is left to credit: every bucket's base, VAT, gross and CZK VAT is
 * zero and so is the summed whole-unit rounding adjustment.
 */
export const isFullyCredited = (
  original: Pick<DocumentRecord, "totals">,
  creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>,
): boolean =>
  remainingBuckets(original, creditNotes).every(
    (b) =>
      isZero(b.base) && isZero(b.vat) && isZero(b.gross) && (b.vatCzk === null || isZero(b.vatCzk)),
  ) &&
  isZero(
    [original, ...creditNotes].reduce(
      (sum, d) => BigDecimal.sum(sum, d.totals.roundingAdjustment.amount),
      ZERO,
    ),
  );

/** Sets the whole-unit rounding adjustment (outside every bucket, §36(5)) and the gross. */
const withRounding = (totals: VatBreakdown, adjustment: BigDecimal.BigDecimal): VatBreakdown => ({
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
      })),
      totals: VatMath.negate(original.totals),
      pricesIncludeVat: original.pricesIncludeVat,
    };
  }
  const left = remainingBuckets(original, creditNotes).filter(
    (b) =>
      !(
        isZero(b.base) &&
        isZero(b.vat) &&
        isZero(b.gross) &&
        (b.vatCzk === null || isZero(b.vatCzk))
      ),
  );
  const label = original.language === "cs" ? "Oprava" : "Correction of";
  return {
    lines: left.map((b) => ({
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
    })),
    totals: withRounding(
      VatMath.negate(VatMath.fromBuckets(left, original.currency)),
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
    const credited = isFullyCredited(original, [...earlier, creditNote]);
    const updated = yield* repo
      .update(
        {
          ...original,
          links: [...original.links, { relation: "corrected_by", id: creditNote.id }],
          settlement: credited ? "credited" : original.settlement,
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
