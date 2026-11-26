/**
 * Server-side read projections for `Documents` and `PublicShareLinks`:
 * - Canonical `variableSymbol` (stored override or `Numbering.variableSymbol`, last 10 digits)
 *   and `paymentQr` (SPAYD for CZK, EPC for EUR, rule D12) shared across HTTP, MCP, Share, and PDF.
 * - Workspace default `pdfTemplate` when `Documents.pdf` is called without an explicit template.
 * - Canonical PDF cache key including both document revision and workspace revision (core-ports §5.5, W7).
 */
import { createHash } from "node:crypto";
import { type PaymentQrPayload, forDocument as qrForDocument } from "@kvitbit/adapters/qr";
import {
  CoreStore,
  type DocumentsModule,
  DocumentsRepo,
  ShareLinksRepo,
  WorkspacesRepo,
} from "@kvitbit/core";
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
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { type BigDecimal, Effect, Layer, Option, Result } from "effect";

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

/** Enriches a `DocumentView` with the canonical `paymentQr` if not already populated. */
export const enrichDocumentView = (
  view: DocumentView,
  storedVariableSymbol?: string | null,
): DocumentView => {
  if (view.paymentQr !== null) return view;
  const issuer = view.issuer as unknown as DocumentsModule.IssuerSnapshotRecord;
  const paymentQr = computeDocumentPaymentQr({
    kind: view.kind,
    status: view.status,
    number: view.number,
    currency: view.totals.gross.currency,
    amount: view.totals.gross.amount,
    issuer,
    variableSymbol: storedVariableSymbol,
    dueOn: view.dates.dueOn,
  });
  return paymentQr === null ? view : { ...view, paymentQr };
};

/** Enriches a `SharedDocumentView` with the canonical `paymentQr` if not already populated. */
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
    currency: view.totals.gross.currency,
    amount: view.totals.gross.amount,
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

const ProjectedDocumentsLive: Layer.Layer<
  Documents,
  never,
  Documents | DocumentsRepo | WorkspacesRepo
> = Layer.effect(
  Documents,
  Effect.gen(function* () {
    const baseDocuments = yield* Documents;
    const documentsRepo = yield* DocumentsRepo;
    const workspacesRepo = yield* WorkspacesRepo;

    const loadVariableSymbol = (documentId: DocumentId) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
        if (caller._tag !== "Member") return null;
        return yield* documentsRepo.get(caller.workspaceId, documentId).pipe(
          Effect.map((row) => row.variableSymbol),
          Effect.catch(() => Effect.succeed(null)),
        );
      });

    const projectView = (view: DocumentView) =>
      loadVariableSymbol(view.id).pipe(Effect.map((vs) => enrichDocumentView(view, vs)));

    const resolveDefaultTemplate = Effect.gen(function* () {
      const caller = yield* CurrentCaller;
      if (caller._tag !== "Member") return undefined;
      return yield* workspacesRepo.getWorkspace(caller.workspaceId).pipe(
        Effect.map((ws) => ws.branding.pdfTemplate),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    });

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
        Effect.gen(function* () {
          if (opts?.template !== undefined) {
            return yield* baseDocuments.pdf(id, opts);
          }
          const defaultTemplate = yield* resolveDefaultTemplate;
          return yield* baseDocuments.pdf(
            id,
            defaultTemplate === undefined ? opts : { ...opts, template: defaultTemplate },
          );
        }),
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
 * Wraps `Documents` and `PublicShareLinks` with the server's canonical read projections:
 * - populates `paymentQr` on all `DocumentView` and `SharedDocumentView` results using the
 *   stored `variableSymbol` (or `Numbering.variableSymbol` fallback);
 * - resolves the workspace's default `pdfTemplate` when `Documents.pdf` is called without one.
 */
export const ServerDocumentProjectionsLive: Layer.Layer<
  Documents | PublicShareLinks,
  never,
  Documents | PublicShareLinks | CoreStore | DocumentsRepo | WorkspacesRepo | ShareLinksRepo
> = Layer.mergeAll(ProjectedDocumentsLive, ProjectedPublicShareLinksLive);
