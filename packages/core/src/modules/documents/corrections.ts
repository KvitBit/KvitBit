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
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator } from "../../shared/ids";
import type { CreditLine, CreditSpec } from "./credit";
import { creditNoteRecord, issueCreditNote, remainderSpec, remainingBuckets } from "./credit";
import type { DocumentRecord, LineRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { now, viewOf } from "./support";
import { guard } from "./transitions";
import { DocumentViewCodec } from "./view";

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

const malformed = (path: Issue["path"], reason: string) =>
  new Invalid({ issues: [{ path, code: "request.malformed", params: { reason } }] });

const exceeds = () =>
  new Invalid({ issues: [{ path: ["lines"], code: "credit_note.exceeds_original" }] });

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
    return fits(c.base, r?.base) && fits(c.vat, r?.vat) && fits(c.gross, r?.gross);
  });
};

/**
 * The Credit Note `correct` would issue: state and kind checks (D5, D7, D13), the input
 * checks, the spec and D7's cap. `original` is the (locked, for `correct`) stored row.
 */
const plan = (original: DocumentRecord, input: CorrectionInput, today: IsoDate) =>
  Effect.gen(function* () {
    yield* guard(original, "correct");
    if (original.kind !== "invoice" && original.kind !== "payment_tax_document") {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    // Nothing is left to credit (D6/D7).
    if (original.settlement === "credited") {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    const { reason, correctedOn } = yield* checkInput(original, input, today);
    const earlier = yield* (yield* DocumentsRepo).getMany(
      original.workspaceId,
      original.links.filter((l) => l.relation === "corrected_by").map((l) => l.id),
    );
    const credit =
      input.lines === "full"
        ? remainderSpec(original, earlier)
        : yield* partialSpec(original, input.lines);
    if (!withinRemainder(remainingBuckets(original, earlier), credit.totals.buckets)) {
      return yield* exceeds();
    }
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
        const repo = yield* DocumentsRepo;
        const { today } = yield* now;
        const original = yield* repo.lock(workspaceId, id);
        const { reason, correctedOn, credit } = yield* plan(original, input, today);
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
    const repo = yield* DocumentsRepo;
    const ids = yield* IdGenerator;
    const { today, at } = yield* now;
    const original = yield* repo.get(workspaceId, id);
    const { reason, correctedOn, credit } = yield* plan(original, input, today);
    const lines: Array<LineRecord> = [];
    for (const l of credit.lines) lines.push({ ...l, id: (yield* ids.next) as LineRecord["id"] });
    const record = creditNoteRecord(
      original,
      { reason, issuedOn: today, correctedOn, credit },
      { id: (yield* ids.next) as DocumentId, number: null, seriesId: null, lines, at },
    );
    return yield* viewOf({ ...record, status: "draft", issuedAt: null });
  }).pipe(orUnavailable) satisfies Effect.Effect<DocumentView, unknown, unknown>;
