/**
 * Corrections (P3; rules D5, D7, D13): `correct` issues a Credit Note against an issued Invoice
 * or Payment Tax Document, `previewCorrection` returns the Credit Note it would issue,
 * unnumbered and unstored. Both build the same `CreditSpec` (rule D15).
 *
 * `lines: "full"` credits the uncorrected remainder (`remainderSpec`, as cancel does). A partial
 * correction names original lines and the quantity and/or unit price to credit (default: the
 * line's own); each Credit Note line negates the picked quantity at the original's treatment,
 * rate, exchange rate and price basis (§42, user-flows Q5), so its totals are the §45(1) deltas.
 * D7's cap: per rate bucket, cumulative credits never exceed the original's base, VAT or gross
 * (`Invalid{credit_note.exceeds_original}`).
 */
import type {
  CorrectionInput,
  DocumentId,
  DocumentView,
  IsoDate,
  Issue,
  RequestOptions,
  VatBucket,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentId as DocumentIdSchema,
  Invalid,
  IsoDate as IsoDateSchema,
  LineId as LineIdSchema,
} from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Schema } from "effect";
import { VatMath } from "../../engines/vat";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { fxDryRun } from "../../shared/fx";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator } from "../../shared/ids";
import { NumberingSeries } from "../numbering";
import { mergeBuckets } from "./compose";
import type { CreditLine, CreditSpec } from "./credit";
import {
  creditNoteRecord,
  deductionBucketsOf,
  deductionsOpen,
  issueCreditNote,
  negateBucket,
  remainderSpec,
  remainingBuckets,
  roundingLeft,
  withRounding,
} from "./credit";
import type { DocumentRecord, LineRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { now, rolledBack, viewOf } from "./support";
import { guard } from "./transitions";
import { DocumentViewCodec } from "./view";

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

const malformed = (path: Issue["path"], reason: string) =>
  new Invalid({ issues: [{ path, code: "request.malformed", params: { reason } }] });

/** D7, with what is left to credit (user-flows 3.9: "blocked with the remaining amount"). */
const exceeds = (remaining: ReadonlyArray<VatBucket>, currency: string) =>
  new Invalid({
    issues: [
      {
        path: ["lines"],
        code: "credit_note.exceeds_original",
        params: {
          remaining: BigDecimal.format(
            BigDecimal.normalize(
              remaining.reduce((sum, b) => BigDecimal.sum(sum, b.gross), BigDecimal.fromBigInt(0n)),
            ),
          ),
          currency,
        },
      },
    ],
  });

const bucketKey = (b: Pick<VatBucket, "treatment" | "ratePercent">) =>
  `${b.treatment}|${BigDecimal.format(BigDecimal.normalize(b.ratePercent))}`;

/** Checks the input that needs no stored state: the reason (trimmed) and the date. */
const checkInput = (original: DocumentRecord, input: CorrectionInput, today: IsoDate) =>
  Effect.gen(function* () {
    const reason = input.reason.trim();
    if (reason === "") return yield* malformed(["reason"], "required");
    // P2 interim (parent ruling): from the original's issue date through today.
    const correctedOn = input.correctedOn ?? today;
    if (correctedOn < original.issuedOn || correctedOn > today) {
      return yield* malformed(["correctedOn"], "out_of_range");
    }
    return { reason, correctedOn };
  });

/**
 * The Credit Note's lines and totals for a partial correction: one line per pick, negated
 * quantity, original price basis and rate; totals by VatMath at the original's tax point and
 * exchange rate, without whole-unit rounding (a remainder credit carries it, `remainderSpec`).
 */
const partialSpec = (
  original: DocumentRecord,
  picks: Exclude<CorrectionInput["lines"], "full">,
): Effect.Effect<CreditSpec, Invalid> =>
  Effect.gen(function* () {
    if (picks.length === 0) return yield* malformed(["lines"], "required");
    const byId = new Map(original.lines.map((l) => [l.id as string, l]));
    const seen = new Set<string>();
    const lines: Array<CreditLine> = [];
    for (const [i, pick] of picks.entries()) {
      const line: LineRecord | undefined = byId.get(pick.line);
      if (line === undefined) return yield* malformed(["lines", i, "line"], "unknown_line");
      if (seen.has(pick.line)) return yield* malformed(["lines", i, "line"], "duplicate_line");
      seen.add(pick.line);
      // A deduction is reversed only with its whole Final Invoice ("full").
      if (line.deducts !== null) return yield* malformed(["lines", i, "line"], "deduction_line");
      // The credited delta: `quantity` units (default: all) at `unitPrice` (default: the
      // line's), both given as magnitudes. The Credit Note line keeps the original price's
      // sign and runs against the original quantity's, so it always offsets the line (a
      // discount line is credited with a positive amount); a zero effect is refused.
      const quantity = pick.quantity ?? BigDecimal.abs(line.quantity);
      if (!BigDecimal.isPositive(quantity)) {
        return yield* malformed(["lines", i, "quantity"], "out_of_range");
      }
      const magnitude = pick.unitPrice ?? BigDecimal.abs(line.unitPrice);
      if (!BigDecimal.isPositive(magnitude) || BigDecimal.isZero(line.unitPrice)) {
        return yield* malformed(["lines", i, "unitPrice"], "out_of_range");
      }
      const unitPrice = BigDecimal.isNegative(line.unitPrice) ? neg(magnitude) : magnitude;
      const credited = BigDecimal.isNegative(line.quantity) ? quantity : neg(quantity);
      const { id: _id, ...rest } = line;
      lines.push({
        ...rest,
        quantity: BigDecimal.normalize(credited),
        unitPrice: BigDecimal.normalize(unitPrice),
        amount: BigDecimal.normalize(BigDecimal.multiply(credited, unitPrice)),
        itemPrice: null,
      });
    }
    const totals = VatMath.calculate({
      lines: lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        treatment: l.treatment,
      })),
      currency: original.currency,
      taxPoint: original.taxableSupplyOn ?? original.issuedOn,
      pricesIncludeVat: original.pricesIncludeVat,
      fx: original.fx === null ? null : { rate: original.fx.rate, quantity: original.fx.quantity },
      paymentRounding: "none",
    });
    // The original's rates, not those in force today (VatMath rates by the tax point given).
    return { lines, totals, pricesIncludeVat: original.pricesIncludeVat };
  });

/**
 * D7: every Credit Note bucket component is zero or of the opposite sign to the uncredited
 * remainder and at most its size; a bucket the original lacks has nothing to credit.
 */
const withinRemainder = (
  remaining: ReadonlyArray<VatBucket>,
  credit: ReadonlyArray<VatBucket>,
): boolean => {
  const byKey = new Map(remaining.map((b) => [bucketKey(b), b]));
  const fits = (c: BigDecimal.BigDecimal, r: BigDecimal.BigDecimal | undefined) => {
    if (BigDecimal.isZero(c)) return true;
    if (r === undefined || BigDecimal.isZero(r)) return false;
    return (
      BigDecimal.sign(c) === -BigDecimal.sign(r) &&
      BigDecimal.isLessThanOrEqualTo(BigDecimal.abs(c), BigDecimal.abs(r))
    );
  };
  return credit.every((c) => {
    const r = byKey.get(bucketKey(c));
    return (
      fits(c.base, r?.base) &&
      fits(c.vat, r?.vat) &&
      fits(c.gross, r?.gross) &&
      (c.vatCzk === null || fits(c.vatCzk, r?.vatCzk ?? undefined))
    );
  });
};

const linksOf = (row: DocumentRecord, relation: DocumentRecord["links"][number]["relation"]) =>
  row.links.filter((l) => l.relation === relation).map((l) => l.id);

/**
 * Loads (`lock`: row-locks) the document to credit, S4 order: a Payment Tax Document's
 * Proforma first. Returns the Final Invoice that still deducts the PTD, if any.
 */
export const loadForCredit = (
  workspaceId: DocumentRecord["workspaceId"],
  id: DocumentId,
  lock: boolean,
) =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const read = (docId: DocumentId) =>
      lock ? repo.lock(workspaceId, docId) : repo.get(workspaceId, docId);
    const peek = yield* repo.get(workspaceId, id);
    const proformaId =
      peek.kind === "payment_tax_document" ? linksOf(peek, "advance_of")[0] : undefined;
    const proforma = proformaId === undefined ? null : yield* read(proformaId);
    const row = yield* read(id);
    const finalId = proforma === null ? undefined : linksOf(proforma, "final_invoice_for")[0];
    const finalInvoice = finalId === undefined ? null : yield* repo.get(workspaceId, finalId);
    const deductedBy =
      finalInvoice !== null &&
      finalInvoice.status === "issued" &&
      finalInvoice.settlement !== "credited" &&
      finalInvoice.lines.some((l) => l.deducts === id)
        ? finalInvoice
        : null;
    return { row, deductedBy };
  });

/**
 * The Credit Note `correct` would issue: state and kind checks (D5, D7, D8, D13), the input
 * checks, the spec and D7's cap. `original` is the (locked, for `correct`) stored row;
 * `deductedBy` a live Final Invoice deducting it (a PTD), which must be reversed first.
 */
const plan = (
  original: DocumentRecord,
  deductedBy: DocumentRecord | null,
  input: CorrectionInput,
  today: IsoDate,
) =>
  Effect.gen(function* () {
    yield* guard(original, "correct");
    if (original.kind !== "invoice" && original.kind !== "payment_tax_document") {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    // Nothing is left to credit (D6/D7); a deducted PTD is corrected after its Final Invoice.
    if (original.settlement === "credited" || deductedBy !== null) {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    const { reason, correctedOn } = yield* checkInput(original, input, today);
    const earlier = yield* (yield* DocumentsRepo).getMany(
      original.workspaceId,
      linksOf(original, "corrected_by"),
    );
    const remaining = remainingBuckets(original, earlier);
    if (input.lines === "full") {
      return { reason, correctedOn, credit: remainderSpec(original, earlier) };
    }
    const partial = yield* partialSpec(original, input.lines);
    // Partial credits touch supply lines only, so they are capped by the uncredited supply
    // (a Final Invoice's open deductions added back): a prepaid Final Invoice stays creditable.
    // As for any invoice, its CZK VAT is the supply's CZK VAT less what earlier Credit Notes
    // stored; the supply's is converted once at the original's fixing (D8, VatMath rule 9),
    // never with the PTDs' CZK VAT at their fixings.
    const supply = deductionsOpen(original, earlier)
      ? mergeBuckets(
          VatMath.netDeductions(
            original.totals.buckets,
            deductionBucketsOf(original).map(negateBucket),
            original.currency,
            original.fx,
          ),
          ...earlier.map((c) => c.totals.buckets),
        )
      : remaining;
    if (!withinRemainder(supply, partial.totals.buckets)) {
      return yield* exceeds(supply, original.currency);
    }
    if (
      !partial.totals.buckets.some((b) => !BigDecimal.isZero(b.gross) || !BigDecimal.isZero(b.vat))
    ) {
      return yield* malformed(["lines"], "zero_effect");
    }
    // A partial credit that closes every bucket also closes the whole-unit rounding (rule 7).
    const after = mergeBuckets(remaining, partial.totals.buckets);
    const closes =
      !deductionsOpen(original, earlier) &&
      after.every(
        (b) =>
          BigDecimal.isZero(b.base) &&
          BigDecimal.isZero(b.vat) &&
          BigDecimal.isZero(b.gross) &&
          (b.vatCzk === null || BigDecimal.isZero(b.vatCzk)),
      );
    const credit = closes
      ? {
          ...partial,
          totals: withRounding(partial.totals, neg(roundingLeft([original, ...earlier]))),
        }
      : partial;
    return { reason, correctedOn, credit };
  });

const CorrectPayload = Schema.Struct({
  id: DocumentIdSchema,
  reason: Schema.String,
  lines: Schema.Union([
    Schema.Literal("full"),
    Schema.Array(
      Schema.Struct({
        line: LineIdSchema,
        quantity: Schema.optional(Schema.BigDecimal),
        unitPrice: Schema.optional(Schema.BigDecimal),
      }),
    ),
  ]),
  correctedOn: Schema.optional(IsoDateSchema),
});

/** Credit Note against an issued Invoice or Payment Tax Document (rule D7). */
export const correct = (id: DocumentId, input: CorrectionInput, opts?: RequestOptions) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.correct");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.correct",
        payload: {
          schema: CorrectPayload as unknown as Schema.Codec<typeof CorrectPayload.Type, unknown>,
          value: {
            id,
            reason: input.reason,
            lines: input.lines,
            ...(input.correctedOn === undefined ? {} : { correctedOn: input.correctedOn }),
          },
        },
        result: DocumentViewCodec,
      },
      Effect.gen(function* () {
        const { today } = yield* now;
        const { row: original, deductedBy } = yield* loadForCredit(workspaceId, id, true);
        const { reason, correctedOn, credit } = yield* plan(original, deductedBy, input, today);
        const { original: updated, creditNote } = yield* issueCreditNote(original, {
          reason,
          issuedOn: today,
          correctedOn,
          credit,
        });
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.correct",
          revision: updated.revision,
          changes: [
            { path: "settlement", before: original.settlement, after: updated.settlement },
            { path: "creditNote", before: null, after: creditNote.id },
          ],
          reason,
        });
        return yield* viewOf(creditNote);
      }),
    );
  }).pipe(orUnavailable);

/** The Credit Note `correct(id, input)` would issue, unnumbered; nothing is stored. */
export const previewCorrection = (id: DocumentId, input: CorrectionInput) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.correct");
    const ids = yield* IdGenerator;
    const { today, at } = yield* now;
    const { row: original, deductedBy } = yield* loadForCredit(workspaceId, id, false);
    const { reason, correctedOn, credit } = yield* plan(original, deductedBy, input, today);
    const lines: Array<LineRecord> = [];
    for (const l of credit.lines) lines.push({ ...l, id: (yield* ids.next) as LineRecord["id"] });
    const cnId = (yield* ids.next) as DocumentId;
    // D15: allocate from the credit-note series like correct would, then roll it back.
    yield* rolledBack(
      Effect.gen(function* () {
        const numbering = yield* NumberingSeries;
        const series = yield* numbering.resolve(workspaceId, "credit_note");
        yield* numbering.allocate({
          workspaceId,
          kind: "credit_note",
          seriesId: series.id,
          documentId: cnId,
          issuedOn: today,
        });
      }),
    );
    const record = creditNoteRecord(
      original,
      { reason, issuedOn: today, correctedOn, credit },
      { id: cnId, number: null, seriesId: null, lines, at },
    );
    return yield* viewOf({ ...record, status: "draft", issuedAt: null });
  }).pipe(fxDryRun, orUnavailable) satisfies Effect.Effect<DocumentView, unknown, unknown>;
