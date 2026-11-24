/**
 * The Final Invoice (P3; rule D8, §37a): `issueFinalInvoice` turns a paid Proforma into an
 * Invoice that deducts the advance, `previewFinalInvoice` returns it unnumbered and unstored.
 * Both build the same spec (rule D15).
 *
 * The Invoice copies the Proforma's contact, lines, currency, language, note, payment method,
 * bank account and price basis; dates, due date, series and variable symbol are its own (the
 * patch may set them). Deductions follow the patched lines: for each Payment Tax Document of
 * the Proforma, one line per bucket it has left uncredited, carrying the PTD's base, VAT and
 * CZK VAT as stored (compose deducts them exactly); without Payment Tax Documents
 * (`non_vat_payer`, `identified_person`), one `outside_scope` line for the amount paid.
 */
import type {
  DocumentId,
  DocumentPatch,
  DocumentView,
  RequestOptions,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentId as DocumentIdSchema,
  DocumentPatch as DocumentPatchSchema,
  Invalid,
} from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Schema } from "effect";
import { ZERO } from "../../engines/decimal";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import type { DocumentSpec, LineSpec } from "./compose";
import { applyPatch, compose, specFromRecord } from "./compose";
import { remainingBuckets } from "./credit";
import { numbered } from "./lifecycle";
import type { DocumentRecord, LinkRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { newDraftRecord, now, rolledBack, viewOf } from "./support";
import { guard, hasFinalInvoice } from "./transitions";
import { DocumentViewCodec } from "./view";

const MINUS_ONE = BigDecimal.fromBigInt(-1n);
const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));
const nonZero = (v: BigDecimal.BigDecimal) => !BigDecimal.isZero(v);

const linked = (row: DocumentRecord, relation: LinkRecord["relation"]) =>
  row.links.filter((l) => l.relation === relation).map((l) => l.id);

/**
 * The deduction line specs (D8). Each Payment Tax Document of the Proforma: one line per
 * bucket it has left uncredited, its VAT as stored. Cash the PTDs do not cover (paid without
 * a PTD: `non_vat_payer`, `identified_person`, a skipped or later PTD, user-flows 3.8): one
 * `outside_scope` line for that amount with no VAT, since the Final Invoice declares its VAT.
 */
const deductionLines = (proforma: DocumentRecord, lock: boolean) =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const label = proforma.language === "cs" ? "Odpočet zálohy" : "Advance deduction";
    const lines: Array<LineSpec> = [];
    let covered = ZERO;
    for (const ptdId of linked(proforma, "tax_document_for")) {
      // S4: the root (Proforma) first, then its dependents.
      const ptd = lock
        ? yield* repo.lock(proforma.workspaceId, ptdId)
        : yield* repo.get(proforma.workspaceId, ptdId);
      const credits = yield* repo.getMany(proforma.workspaceId, linked(ptd, "corrected_by"));
      for (const b of remainingBuckets(ptd, credits)) {
        if (!nonZero(b.base) && !nonZero(b.vat) && (b.vatCzk === null || !nonZero(b.vatCzk))) {
          continue;
        }
        covered = BigDecimal.sum(covered, b.gross);
        lines.push({
          id: null,
          item: null,
          description: `${label} ${ptd.number ?? ""}`.trim(),
          quantity: MINUS_ONE,
          unit: null,
          unitPrice: b.base,
          vat: b.treatment,
          itemVat: null,
          itemPrice: null,
          deducts: ptd.id,
          deduction: {
            currency: ptd.currency,
            treatment: b.treatment,
            ratePercent: b.ratePercent,
            base: neg(b.base),
            vat: neg(b.vat),
            vatCzk: b.vatCzk === null ? null : neg(b.vatCzk),
          },
        });
      }
    }
    const cash = BigDecimal.normalize(BigDecimal.subtract(proforma.paidAmount, covered));
    if (BigDecimal.isPositive(cash)) {
      lines.push({
        id: null,
        item: null,
        description: `${label} ${proforma.number ?? ""}`.trim(),
        quantity: MINUS_ONE,
        unit: null,
        unitPrice: cash,
        vat: "outside_scope",
        itemVat: null,
        itemPrice: null,
        deducts: proforma.id,
        deduction: {
          currency: proforma.currency,
          treatment: "outside_scope",
          ratePercent: ZERO,
          base: neg(cash),
          vat: ZERO,
          vatCzk: null,
        },
      });
    }
    return lines;
  });

/**
 * The Final Invoice spec for a (locked, for issue) Proforma: state, kind, duplicate and
 * payment checks, the Proforma's lines and terms with the patch, then the deductions.
 */
const plan = (proforma: DocumentRecord, patch: DocumentPatch | undefined, lock: boolean) =>
  Effect.gen(function* () {
    yield* guard(proforma, "finalInvoice");
    if (proforma.kind !== "proforma") return yield* new Conflict({ reason: "illegal_transition" });
    if (hasFinalInvoice(proforma)) return yield* new Conflict({ reason: "duplicate" });
    // The Final Invoice is numbered from its series (D1); an override comes later (D4).
    if (patch?.number !== undefined) {
      return yield* new Invalid({
        issues: [
          { path: ["number"], code: "request.malformed", params: { reason: "not_allowed" } },
        ],
      });
    }
    if (proforma.payments === 0) {
      return yield* new Invalid({
        issues: [{ path: ["proforma"], code: "final_invoice.proforma_unpaid" }],
      });
    }
    const source = specFromRecord(proforma);
    const {
      issuedOn: _issuedOn,
      taxableSupplyOn: _taxableSupplyOn,
      due: _due,
      series: _series,
      variableSymbol: _variableSymbol,
      ...terms
    } = source.given;
    const base: DocumentSpec = {
      ...source,
      kind: "invoice",
      given: terms,
      lines: source.lines.map((l) => ({ ...l, id: null })),
      // D11: the Invoice fixes its own rate at its tax point.
      fxOverride: null,
    };
    const patched =
      patch === undefined ? base : yield* applyPatch(proforma.workspaceId, base, patch);
    const deductions = yield* deductionLines(proforma, lock);
    return { ...patched, lines: [...patched.lines, ...deductions] } satisfies DocumentSpec;
  });

const FinalPayload = Schema.Struct({
  proforma: DocumentIdSchema,
  patch: Schema.optional(DocumentPatchSchema),
});

/** Links of the new Final Invoice: its Proforma and each deducted document. */
const finalLinks = (proforma: DocumentRecord, spec: DocumentSpec): ReadonlyArray<LinkRecord> => [
  { relation: "advance_of", id: proforma.id },
  ...[...new Set(spec.lines.flatMap((l) => (l.deducts === null ? [] : [l.deducts])))]
    .filter((id) => id !== proforma.id)
    .map((id) => ({ relation: "deducts" as const, id })),
];

/**
 * Issues the Final Invoice (D8): locks the Proforma first (the lock `Payments.record` takes,
 * S4), then its Payment Tax Documents, numbers the Invoice from its series, links the Proforma
 * (`final_invoice_for`, once: `Conflict{duplicate}`) and audits both documents.
 */
export const issueFinalInvoice = (
  proformaId: DocumentId,
  input?: { readonly patch?: DocumentPatch },
  opts?: RequestOptions,
) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.finalInvoice");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.issueFinalInvoice",
        payload: {
          schema: FinalPayload as unknown as Schema.Codec<typeof FinalPayload.Type, unknown>,
          value:
            input?.patch === undefined
              ? { proforma: proformaId }
              : { proforma: proformaId, patch: input.patch },
        },
        result: DocumentViewCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        const proforma = yield* repo.lock(workspaceId, proformaId);
        const spec = yield* plan(proforma, input?.patch, true);
        const id = yield* newId<DocumentId>();
        const composed = yield* compose(workspaceId, spec, { today });
        const next = yield* numbered(workspaceId, id, composed);
        const saved = yield* repo
          .insert(
            withSettlement({
              ...newDraftRecord(id, workspaceId, composed, at),
              ...next,
              status: "issued",
              links: finalLinks(proforma, spec),
              issuedAt: at,
            }),
          )
          .pipe(Effect.catchTag("UniqueViolation", () => new Conflict({ reason: "duplicate" })));
        const updated = yield* repo
          .update(
            {
              ...proforma,
              links: [...proforma.links, { relation: "final_invoice_for", id }],
              updatedAt: at,
            },
            proforma.revision,
          )
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.issue",
          revision: saved.revision,
          changes: [
            { path: "number", before: null, after: saved.number },
            { path: "finalInvoiceFor", before: null, after: proforma.id },
          ],
        });
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id: proforma.id },
          action: "document.finalInvoice",
          revision: updated.revision,
          changes: [{ path: "finalInvoice", before: null, after: id }],
        });
        return yield* viewOf(saved);
      }),
    );
  }).pipe(orUnavailable);

/** The Final Invoice `issueFinalInvoice` would issue, with its deductions, unnumbered. */
export const previewFinalInvoice = (
  proformaId: DocumentId,
  input?: { readonly patch?: DocumentPatch },
) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.finalInvoice");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        const proforma = yield* repo.get(workspaceId, proformaId);
        const spec = yield* plan(proforma, input?.patch, false);
        const composed = yield* compose(workspaceId, spec, { today });
        const id = yield* newId<DocumentId>();
        // D15: fails like issue would (series exhausted), then rolls the allocation back.
        yield* rolledBack(numbered(workspaceId, id, composed));
        const row = newDraftRecord(id, workspaceId, composed, at);
        return yield* viewOf(withSettlement({ ...row, links: finalLinks(proforma, spec) }));
      }),
    );
  }).pipe(orUnavailable) satisfies Effect.Effect<DocumentView, unknown, unknown>;

/** A Final Invoice whose advances cover it is `paid` (or `overpaid`) from the start. */
const withSettlement = (row: DocumentRecord): DocumentRecord => {
  const gross = row.totals.gross.amount;
  if (BigDecimal.isPositive(gross)) return row;
  return { ...row, settlement: BigDecimal.isZero(gross) ? "paid" : "overpaid" };
};
