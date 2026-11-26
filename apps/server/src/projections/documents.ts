/**
 * Server-side read projections for `Documents`, `Templates`, and `PublicShareLinks`:
 * - Canonical `variableSymbol` (stored override or `Numbering.variableSymbol`, last 10 digits)
 *   and `paymentQr` (SPAYD for CZK, EPC for EUR, rule D12) using the outstanding balance
 *   (`outstandingOf`, omitting QR for drafts/cancelled/paid/credited, flow 8.3) shared across
 *   HTTP, MCP, Share, and PDF.
 * - Frozen delivery snapshot attachment (`attachDeliverySnapshot` / `readDeliverySnapshot`) and
 *   SQL transactional projection helper (`projectDocumentFromSql`) used by `DeliveriesRepoSql`
 *   (J3) and `CoreStoreSql` (C3).
 * - Revision-aware reconstruction from audit history (propagating `StoreUnavailable`, never
 *   substituting newer edited fields on read failure).
 * - Explicit template signal (`ExplicitPdfTemplate`) so `DocumentRendererLive` resolves the
 *   workspace default `pdfTemplate` AFTER core authorization (R1a) for Member and Export
 *   callers while honoring explicit overrides and frozen delivery templates.
 * - Canonical PDF cache key including both document revision and workspace revision (core-ports §5.5, W7).
 */
import { createHash } from "node:crypto";
import { type PaymentQrPayload, forDocument as qrForDocument } from "@kvitbit/adapters/qr";
import {
  CoreStore,
  DocumentsModule,
  DocumentsRepo,
  ShareLinksRepo,
  type StoreUnavailable,
} from "@kvitbit/core";
import { Numbering } from "@kvitbit/core/engines";
import {
  type CurrencyCode,
  CurrentCaller,
  type DocumentId,
  Documents,
  type DocumentView,
  type ImageRef,
  type IsoDate,
  type Locale,
  type PdfTemplate,
  PublicShareLinks,
  type SharedDocumentView,
  Templates,
  Unavailable,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import { type BlobKey, RequestOutcome } from "@kvitbit/domain/ports";
import { BigDecimal, Context, Effect, Layer, Option, Result } from "effect";
import { SqlClient } from "effect/sql";

const ZERO = BigDecimal.fromStringUnsafe("0");
const DELIVERY_SNAPSHOT_SYMBOL = Symbol.for("kvitbit/server/DeliveryRenderSnapshot");
const LEGACY_DELIVERY_SYMBOL = Symbol.for("kvitbit/server/LegacyDeliveryView");

export interface DeliveryBrandingSnapshot {
  readonly workspaceRevision: number;
  readonly accentColor: string;
  readonly footerText: string | null;
  readonly logo: ImageRef | null;
  readonly stamp: ImageRef | null;
}

export interface DeliveryRenderSnapshot {
  readonly variableSymbol: string | null;
  readonly orderNumber: string | null;
  readonly note: string | null;
  readonly amountDue: BigDecimal.BigDecimal;
  readonly template: PdfTemplate;
  readonly branding?: DeliveryBrandingSnapshot | undefined;
}

/** Attaches frozen J3 delivery snapshot metadata as a non-enumerable symbol on `view`. */
export const attachDeliverySnapshot = (
  view: DocumentView,
  snapshot: DeliveryRenderSnapshot,
): DocumentView => {
  Object.defineProperty(view, DELIVERY_SNAPSHOT_SYMBOL, {
    value: snapshot,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return view;
};

/** Reads frozen J3 delivery snapshot metadata from `view`, if present. */
export const readDeliverySnapshot = (view: DocumentView): DeliveryRenderSnapshot | undefined =>
  (view as unknown as Record<symbol, DeliveryRenderSnapshot | undefined>)[DELIVERY_SNAPSHOT_SYMBOL];

/** Marks a delivery `view` decoded from a legacy row that lacked `__snapshot`. */
export const markLegacyDeliveryView = (view: DocumentView): DocumentView => {
  Object.defineProperty(view, LEGACY_DELIVERY_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return view;
};

/** True when `view` came from a legacy queued delivery row without frozen `__snapshot`. */
export const isLegacyDeliveryView = (view: DocumentView): boolean =>
  Boolean((view as unknown as Record<symbol, boolean | undefined>)[LEGACY_DELIVERY_SYMBOL]);

/**
 * Signals whether the caller explicitly specified a `template` override on `Documents.pdf`.
 * Absent or `false` lets `DocumentRendererLive` apply the workspace default `pdfTemplate`
 * after core authorization (R1a), covering Member and Export callers uniformly.
 */
export class ExplicitPdfTemplate extends Context.Service<ExplicitPdfTemplate, boolean>()(
  "kvitbit/server/ExplicitPdfTemplate",
) {}

export const sha256HexSync = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Resolves the canonical variable symbol: the stored value when non-empty, otherwise
 * `Numbering.variableSymbol(number)` (last 10 digits of the document number, core-ports §5.2).
 */
export const resolveVariableSymbol = (
  storedVariableSymbol: string | null | undefined,
  documentNumber: string | null,
): string | null => {
  if (storedVariableSymbol !== undefined && storedVariableSymbol !== null) {
    const trimmed = storedVariableSymbol.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return documentNumber === null ? null : Numbering.variableSymbol(documentNumber);
};

export interface DocumentPaymentQrInput {
  readonly kind: DocumentView["kind"];
  readonly status: DocumentView["status"];
  readonly number: string | null;
  readonly currency: CurrencyCode;
  readonly amount: BigDecimal.BigDecimal;
  readonly issuer: DocumentsModule.IssuerSnapshotRecord;
  readonly variableSymbol?: string | null | undefined;
  readonly dueOn: IsoDate | null;
}

/**
 * Computes the canonical payment QR payload (core-ports D12 & §5.2) shared across
 * HTTP, MCP, Public Share, Editor preview/drafts, and PDF rendering.
 */
export const computeDocumentPaymentQr = (
  input: DocumentPaymentQrInput,
): PaymentQrPayload | null => {
  if (input.status === "cancelled") return null;
  const variableSymbol = resolveVariableSymbol(input.variableSymbol, input.number);
  const res = qrForDocument({
    kind: input.kind,
    status: input.status,
    currency: input.currency,
    amount: input.amount,
    bankAccount: input.issuer.bankAccount,
    recipientName: input.issuer.name,
    message: input.number ? `${input.kind} ${input.number}` : input.kind,
    variableSymbol,
    dueOn: input.dueOn,
  });
  return Result.isSuccess(res) ? res.success : null;
};

export interface ResolvedDocumentFields {
  readonly variableSymbol: string | null;
  readonly orderNumber: string | null;
  readonly note: string | null;
  readonly amountDue: BigDecimal.BigDecimal;
}

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const parseJsonObject = <T>(raw: unknown): T =>
  typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T);

const parseDecimal = (raw: string | number | null | undefined): BigDecimal.BigDecimal => {
  if (raw === null || raw === undefined) return ZERO;
  return BigDecimal.fromStringUnsafe(String(raw));
};

/**
 * Computes the exact frozen fields (`variableSymbol`, `orderNumber`, `note`, `amountDue`,
 * `paymentQr`) for a document inside an active SQL transaction. Used by `DeliveriesRepoSql`
 * (J3 enqueue snapshot) and `CoreStoreSql` (C3 request-log completion).
 */
export const projectDocumentFromSql = (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  view: {
    readonly kind: DocumentView["kind"];
    readonly status: DocumentView["status"];
    readonly number: string | null;
    readonly currency: CurrencyCode;
    readonly issuer: DocumentsModule.IssuerSnapshotRecord;
    readonly dueOn: IsoDate | null;
  },
) =>
  Effect.gen(function* () {
    const docRows = yield* sql<{
      readonly variable_symbol: string | null;
      readonly order_number: string | null;
      readonly note: string | null;
      readonly paid_amount: string;
      readonly vat_breakdown: unknown;
      readonly kind: DocumentView["kind"];
      readonly status: DocumentView["status"];
    }>`
      select
        variable_symbol,
        order_number,
        note,
        paid_amount::text as paid_amount,
        vat_breakdown,
        kind,
        status
      from documents
      where workspace_id = ${workspaceId} and id = ${documentId}
      limit 1
    `;
    const docRow = docRows[0];
    if (docRow === undefined) return undefined;

    const relRows = yield* sql<{
      readonly to_document_id: DocumentId;
      readonly relation: string;
    }>`
      select to_document_id, relation
      from document_relations
      where workspace_id = ${workspaceId} and from_document_id = ${documentId}
    `;
    const creditIds = relRows
      .filter((r) => r.relation === "corrected_by")
      .map((r) => r.to_document_id);
    const creditRows =
      creditIds.length === 0
        ? []
        : yield* sql<{ readonly vat_breakdown: unknown }>`
            select vat_breakdown
            from documents
            where workspace_id = ${workspaceId} and id in ${sql.in(creditIds)}
          `;

    const grossOf = (raw: unknown): BigDecimal.BigDecimal => {
      const parsed = parseJsonObject<{ readonly gross: { readonly amount: string } }>(raw);
      return parseDecimal(parsed.gross.amount);
    };
    const fakeTotals = (amount: BigDecimal.BigDecimal) => ({
      gross: { amount, currency: view.currency },
    });
    const amountDue =
      docRow.status === "draft"
        ? docRow.kind === "invoice" || docRow.kind === "proforma"
          ? grossOf(docRow.vat_breakdown)
          : ZERO
        : DocumentsModule.outstandingOf(
            {
              kind: docRow.kind,
              status: docRow.status,
              paidAmount: parseDecimal(docRow.paid_amount),
              totals: fakeTotals(
                grossOf(docRow.vat_breakdown),
              ) as DocumentsModule.DocumentRecord["totals"],
              links: relRows.map((r) => ({
                relation: r.relation as DocumentsModule.LinkRecord["relation"],
                id: r.to_document_id,
              })),
            },
            creditRows.map((c) => ({
              totals: fakeTotals(
                grossOf(c.vat_breakdown),
              ) as DocumentsModule.DocumentRecord["totals"],
            })),
          );
    const variableSymbol = resolveVariableSymbol(docRow.variable_symbol, view.number);
    const paymentQr = computeDocumentPaymentQr({
      kind: view.kind,
      status: view.status,
      number: view.number,
      currency: view.currency,
      amount: amountDue,
      issuer: view.issuer,
      variableSymbol,
      dueOn: view.dueOn,
    });
    return {
      variableSymbol,
      orderNumber: docRow.order_number,
      note: docRow.note,
      amountDue,
      paymentQr,
    };
  });

/**
 * Resolves `variableSymbol`, `orderNumber`, `note`, and `amountDue` for `view` as of
 * `view.revision`. Propagates `StoreUnavailable` on failed credit or audit lookups so callers
 * never emit stale/inflated payment instructions or cache incomplete PDFs.
 */
export const resolveDocumentFieldsAtRevision = (params: {
  readonly workspaceId: WorkspaceId;
  readonly view: DocumentView;
  readonly record: DocumentsModule.DocumentRecord;
  readonly documentsRepo: DocumentsRepo["Service"];
  readonly coreStore?: CoreStore["Service"] | undefined;
}): Effect.Effect<ResolvedDocumentFields, StoreUnavailable> =>
  Effect.gen(function* () {
    const { workspaceId, view, record, documentsRepo, coreStore } = params;
    let variableSymbol: string | null = record.variableSymbol;
    let orderNumber: string | null = record.orderNumber;
    let note: string | null = record.note;

    if (record.revision === view.revision) {
      if (record.status === "draft") {
        const amountDue =
          record.kind === "invoice" || record.kind === "proforma"
            ? record.totals.gross.amount
            : ZERO;
        return { variableSymbol, orderNumber, note, amountDue };
      }
      const creditIds = record.links
        .filter((link) => link.relation === "corrected_by")
        .map((link) => link.id);
      const creditNotes =
        creditIds.length === 0 ? [] : yield* documentsRepo.getMany(workspaceId, creditIds);
      const amountDue = DocumentsModule.outstandingOf(record, creditNotes);
      return { variableSymbol, orderNumber, note, amountDue };
    }

    if (coreStore !== undefined) {
      const entries = yield* coreStore.audit.history(workspaceId, {
        entity: "Document",
        id: record.id,
      });
      const laterEdits = entries
        .filter(
          (entry) =>
            entry.revision !== null && entry.revision > view.revision && entry.changes.length > 0,
        )
        .toSorted((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
      for (const entry of laterEdits) {
        for (const change of entry.changes) {
          if (change.path === "variableSymbol") {
            variableSymbol = asNullableString(change.before);
          } else if (change.path === "orderNumber") {
            orderNumber = asNullableString(change.before);
          } else if (change.path === "note") {
            note = asNullableString(change.before);
          }
        }
      }
    } else {
      variableSymbol = resolveVariableSymbol(null, view.number);
      orderNumber = null;
      note = null;
    }

    const amountDue =
      view.status === "cancelled" ||
      view.settlement === "paid" ||
      view.settlement === "overpaid" ||
      view.settlement === "credited"
        ? ZERO
        : view.totals.gross.amount;
    return { variableSymbol, orderNumber, note, amountDue };
  });

/** Enriches a `DocumentView` with the canonical `paymentQr` if not already populated. */
export const enrichDocumentView = (
  view: DocumentView,
  storedVariableSymbol?: string | null,
  amountDue?: BigDecimal.BigDecimal,
): DocumentView => {
  if (view.paymentQr !== null || view.status === "cancelled") return view;
  const issuer = view.issuer as unknown as DocumentsModule.IssuerSnapshotRecord;
  const amount =
    amountDue !== undefined
      ? amountDue
      : view.settlement === "paid" ||
          view.settlement === "overpaid" ||
          view.settlement === "credited"
        ? ZERO
        : view.totals.gross.amount;
  const paymentQr = computeDocumentPaymentQr({
    kind: view.kind,
    status: view.status,
    number: view.number,
    currency: view.totals.gross.currency,
    amount,
    issuer,
    variableSymbol: storedVariableSymbol,
    dueOn: view.dates.dueOn,
  });
  return paymentQr === null ? view : { ...view, paymentQr };
};

/** Enriches a `SharedDocumentView` with the canonical `paymentQr` using `view.amountDue` (flow 8.3). */
export const enrichSharedDocumentView = (
  view: SharedDocumentView,
  storedVariableSymbol?: string | null,
): SharedDocumentView => {
  if (view.paymentQr !== null || view.status !== "issued") return view;
  const issuer = view.issuer as unknown as DocumentsModule.IssuerSnapshotRecord;
  const number = view.number.length > 0 ? view.number : null;
  const paymentQr = computeDocumentPaymentQr({
    kind: view.kind,
    status: view.status,
    number,
    currency: view.amountDue.currency,
    amount: view.amountDue.amount,
    issuer,
    variableSymbol: storedVariableSymbol,
    dueOn: view.dates.dueOn,
  });
  return paymentQr === null ? view : { ...view, paymentQr };
};

/**
 * Canonical `BlobStorage` cache key for rendered document PDFs (core-ports §5.5, D3, W7).
 * Includes both document revision and workspace revision so edits and branding changes invalidate.
 */
export const documentPdfCacheKey = (params: {
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly documentRevision: number;
  readonly workspaceRevision: number;
  readonly template: PdfTemplate;
  readonly language: Locale;
}): BlobKey =>
  `pdf/${params.workspaceId}/${params.documentId}/${params.documentRevision}/${params.workspaceRevision}/${params.template}/${params.language}.pdf` as BlobKey;

const toDbUnavailable = () => new Unavailable({ dependency: "database" });

const projectMemberDocumentView = (
  view: DocumentView,
  documentsRepo: DocumentsRepo["Service"],
  coreStore: CoreStore["Service"],
  hasSqlRequestLog: boolean,
): Effect.Effect<DocumentView, Unavailable, CurrentCaller> =>
  Effect.gen(function* () {
    if (
      view.paymentQr !== null ||
      view.status === "cancelled" ||
      view.kind === "credit_note" ||
      view.kind === "payment_tax_document"
    ) {
      return view;
    }
    const currency = view.totals.gross.currency;
    const issuer = view.issuer as unknown as DocumentsModule.IssuerSnapshotRecord;
    const iban = issuer.bankAccount?.iban ?? null;
    if ((currency !== "CZK" && currency !== "EUR") || iban === null || iban.trim() === "") {
      return view;
    }
    const outcomeOpt = yield* Effect.serviceOption(RequestOutcome);
    if (Option.isSome(outcomeOpt)) {
      const wasReplayed = yield* outcomeOpt.value.replayed;
      // CoreStoreSql already persisted the complete projected result (including valid null).
      if (wasReplayed && hasSqlRequestLog) return view;
    }
    const caller = yield* CurrentCaller;
    if (caller._tag !== "Member") {
      return enrichDocumentView(view, null);
    }
    const record = yield* documentsRepo.get(caller.workspaceId, view.id).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.mapError(toDbUnavailable),
    );
    if (record === undefined) {
      return enrichDocumentView(view, null);
    }
    const fields = yield* resolveDocumentFieldsAtRevision({
      workspaceId: caller.workspaceId,
      view,
      record,
      documentsRepo,
      coreStore,
    }).pipe(Effect.mapError(toDbUnavailable));
    return enrichDocumentView(view, fields.variableSymbol, fields.amountDue);
  });

const ProjectedDocumentsLive: Layer.Layer<Documents, never, Documents | CoreStore | DocumentsRepo> =
  Layer.effect(
    Documents,
    Effect.gen(function* () {
      const baseDocuments = yield* Documents;
      const coreStore = yield* CoreStore;
      const documentsRepo = yield* DocumentsRepo;
      const hasSqlRequestLog = Option.isSome(yield* Effect.serviceOption(SqlClient.SqlClient));

      const projectView = (view: DocumentView) =>
        projectMemberDocumentView(view, documentsRepo, coreStore, hasSqlRequestLog);

      return Documents.of({
        ...baseDocuments,
        preview: (input) =>
          baseDocuments
            .preview(input)
            .pipe(Effect.map((view) => enrichDocumentView(view, input.variableSymbol ?? null))),
        createDraft: (input, opts) =>
          baseDocuments.createDraft(input, opts).pipe(Effect.flatMap(projectView)),
        issue: (from, opts) => baseDocuments.issue(from, opts).pipe(Effect.flatMap(projectView)),
        edit: (id, patch, expectedRevision) =>
          baseDocuments.edit(id, patch, expectedRevision).pipe(Effect.flatMap(projectView)),
        lock: (id) => baseDocuments.lock(id).pipe(Effect.flatMap(projectView)),
        unlock: (id, reason) => baseDocuments.unlock(id, reason).pipe(Effect.flatMap(projectView)),
        cancel: (id, input, opts) =>
          baseDocuments.cancel(id, input, opts).pipe(
            Effect.flatMap((res) =>
              Effect.gen(function* () {
                const document = yield* projectView(res.document);
                const creditNote =
                  res.creditNote === null ? null : yield* projectView(res.creditNote);
                return { document, creditNote };
              }),
            ),
          ),
        correct: (id, input, opts) =>
          baseDocuments.correct(id, input, opts).pipe(Effect.flatMap(projectView)),
        issueFinalInvoice: (proforma, input, opts) =>
          baseDocuments.issueFinalInvoice(proforma, input, opts).pipe(Effect.flatMap(projectView)),
        previewFinalInvoice: (proforma, input) =>
          baseDocuments
            .previewFinalInvoice(proforma, input)
            .pipe(
              Effect.map((view) => enrichDocumentView(view, input?.patch?.variableSymbol ?? null)),
            ),
        previewCorrection: (id, input) =>
          baseDocuments
            .previewCorrection(id, input)
            .pipe(Effect.map((view) => enrichDocumentView(view, null))),
        get: (id) => baseDocuments.get(id).pipe(Effect.flatMap(projectView)),
        pdf: (id, opts) =>
          baseDocuments
            .pdf(id, opts)
            .pipe(Effect.provideService(ExplicitPdfTemplate, opts?.template !== undefined)),
      });
    }),
  );

const ProjectedTemplatesLive: Layer.Layer<Templates, never, Templates | CoreStore | DocumentsRepo> =
  Layer.effect(
    Templates,
    Effect.gen(function* () {
      const baseTemplates = yield* Templates;
      const coreStore = yield* CoreStore;
      const documentsRepo = yield* DocumentsRepo;
      const hasSqlRequestLog = Option.isSome(yield* Effect.serviceOption(SqlClient.SqlClient));

      return Templates.of({
        ...baseTemplates,
        use: (template, input, opts) =>
          baseTemplates
            .use(template, input, opts)
            .pipe(
              Effect.flatMap((view) =>
                projectMemberDocumentView(view, documentsRepo, coreStore, hasSqlRequestLog),
              ),
            ),
      });
    }),
  );

const ProjectedPublicShareLinksLive: Layer.Layer<
  PublicShareLinks,
  never,
  PublicShareLinks | CoreStore | DocumentsRepo | ShareLinksRepo
> = Layer.effect(
  PublicShareLinks,
  Effect.gen(function* () {
    const baseShareLinks = yield* PublicShareLinks;
    const coreStore = yield* CoreStore;
    const documentsRepo = yield* DocumentsRepo;
    const shareLinksRepo = yield* ShareLinksRepo;

    return PublicShareLinks.of({
      ...baseShareLinks,
      open: baseShareLinks.open.pipe(
        Effect.flatMap((view) =>
          Effect.gen(function* () {
            if (view.paymentQr !== null || view.status !== "issued") return view;
            const caller = yield* CurrentCaller;
            let storedVariableSymbol: string | null = null;
            if (caller._tag === "ShareLinkVisitor") {
              const tokenHash = sha256HexSync(caller.token);
              const linkOpt = yield* coreStore
                .transaction(shareLinksRepo.lockByTokenHash(tokenHash))
                .pipe(Effect.mapError(toDbUnavailable));
              if (Option.isSome(linkOpt)) {
                storedVariableSymbol = yield* documentsRepo
                  .get(linkOpt.value.workspaceId, linkOpt.value.documentId)
                  .pipe(
                    Effect.map((row) => row.variableSymbol),
                    Effect.catchTag("NotFound", () => Effect.succeed(null)),
                    Effect.mapError(toDbUnavailable),
                  );
              }
            }
            return enrichSharedDocumentView(view, storedVariableSymbol);
          }),
        ),
      ),
    });
  }),
);

/**
 * Wraps `Documents`, `Templates`, and `PublicShareLinks` with the server's canonical read
 * projections:
 * - populates `paymentQr` using the outstanding balance (`outstandingOf`, omitted for drafts
 *   and zero balances) and revision-aware `variableSymbol`;
 * - signals explicit template overrides on `Documents.pdf` without reading workspace state
 *   before core authorization (R1a).
 */
export const ServerDocumentProjectionsLive: Layer.Layer<
  Documents | Templates | PublicShareLinks,
  never,
  Documents | Templates | PublicShareLinks | CoreStore | DocumentsRepo | ShareLinksRepo
> = Layer.mergeAll(ProjectedDocumentsLive, ProjectedTemplatesLive, ProjectedPublicShareLinksLive);
