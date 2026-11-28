/**
 * Payments seam (stage 2, cd-payments; board #529): what the Payments module needs from
 * documents, so it never writes documents files. `DocumentPayments` methods run INSIDE the
 * caller's CoreStore transaction (they join it; nothing commits on its own), never authorize
 * (Payments authorizes `payment.write`). The write methods take the audit caller explicitly.
 *
 * Port failures stay raw (`StoreUnavailable`, `RatesUnavailable`): the caller maps them with
 * `orUnavailable` at its method boundary.
 *
 * Call order in one transaction (S2-S4): `lock` (the Proforma first, then the Final Invoice
 * or the requested document), then `settle` and, for a `vat_payer` Proforma advance,
 * `issuePaymentTaxDocument` (the PTD series counter after the Proforma lock).
 */

import type {
  AuditEntry,
  Caller,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  DocumentView,
  IsoDate,
  Money,
  NotFound,
  TaxRegime,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentId as DocumentIdSchema,
  Invalid,
  LineId as LineIdSchema,
  MoneyMath,
} from "@kvitbit/domain/contract";
import type { RatesUnavailable } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as EffectString from "effect/String";
import { ZERO } from "../../engines/decimal";
import { Fx } from "../../engines/fx";
import { VAT_RATE_TABLE, VatMath } from "../../engines/vat";
import { appendAudit } from "../../shared/audit";
import { FxFixings } from "../../shared/fx";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore, type StoreUnavailable } from "../../store/CoreStore";
import { NumberingSeries } from "../numbering";
import { digitsOf, isFullyCredited, owedOf, settlementOf } from "./credit";
import { DocumentIssuers } from "./ports";
import type { DocumentRecord, LineRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { insertNumbered, now, viewOf } from "./support";
import { guard } from "./transitions";

/** A document as Payments sees it (amounts in the document currency). */
export interface Payable {
  readonly id: DocumentId;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  readonly locked: boolean;
  readonly number: string | null;
  readonly currency: CurrencyCode;
  /** Stored gross (a Final Invoice's is net of its deductions, D8). */
  readonly gross: Money;
  /** What Credit Notes credited, positive. */
  readonly credited: Money;
  /** gross - credited: what payments settle against. */
  readonly owed: Money;
  readonly paid: Money;
  /** paid - owed when positive (an overpaid Invoice, a Final Invoice below its advances). */
  readonly refundDue: Money;
  readonly payments: number;
  readonly settlement: DocumentSettlement;
  /** The Issuing Entity's Tax Regime at the document's tax point (snapshot). */
  readonly regime: TaxRegime;
  /** A Proforma's Final Invoice (D8). */
  readonly finalInvoice: DocumentId | null;
  /** The Proforma of a Final Invoice or Payment Tax Document. */
  readonly proforma: DocumentId | null;
  /** A Proforma's Payment Tax Documents. */
  readonly taxDocuments: ReadonlyArray<DocumentId>;
}

export interface PaymentTargets {
  /** The document the payment names. */
  readonly requested: Payable;
  /** Where the payment settles: a Proforma's Final Invoice once it has one (D8), else requested. */
  readonly settleOn: Payable;
  /** The Proforma at the root (locked first), when there is one. */
  readonly proforma: Payable | null;
}

export interface SettleAudit {
  readonly action: "payment.record" | "payment.remove";
  /** Required by Payments for `payment.remove` (core-ports 4.5). */
  readonly reason?: string | null;
  /** The payment's own particulars (id, amount, paidOn, method), appended to the entry. */
  readonly details?: AuditEntry["changes"];
}

/**
 * Why a payment cannot be removed yet (P3), in the order to resolve: a Final Invoice that is
 * not credited deducts the Proforma's advance (PTD or cash), or its Payment Tax Document is
 * not fully credited.
 */
export type RemovalBlock = "final_invoice_deducts" | "tax_document_open";

type SeamError = NotFound | StoreUnavailable;

export class DocumentPayments extends Context.Service<
  DocumentPayments,
  {
    /** Row-locks the payment's documents in S4 order. Other Workspace -> NotFound{Document}. */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<PaymentTargets, SeamError>;
    /**
     * Stores the document's live payment total and count, derives the settlement (credit
     * aware), bumps the revision and writes one audit entry on the Document subject with
     * `audit.action`. More payments on anything but an issued (or locked) Invoice or Proforma
     * -> Conflict{illegal_transition}; a negative or fractional count, or an amount without
     * payments -> Invalid{request.malformed}.
     */
    readonly settle: (
      caller: Caller,
      workspaceId: WorkspaceId,
      id: DocumentId,
      paid: { readonly amount: BigDecimal.BigDecimal; readonly payments: number },
      audit: SettleAudit,
    ) => Effect.Effect<Payable, SeamError | Conflict | Invalid>;
    /**
     * P2: the Payment Tax Document for an advance received on a locked, issued Proforma;
     * null when the Issuing Entity is not a `vat_payer` on `paidOn`. Tax point `paidOn`, VAT
     * by `VatMath.splitAdvance` over the Proforma's buckets, CNB fixing for `paidOn` (carried
     * back) when not CZK, numbered from the PTD series.
     */
    readonly issuePaymentTaxDocument: (
      caller: Caller,
      workspaceId: WorkspaceId,
      proforma: DocumentId,
      payment: { readonly amount: BigDecimal.BigDecimal; readonly paidOn: IsoDate },
    ) => Effect.Effect<DocumentView | null, SeamError | Conflict | Invalid | RatesUnavailable>;
    /**
     * P3 for a payment booked on `target` that issued `taxDocument` (null: none): null when it
     * may be removed. Payments maps a block to Conflict{illegal_transition} (detail
     * `payment.has_tax_document`).
     */
    readonly removalBlocked: (
      workspaceId: WorkspaceId,
      target: DocumentId,
      taxDocument: DocumentId | null,
    ) => Effect.Effect<RemovalBlock | null, SeamError>;
  }
>()("@kvitbit/core/modules/documents/payments/DocumentPayments") {}

const linksOf = (row: DocumentRecord, relation: DocumentRecord["links"][number]["relation"]) =>
  EffectArray.map(
    EffectArray.filter(row.links, (l) => l.relation === relation),
    (l) => l.id,
  );

const creditsOf = (row: DocumentRecord) =>
  Effect.flatMap(DocumentsRepo, (repo) =>
    repo.getMany(row.workspaceId, linksOf(row, "corrected_by")),
  );

const money = (amount: BigDecimal.BigDecimal, currency: CurrencyCode) =>
  MoneyMath.make(BigDecimal.normalize(amount), currency);

/** The Payable view of a stored record. */
export const payableOf: {
  (creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>): (row: DocumentRecord) => Payable;
  (row: DocumentRecord, creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>): Payable;
} = Fn.dual(
  2,
  (row: DocumentRecord, creditNotes: ReadonlyArray<Pick<DocumentRecord, "totals">>): Payable => {
    const owed = owedOf(row, creditNotes);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      revision: row.revision,
      kind: row.kind,
      status: row.status,
      locked: row.locked,
      number: row.number,
      currency: row.currency,
      gross: row.totals.gross,
      credited: money(BigDecimal.subtract(row.totals.gross.amount, owed), row.currency),
      owed: money(owed, row.currency),
      paid: money(row.paidAmount, row.currency),
      // Cash owed back lives on the paid document (user-flows 3.9), never on a Credit Note's
      // negative face value or a PTD.
      refundDue: money(
        (row.kind === "invoice" || row.kind === "proforma") &&
          BigDecimal.isGreaterThan(row.paidAmount, owed)
          ? BigDecimal.subtract(row.paidAmount, owed)
          : ZERO,
        row.currency,
      ),
      payments: row.payments,
      settlement: row.settlement,
      regime: row.issuer.regime,
      finalInvoice: linksOf(row, "final_invoice_for")[0] ?? null,
      proforma: linksOf(row, "advance_of")[0] ?? null,
      taxDocuments: linksOf(row, "tax_document_for"),
    };
  },
);

const payable = (row: DocumentRecord) =>
  Effect.map(creditsOf(row), (credits) => payableOf(row, credits));

const lock = Effect.fn("lock")(function* (workspaceId: WorkspaceId, id: DocumentId) {
  const repo = yield* DocumentsRepo;
  // An unlocked read only to find the root; the S4 order is root, dependents.
  const peek = yield* repo.get(workspaceId, id);
  const rootId = peek.kind === "proforma" ? id : linksOf(peek, "advance_of")[0];
  let proforma: DocumentRecord | null = null;
  let requested: DocumentRecord;
  if (rootId !== undefined && rootId !== id) {
    proforma = yield* repo.lock(workspaceId, rootId);
    requested = yield* repo.lock(workspaceId, id);
  } else {
    requested = yield* repo.lock(workspaceId, id);
    proforma = requested.kind === "proforma" ? requested : null;
  }
  const finalId = proforma === null ? undefined : linksOf(proforma, "final_invoice_for")[0];
  const finalInvoice =
    finalId === undefined
      ? null
      : finalId === requested.id
        ? requested
        : yield* repo.lock(workspaceId, finalId);
  const settleOn =
    requested.kind === "proforma" && finalInvoice !== null ? finalInvoice : requested;
  return {
    requested: yield* payable(requested),
    settleOn: yield* payable(settleOn),
    proforma: proforma === null ? null : yield* payable(proforma),
  } satisfies PaymentTargets;
});

const malformed = (path: string, reason: string) =>
  Invalid.make({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });

const settle = Effect.fn("settle")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  id: DocumentId,
  paid: { readonly amount: BigDecimal.BigDecimal; readonly payments: number },
  audit: SettleAudit,
) {
  const repo = yield* DocumentsRepo;
  const { at } = yield* now;
  if (!Number.isInteger(paid.payments) || paid.payments < 0) {
    return yield* malformed("payments", "out_of_range");
  }
  if (paid.payments === 0 && !BigDecimal.isZero(paid.amount)) {
    return yield* malformed("amount", "out_of_range");
  }
  const row = yield* repo.lock(workspaceId, id);
  if (paid.payments > row.payments) {
    yield* guard(row, "recordPayment");
    if (row.kind !== "invoice" && row.kind !== "proforma") {
      return yield* Conflict.make({ reason: "illegal_transition" });
    }
  }
  const credits = yield* creditsOf(row);
  const changed = {
    ...row,
    paidAmount: BigDecimal.normalize(paid.amount),
    payments: paid.payments,
  };
  const next = yield* repo
    .update({ ...changed, settlement: settlementOf(changed, credits), updatedAt: at }, row.revision)
    .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
  yield* appendAudit(caller, {
    workspaceId,
    subject: { entity: "Document", id },
    action: audit.action,
    revision: next.revision,
    changes: [
      {
        path: "paidAmount",
        before: BigDecimal.format(row.paidAmount),
        after: BigDecimal.format(next.paidAmount),
      },
      { path: "payments", before: row.payments, after: next.payments },
      { path: "settlement", before: row.settlement, after: next.settlement },
      ...(audit.details ?? []),
    ],
    reason: audit.reason ?? null,
  });
  return payableOf(next, credits);
});

/** The record of a Payment Tax Document for `amount` received on `paidOn` (pure). */
export const paymentTaxDocumentRecord: {
  (input: {
    readonly id: DocumentId;
    readonly number: string | null;
    readonly seriesId: DocumentRecord["seriesId"];
    readonly paidOn: IsoDate;
    readonly today: IsoDate;
    readonly at: string;
    readonly regime: TaxRegime;
    readonly fx: DocumentRecord["fx"];
    readonly lines: ReadonlyArray<LineRecord>;
    readonly totals: DocumentRecord["totals"];
  }): (proforma: DocumentRecord) => DocumentRecord;
  (
    proforma: DocumentRecord,
    input: {
      readonly id: DocumentId;
      readonly number: string | null;
      readonly seriesId: DocumentRecord["seriesId"];
      readonly paidOn: IsoDate;
      readonly today: IsoDate;
      readonly at: string;
      readonly regime: TaxRegime;
      readonly fx: DocumentRecord["fx"];
      readonly lines: ReadonlyArray<LineRecord>;
      readonly totals: DocumentRecord["totals"];
    },
  ): DocumentRecord;
} = Fn.dual(
  2,
  (
    proforma: DocumentRecord,
    input: {
      readonly id: DocumentId;
      readonly number: string | null;
      readonly seriesId: DocumentRecord["seriesId"];
      readonly paidOn: IsoDate;
      readonly today: IsoDate;
      readonly at: string;
      readonly regime: TaxRegime;
      readonly fx: DocumentRecord["fx"];
      readonly lines: ReadonlyArray<LineRecord>;
      readonly totals: DocumentRecord["totals"];
    },
  ): DocumentRecord => ({
    id: input.id,
    workspaceId: proforma.workspaceId,
    revision: 1,
    kind: "payment_tax_document",
    status: "issued",
    locked: false,
    lockedAt: null,
    number: input.number,
    seriesId: input.seriesId,
    contactId: proforma.contactId,
    contact: proforma.contact,
    issuer: { ...proforma.issuer, regime: input.regime },
    given: {
      currency: proforma.currency,
      issuedOn: input.today,
      taxableSupplyOn: input.paidOn,
      due: { on: input.today },
      language: proforma.language,
      series: input.seriesId ?? undefined,
      paymentMethod: proforma.paymentMethod,
    },
    currency: proforma.currency,
    language: proforma.language,
    paymentMethod: proforma.paymentMethod,
    note: null,
    issuedOn: input.today,
    taxableSupplyOn: input.paidOn,
    dueOn: input.today,
    // Gross prices: the PTD's VAT is top-down from the advance (rule 4), so a partial
    // correction recomputes it on the same basis.
    pricesIncludeVat: true,
    variableSymbol: proforma.variableSymbol ?? digitsOf(proforma.number),
    orderNumber: proforma.orderNumber,
    lines: input.lines,
    totals: input.totals,
    fx: input.fx,
    fxOverride: null,
    taxDocument: true,
    paymentRounding: "none",
    remindersChoice: "off",
    remindersOn: false,
    links: [{ relation: "advance_of", id: proforma.id }],
    paidAmount: ZERO,
    payments: 0,
    settlement: "paid",
    scheduleId: null,
    occurrence: null,
    cancelledOn: null,
    correctedNumber: null,
    reason: null,
    createdAt: input.at,
    updatedAt: input.at,
    issuedAt: input.at,
  }),
);

const issuePaymentTaxDocument = Effect.fn("issuePaymentTaxDocument")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  proformaId: DocumentId,
  payment: { readonly amount: BigDecimal.BigDecimal; readonly paidOn: IsoDate },
) {
  const repo = yield* DocumentsRepo;
  const numbering = yield* NumberingSeries;

  const { today, at } = yield* now;
  // The caller locked it first (P2a); locking again in the same transaction is a no-op.
  const proforma = yield* repo.lock(workspaceId, proformaId);
  yield* guard(proforma, "recordPayment");
  if (proforma.kind !== "proforma") return yield* Conflict.make({ reason: "illegal_transition" });
  // After the Final Invoice, receipts belong to it (D8): no further advance PTD.
  if (linksOf(proforma, "final_invoice_for").length > 0) {
    return yield* Conflict.make({ reason: "illegal_transition" });
  }
  if (!BigDecimal.isPositive(payment.amount)) return yield* malformed("amount", "out_of_range");
  const issuer = yield* (yield* DocumentIssuers).forDocument(caller, workspaceId, payment.paidOn);
  if (issuer.regime !== "vat_payer") return null;
  // The VAT rate table starts at its first entry; an earlier tax point has no rates.
  if (payment.paidOn < (VAT_RATE_TABLE[0]?.from ?? payment.paidOn)) {
    return yield* malformed("paidOn", "out_of_range");
  }
  // splitAdvance divides by the buckets' gross (not the rounded total).
  const bucketGross = EffectArray.reduce(proforma.totals.buckets, ZERO, (sum, b) =>
    BigDecimal.sum(sum, b.gross),
  );
  if (!BigDecimal.isPositive(bucketGross)) return yield* malformed("amount", "out_of_range");
  // Non-CZK: the CNB fixing valid on the receipt date (carried back), rule P2.
  const fixing = Fx.needsFixing(proforma.currency, null)
    ? yield* (yield* FxFixings).fixing(payment.paidOn)
    : null;
  const fxResult = Fx.resolve({ currency: proforma.currency, override: null, fixing });
  if (Result.isFailure(fxResult)) return yield* fxResult.failure;
  const fx = fxResult.success;
  const shares = EffectArray.filter(
    VatMath.splitAdvance(proforma.totals, payment.amount, {
      fx: fx === null ? null : { rate: fx.rate, quantity: fx.quantity },
      taxPoint: payment.paidOn,
    }),
    (b) => !BigDecimal.isZero(b.gross),
  );
  const totals = VatMath.fromBuckets(shares, proforma.currency);
  const label = proforma.language === "cs" ? "Přijatá záloha k" : "Advance received for";
  const lines: Array<LineRecord> = [];
  for (const b of shares) {
    lines.push({
      id: yield* newId(LineIdSchema.make),
      item: null,
      description: EffectString.trim(`${label} ${proforma.number ?? ""}`),
      quantity: BigDecimal.fromBigInt(1n),
      unit: null,
      unitPrice: b.gross,
      itemPrice: null,
      vat: b.treatment,
      itemVat: null,
      treatment: b.treatment,
      ratePercent: b.ratePercent,
      amount: b.gross,
      deducts: null,
      deductedVat: null,
      deductedVatCzk: null,
    });
  }
  const id = yield* newId(DocumentIdSchema.make);
  const series = yield* numbering.resolve(workspaceId, "payment_tax_document");
  const record = (number: string | null, seriesId: DocumentRecord["seriesId"]) =>
    paymentTaxDocumentRecord(proforma, {
      id,
      number,
      seriesId,
      paidOn: payment.paidOn,
      today,
      at,
      regime: issuer.regime,
      fx,
      lines,
      totals,
    });
  const ptd = yield* insertNumbered(
    record(null, series.id),
    Effect.map(
      numbering.allocate({
        workspaceId,
        kind: "payment_tax_document",
        seriesId: series.id,
        documentId: id,
        issuedOn: today,
      }),
      (allocation) => record(allocation.number, allocation.seriesId),
    ),
  );
  const updated = yield* repo
    .update(
      {
        ...proforma,
        links: [...proforma.links, { relation: "tax_document_for", id }],
        updatedAt: at,
      },
      proforma.revision,
    )
    .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
  yield* appendAudit(caller, {
    workspaceId,
    subject: { entity: "Document", id },
    action: "document.issue",
    revision: ptd.revision,
    changes: [
      { path: "number", before: null, after: ptd.number },
      { path: "advanceOf", before: null, after: proforma.id },
    ],
  });
  yield* appendAudit(caller, {
    workspaceId,
    subject: { entity: "Document", id: proforma.id },
    action: "document.taxDocument",
    revision: updated.revision,
    changes: [{ path: "taxDocuments", before: null, after: id }],
  });
  return yield* viewOf(ptd);
});

const removalBlocked = (
  workspaceId: WorkspaceId,
  target: DocumentId,
  taxDocument: DocumentId | null,
): Effect.Effect<RemovalBlock | null, SeamError, DocumentsRepo> =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const booked = yield* repo.get(workspaceId, target);
    const finalId =
      booked.kind === "proforma" ? linksOf(booked, "final_invoice_for")[0] : undefined;
    if (finalId !== undefined) {
      // The Final Invoice deducted this advance (D8): it must be reversed first.
      const finalInvoice = yield* repo.get(workspaceId, finalId);
      // Reversed: fully credited (tax document) or cancelled (non-tax, D6).
      if (finalInvoice.status === "issued" && finalInvoice.settlement !== "credited") {
        return "final_invoice_deducts";
      }
    }
    if (taxDocument !== null) {
      const ptd = yield* repo.get(workspaceId, taxDocument);
      const credits = yield* creditsOf(ptd);
      if (!isFullyCredited(ptd, credits)) return "tax_document_open";
    }
    return null;
  });

/** Everything `DocumentPaymentsLive` requires. */
export type DocumentPaymentsDeps =
  | CoreStore
  | IdGenerator
  | DocumentsRepo
  | NumberingSeries
  | FxFixings
  | DocumentIssuers;

export const DocumentPaymentsLive: Layer.Layer<DocumentPayments, never, DocumentPaymentsDeps> =
  Layer.effect(
    DocumentPayments,
    Effect.gen(function* () {
      // Only the build dependencies: the build-time context may hold a RequestOutcome
      // or transaction frame, and providing them per call would override the caller's own.
      const buildContext = yield* Effect.context<DocumentPaymentsDeps>();
      const context = Context.pick(
        CoreStore,
        IdGenerator,
        DocumentsRepo,
        NumberingSeries,
        FxFixings,
        DocumentIssuers,
      )(buildContext);
      // The call site's context wins: its CoreStore transaction frame.
      const run = <A, E>(effect: Effect.Effect<A, E, DocumentPaymentsDeps>) =>
        Effect.flatMap(Effect.context<never>(), (callSite) =>
          Effect.provideContext(effect, Context.merge(context, callSite)),
        );
      return DocumentPayments.of({
        lock: Effect.fn("DocumentPayments.lock")((ws, id) => run(lock(ws, id))),
        settle: Effect.fn("DocumentPayments.settle")((caller, ws, id, paid, audit) =>
          run(settle(caller, ws, id, paid, audit)),
        ),
        issuePaymentTaxDocument: Effect.fn("DocumentPayments.issuePaymentTaxDocument")(
          (caller, ws, id, payment) => run(issuePaymentTaxDocument(caller, ws, id, payment)),
        ),
        removalBlocked: Effect.fn("DocumentPayments.removalBlocked")((ws, target, taxDocument) =>
          run(removalBlocked(ws, target, taxDocument)),
        ),
      });
    }),
  );
