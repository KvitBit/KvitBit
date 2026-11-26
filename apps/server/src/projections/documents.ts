/**
 * Server-side read projections for `Documents`, `Templates`, and `PublicShareLinks`:
 * - Canonical `variableSymbol` (stored override or `Numbering.variableSymbol`, last 10 digits)
 *   and `paymentQr` (SPAYD for CZK, EPC for EUR, rule D12) using the outstanding balance
 *   (`outstandingOf`, omitting QR when zero, flow 8.3) shared across HTTP, MCP, Share, and PDF.
 * - Revision-aware reconstruction from audit history when projecting an older `DocumentView`
 *   snapshot (request-key replay C3 and queued delivery J3), so later edits never mutate
 *   frozen historical projections.
 * - Explicit template signal (`ExplicitPdfTemplate`) so `DocumentRendererLive` resolves the
 *   workspace default `pdfTemplate` AFTER core authorization (R1a) for Member, Export, and
 *   Delivery callers alike while honoring explicit template overrides.
 * - Canonical PDF cache key including both document revision and workspace revision (core-ports §5.5, W7).
 */
import { createHash } from "node:crypto";
import { type PaymentQrPayload, forDocument as qrForDocument } from "@kvitbit/adapters/qr";
import { CoreStore, DocumentsModule, DocumentsRepo, ShareLinksRepo } from "@kvitbit/core";
import { Numbering } from "@kvitbit/core/engines";
import {
  type CurrencyCode,
  CurrentCaller,
  type DocumentId,
  Documents,
  type DocumentView,
  type IsoDate,
  type Locale,
  type PdfTemplate,
  PublicShareLinks,
  type SharedDocumentView,
  Templates,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { BigDecimal, Context, Effect, Layer, Option, Result } from "effect";

const ZERO = BigDecimal.fromStringUnsafe("0");

/**
 * Signals whether the caller explicitly specified a `template` override on `Documents.pdf`.
 * Absent or `false` lets `DocumentRendererLive` apply the workspace default `pdfTemplate`
 * after core authorization (R1a), covering Member, Export, and Delivery callers uniformly.
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
 * HTTP, MCP, Public Share, and PDF rendering.
 */
export const computeDocumentPaymentQr = (
  input: DocumentPaymentQrInput,
): PaymentQrPayload | null => {
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

/**
 * Resolves `variableSymbol`, `orderNumber`, `note`, and `amountDue` for `view` as of
 * `view.revision`. When `record.revision === view.revision`, uses `record` directly and
 * computes `outstandingOf(record, creditNotes)`. When `view` is a frozen historical snapshot
 * (`view.revision < record.revision`, e.g. C3 replay or J3 queued delivery), rewinds later
 * `document.edit` audit entries so later edits never leak into the older snapshot.
 */
export const resolveDocumentFieldsAtRevision = (params: {
  readonly workspaceId: WorkspaceId;
  readonly view: DocumentView;
  readonly record: DocumentsModule.DocumentRecord;
  readonly documentsRepo: DocumentsRepo["Service"];
  readonly coreStore?: CoreStore["Service"] | undefined;
}): Effect.Effect<ResolvedDocumentFields> =>
  Effect.gen(function* () {
    const { workspaceId, view, record, documentsRepo, coreStore } = params;
    let variableSymbol: string | null = record.variableSymbol;
    let orderNumber: string | null = record.orderNumber;
    let note: string | null = record.note;

    if (record.revision === view.revision) {
      const creditIds = record.links
        .filter((link) => link.relation === "corrected_by")
        .map((link) => link.id);
      const creditNotes =
        creditIds.length === 0
          ? []
          : yield* documentsRepo
              .getMany(workspaceId, creditIds)
              .pipe(
                Effect.catch(() =>
                  Effect.succeed([] as ReadonlyArray<DocumentsModule.DocumentRecord>),
                ),
              );
      const amountDue = DocumentsModule.outstandingOf(record, creditNotes);
      return { variableSymbol, orderNumber, note, amountDue };
    }

    if (coreStore !== undefined) {
      const entries = yield* coreStore.audit
        .history(workspaceId, { entity: "Document", id: record.id })
        .pipe(Effect.catch(() => Effect.succeed([])));
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
      view.settlement === "paid" || view.settlement === "overpaid" || view.settlement === "credited"
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
  if (view.paymentQr !== null) return view;
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
  if (view.paymentQr !== null) return view;
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

const projectMemberDocumentView = (
  view: DocumentView,
  documentsRepo: DocumentsRepo["Service"],
  coreStore: CoreStore["Service"],
) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller;
    if (caller._tag !== "Member") {
      return enrichDocumentView(view, null);
    }
    const record = yield* documentsRepo
      .get(caller.workspaceId, view.id)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (record === undefined) {
      return enrichDocumentView(view, null);
    }
    const fields = yield* resolveDocumentFieldsAtRevision({
      workspaceId: caller.workspaceId,
      view,
      record,
      documentsRepo,
      coreStore,
    });
    return enrichDocumentView(view, fields.variableSymbol, fields.amountDue);
  });

const ProjectedDocumentsLive: Layer.Layer<Documents, never, Documents | CoreStore | DocumentsRepo> =
  Layer.effect(
    Documents,
    Effect.gen(function* () {
      const baseDocuments = yield* Documents;
      const coreStore = yield* CoreStore;
      const documentsRepo = yield* DocumentsRepo;

      const projectView = (view: DocumentView) =>
        projectMemberDocumentView(view, documentsRepo, coreStore);

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

      return Templates.of({
        ...baseTemplates,
        use: (template, input, opts) =>
          baseTemplates
            .use(template, input, opts)
            .pipe(
              Effect.flatMap((view) => projectMemberDocumentView(view, documentsRepo, coreStore)),
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
            const caller = yield* CurrentCaller;
            let storedVariableSymbol: string | null = null;
            if (caller._tag === "ShareLinkVisitor") {
              const tokenHash = sha256HexSync(caller.token);
              const linkOpt = yield* coreStore
                .transaction(shareLinksRepo.lockByTokenHash(tokenHash))
                .pipe(Effect.catch(() => Effect.succeed(Option.none())));
              if (Option.isSome(linkOpt)) {
                storedVariableSymbol = yield* documentsRepo
                  .get(linkOpt.value.workspaceId, linkOpt.value.documentId)
                  .pipe(
                    Effect.map((row) => row.variableSymbol),
                    Effect.catch(() => Effect.succeed(null)),
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
 * - populates `paymentQr` using the outstanding balance (`outstandingOf`, omitted at zero) and
 *   revision-aware `variableSymbol` (stored override or `Numbering.variableSymbol`);
 * - signals explicit template overrides on `Documents.pdf` without reading workspace state
 *   before core authorization (R1a).
 */
export const ServerDocumentProjectionsLive: Layer.Layer<
  Documents | Templates | PublicShareLinks,
  never,
  Documents | Templates | PublicShareLinks | CoreStore | DocumentsRepo | ShareLinksRepo
> = Layer.mergeAll(ProjectedDocumentsLive, ProjectedTemplatesLive, ProjectedPublicShareLinksLive);
