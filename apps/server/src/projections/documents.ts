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
  type AuditEntry,
  type CurrencyCode,
  CurrentCaller,
  DeliveryId,
  type DocumentId,
  type DocumentRelation,
  Documents,
  type DocumentView,
  ImageRef,
  type IsoDate,
  type Locale,
  PdfTemplate,
  PublicShareLinks,
  type SharedDocumentView,
  Templates,
  Unavailable,
  VatBreakdown,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { BlobKey, RequestOutcome } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";

const ZERO = BigDecimal.fromStringUnsafe("0");
const DELIVERY_SNAPSHOT_SYMBOL = Symbol.for("kvitbit/server/DeliveryRenderSnapshot");
const LEGACY_DELIVERY_SYMBOL = Symbol.for("kvitbit/server/LegacyDeliveryView");

const DeliveryRenderSnapshot = Schema.Struct({
  variableSymbol: Schema.NullOr(Schema.String),
  orderNumber: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  amountDue: Schema.BigDecimal,
  template: PdfTemplate,
  branding: Schema.optional(
    Schema.Struct({
      workspaceRevision: Schema.Finite,
      accentColor: Schema.String,
      footerText: Schema.NullOr(Schema.String),
      logo: Schema.NullOr(ImageRef),
      stamp: Schema.NullOr(ImageRef),
    }),
  ),
});
export type DeliveryRenderSnapshot = typeof DeliveryRenderSnapshot.Type;
export type DeliveryBrandingSnapshot = NonNullable<DeliveryRenderSnapshot["branding"]>;

/** Attaches frozen J3 delivery snapshot metadata as a non-enumerable symbol on `view`. */
export const attachDeliverySnapshot: {
  (snapshot: DeliveryRenderSnapshot): (view: DocumentView) => DocumentView;
  (view: DocumentView, snapshot: DeliveryRenderSnapshot): DocumentView;
} = Fn.dual(2, (view: DocumentView, snapshot: DeliveryRenderSnapshot): DocumentView => {
  Object.defineProperty(view, DELIVERY_SNAPSHOT_SYMBOL, {
    value: snapshot,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return view;
});

/** Validates attached delivery metadata before callers can fall back to live document data. */
export const readDeliverySnapshot = (view: DocumentView): DeliveryRenderSnapshot | undefined => {
  if (!(DELIVERY_SNAPSHOT_SYMBOL in view)) return;
  const snapshot = view[DELIVERY_SNAPSHOT_SYMBOL];
  Schema.asserts(DeliveryRenderSnapshot, snapshot);
  return snapshot;
};

const LegacyDeliveryInfo = Schema.Struct({
  deliveryId: DeliveryId,
  workspaceId: WorkspaceId,
});
type LegacyDeliveryInfo = typeof LegacyDeliveryInfo.Type;

/** Marks a delivery `view` decoded from a legacy row that lacked `__snapshot`. */
export const markLegacyDeliveryView: {
  (info: LegacyDeliveryInfo): (view: DocumentView) => DocumentView;
  (view: DocumentView, info: LegacyDeliveryInfo): DocumentView;
} = Fn.dual(2, (view: DocumentView, info: LegacyDeliveryInfo): DocumentView => {
  Object.defineProperty(view, LEGACY_DELIVERY_SYMBOL, {
    value: info,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return view;
});

/** Returns legacy delivery metadata when `view` came from a legacy row without frozen `__snapshot`. */
export const readLegacyDeliveryInfo = (view: DocumentView): LegacyDeliveryInfo | undefined => {
  if (!(LEGACY_DELIVERY_SYMBOL in view)) return;
  const legacy = view[LEGACY_DELIVERY_SYMBOL];
  Schema.asserts(LegacyDeliveryInfo, legacy);
  return legacy;
};

/**
 * Signals whether the caller explicitly specified a `template` override on `Documents.pdf`.
 * Absent or `false` lets `DocumentRendererLive` apply the workspace default `pdfTemplate`
 * after core authorization (R1a), covering Member and Export callers uniformly.
 */
export class ExplicitPdfTemplate extends Context.Service<ExplicitPdfTemplate, boolean>()(
  "@kvitbit/server/projections/documents/ExplicitPdfTemplate",
) {}

export const sha256HexSync = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Resolves the canonical variable symbol: the stored value when non-empty, otherwise
 * `Numbering.variableSymbol(number)` (last 10 digits of the document number, core-ports §5.2).
 */
export const resolveVariableSymbol: {
  (
    documentNumber: string | null,
  ): (storedVariableSymbol: string | null | undefined) => string | null;
  (storedVariableSymbol: string | null | undefined, documentNumber: string | null): string | null;
} = Fn.dual(
  2,
  (
    storedVariableSymbol: string | null | undefined,
    documentNumber: string | null,
  ): string | null => {
    if (storedVariableSymbol !== undefined && storedVariableSymbol !== null) {
      const trimmed = Str.trim(storedVariableSymbol);
      if (trimmed.length > 0) return trimmed;
    }
    return documentNumber === null ? null : Numbering.variableSymbol(documentNumber);
  },
);

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
    message:
      input.number !== null && input.number !== "" ? `${input.kind} ${input.number}` : input.kind,
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

const nullableAuditText = Schema.decodeUnknownOption(Schema.String);
const VatBreakdownJson = Schema.toCodecJson(VatBreakdown);
const decodeTotals = Schema.decodeUnknownEffect(
  Schema.Union([Schema.fromJsonString(VatBreakdownJson), VatBreakdownJson]),
);
const IssuerSnapshotData = DocumentsModule.DocumentViewData.fields.issuer;

/**
 * Computes the exact frozen fields (`variableSymbol`, `orderNumber`, `note`, `amountDue`,
 * `paymentQr`) for a document inside an active SQL transaction. Used by `DeliveriesRepoSql`
 * (J3 enqueue snapshot) and `CoreStoreSql` (C3 request-log completion).
 */
export const projectDocumentFromSql = Effect.fn("projectDocumentFromSql")(function* (
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
) {
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
  if (docRow === undefined) return;

  const relRows = yield* sql<{
    readonly to_document_id: DocumentId;
    readonly relation: DocumentRelation;
  }>`
      select to_document_id, relation
      from document_relations
      where workspace_id = ${workspaceId} and from_document_id = ${documentId}
    `;
  const creditIds = Arr.map(
    Arr.filter(relRows, (r) => r.relation === "corrected_by"),
    (r) => r.to_document_id,
  );
  const creditRows =
    creditIds.length === 0
      ? []
      : yield* sql<{ readonly vat_breakdown: unknown }>`
            select vat_breakdown
            from documents
            where workspace_id = ${workspaceId} and id in ${sql.in(creditIds)}
          `;

  let amountDue = ZERO;
  if (docRow.status !== "draft" || docRow.kind === "invoice" || docRow.kind === "proforma") {
    const totals = yield* decodeTotals(docRow.vat_breakdown).pipe(Effect.orDie);
    if (docRow.status === "draft") {
      amountDue = totals.gross.amount;
    } else {
      const credits = yield* Effect.forEach(
        creditRows,
        (row) =>
          decodeTotals(row.vat_breakdown).pipe(
            Effect.map((creditTotals) => ({ totals: creditTotals })),
          ),
        { concurrency: 1 },
      ).pipe(Effect.orDie);
      amountDue = DocumentsModule.outstandingOf(
        {
          kind: docRow.kind,
          status: docRow.status,
          paidAmount: BigDecimal.fromStringUnsafe(docRow.paid_amount),
          totals,
          links: Arr.map(relRows, (row) => ({ relation: row.relation, id: row.to_document_id })),
        },
        credits,
      );
    }
  }
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
      const creditIds = Arr.map(
        Arr.filter(record.links, (link) => link.relation === "corrected_by"),
        (link) => link.id,
      );
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
      const laterEdits = Fn.pipe(
        entries,
        Arr.filter(
          (entry) =>
            entry.revision !== null && entry.revision > view.revision && entry.changes.length > 0,
        ),
        Arr.sort(
          Order.mapInput(Order.flip(Order.Number), (entry: AuditEntry) => entry.revision ?? 0),
        ),
      );
      for (const entry of laterEdits) {
        for (const change of entry.changes) {
          if (change.path === "variableSymbol") {
            variableSymbol = Option.getOrNull(nullableAuditText(change.before));
          } else if (change.path === "orderNumber") {
            orderNumber = Option.getOrNull(nullableAuditText(change.before));
          } else if (change.path === "note") {
            note = Option.getOrNull(nullableAuditText(change.before));
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
const enrichDocumentView = (
  view: DocumentView,
  storedVariableSymbol?: string | null,
  amountDue?: BigDecimal.BigDecimal,
): DocumentView => {
  if (view.paymentQr !== null || view.status === "cancelled") return view;
  const issuer = view.issuer;
  Schema.asserts(IssuerSnapshotData, issuer);
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
const enrichSharedDocumentView = (
  view: SharedDocumentView,
  storedVariableSymbol?: string | null,
): SharedDocumentView => {
  if (view.paymentQr !== null || view.status !== "issued") return view;
  const issuer = view.issuer;
  Schema.asserts(IssuerSnapshotData, issuer);
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
  readonly correctionReference?: IsoDate | undefined;
}): BlobKey => {
  const variant =
    params.correctionReference === undefined
      ? params.language
      : `${params.language}-original-${params.correctionReference}`;
  return BlobKey.make(
    `pdf/${params.workspaceId}/${params.documentId}/${params.documentRevision}/${params.workspaceRevision}/${params.template}/${variant}.pdf`,
  );
};

const toDbUnavailable = () => Unavailable.make({ dependency: "database" });

const runKeyedProjection = <A extends object, E, R>(params: {
  readonly method: string;
  readonly requestKey: string | undefined;
  readonly hasSqlRequestLog: boolean;
  readonly memoryReplays: Map<string, A>;
  readonly identityOf: (value: A) => string;
  readonly execute: Effect.Effect<A, E, R>;
  readonly project: (
    value: A,
    wasReplayed: boolean,
  ) => Effect.Effect<A, Unavailable, CurrentCaller>;
}): Effect.Effect<A, E | Unavailable, R | CurrentCaller> => {
  const { method, requestKey, hasSqlRequestLog, memoryReplays, identityOf, execute, project } =
    params;
  if (requestKey === undefined) {
    return execute.pipe(Effect.flatMap((val) => project(val, false)));
  }
  return Effect.gen(function* () {
    const existing = yield* Effect.serviceOption(RequestOutcome);
    const localFlag = yield* Ref.make(false);
    const outcome = Option.isSome(existing)
      ? existing.value
      : RequestOutcome.of({
          markReplayed: Ref.set(localFlag, true),
          replayed: Ref.get(localFlag),
        });
    const raw = yield* Option.isSome(existing)
      ? execute
      : Effect.provideService(execute, RequestOutcome, outcome);
    const wasReplayed = yield* outcome.replayed;
    const caller = yield* CurrentCaller;
    const cacheKey =
      caller._tag === "Member"
        ? `${caller.workspaceId}:${method}:${requestKey}:${identityOf(raw)}`
        : undefined;
    if (wasReplayed) {
      if (hasSqlRequestLog) return raw;
      const cached = cacheKey === undefined ? undefined : memoryReplays.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const projected = yield* project(raw, wasReplayed);
    if (!hasSqlRequestLog && cacheKey !== undefined) {
      memoryReplays.set(cacheKey, projected);
    }
    return projected;
  });
};

const projectMemberDocumentView = (
  view: DocumentView,
  documentsRepo: DocumentsRepo["Service"],
  coreStore: CoreStore["Service"],
  hasSqlRequestLog: boolean,
  wasReplayed = false,
): Effect.Effect<DocumentView, Unavailable, CurrentCaller> =>
  Effect.gen(function* () {
    if (
      view.paymentQr !== null ||
      view.status === "cancelled" ||
      view.kind === "credit_note" ||
      view.kind === "payment_tax_document" ||
      !BigDecimal.isPositive(view.totals.gross.amount)
    ) {
      return view;
    }
    const currency = view.totals.gross.currency;
    const issuer = view.issuer;
    Schema.asserts(IssuerSnapshotData, issuer);
    const iban = issuer.bankAccount?.iban ?? null;
    if ((currency !== "CZK" && currency !== "EUR") || iban === null || Str.trim(iban) === "") {
      return view;
    }
    if (wasReplayed && hasSqlRequestLog) return view;
    const outcomeOpt = yield* Effect.serviceOption(RequestOutcome);
    if (Option.isSome(outcomeOpt)) {
      const outcomeReplayed = yield* outcomeOpt.value.replayed;
      // CoreStoreSql already persisted the complete projected result (including valid null).
      if (outcomeReplayed && hasSqlRequestLog) return view;
    }
    const caller = yield* CurrentCaller;
    if (caller._tag !== "Member") {
      return enrichDocumentView(view, null);
    }
    const record = yield* documentsRepo.get(caller.workspaceId, view.id).pipe(
      Effect.catchTag("NotFound", () => Effect.undefined),
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
      const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      const hasSqlRequestLog = Option.isSome(sqlClient);
      const memoryViewReplays = new Map<string, DocumentView>();
      const memoryCancelReplays = new Map<
        string,
        { readonly document: DocumentView; readonly creditNote: DocumentView | null }
      >();

      const projectView = (view: DocumentView, wasReplayed = false) =>
        projectMemberDocumentView(view, documentsRepo, coreStore, hasSqlRequestLog, wasReplayed);

      const viewIdentity = (v: DocumentView) => `${v.id}:${v.revision}`;
      const cancelIdentity = (res: {
        readonly document: DocumentView;
        readonly creditNote: DocumentView | null;
      }) =>
        `${res.document.id}:${res.document.revision}:${res.creditNote === null ? "none" : `${res.creditNote.id}:${res.creditNote.revision}`}`;

      return Documents.of({
        ...baseDocuments,
        preview: Effect.fn("Documents.preview")((input) =>
          baseDocuments
            .preview(input)
            .pipe(Effect.map((view) => enrichDocumentView(view, input.variableSymbol ?? null))),
        ),
        createDraft: Effect.fn("Documents.createDraft")((input, opts) =>
          runKeyedProjection({
            method: "createDraft",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays: memoryViewReplays,
            identityOf: viewIdentity,
            execute: baseDocuments.createDraft(input, opts),
            project: projectView,
          }),
        ),
        issue: Effect.fn("Documents.issue")((from, opts) =>
          runKeyedProjection({
            method: "issue",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays: memoryViewReplays,
            identityOf: viewIdentity,
            execute: baseDocuments.issue(from, opts),
            project: projectView,
          }),
        ),
        edit: Effect.fn("Documents.edit")((id, patch, expectedRevision) =>
          baseDocuments
            .edit(id, patch, expectedRevision)
            .pipe(Effect.flatMap((v) => projectView(v))),
        ),
        lock: Effect.fn("Documents.lock")((id) =>
          baseDocuments.lock(id).pipe(Effect.flatMap((v) => projectView(v))),
        ),
        unlock: Effect.fn("Documents.unlock")((id, reason) =>
          baseDocuments.unlock(id, reason).pipe(Effect.flatMap((v) => projectView(v))),
        ),
        cancel: Effect.fn("Documents.cancel")((id, input, opts) =>
          runKeyedProjection({
            method: "cancel",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays: memoryCancelReplays,
            identityOf: cancelIdentity,
            execute: baseDocuments.cancel(id, input, opts),
            project: Effect.fn("Documents.projectCancellation")(function* (res, wasReplayed) {
              const document = yield* projectView(res.document, wasReplayed);
              const creditNote =
                res.creditNote === null ? null : yield* projectView(res.creditNote, wasReplayed);
              return { document, creditNote };
            }),
          }),
        ),
        correct: Effect.fn("Documents.correct")((id, input, opts) =>
          runKeyedProjection({
            method: "correct",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays: memoryViewReplays,
            identityOf: viewIdentity,
            execute: baseDocuments.correct(id, input, opts),
            project: projectView,
          }),
        ),
        issueFinalInvoice: Effect.fn("Documents.issueFinalInvoice")((proforma, input, opts) =>
          runKeyedProjection({
            method: "issueFinalInvoice",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays: memoryViewReplays,
            identityOf: viewIdentity,
            execute: baseDocuments.issueFinalInvoice(proforma, input, opts),
            project: projectView,
          }),
        ),
        previewFinalInvoice: Effect.fn("Documents.previewFinalInvoice")((proforma, input) =>
          baseDocuments
            .previewFinalInvoice(proforma, input)
            .pipe(
              Effect.map((view) => enrichDocumentView(view, input?.patch?.variableSymbol ?? null)),
            ),
        ),
        previewCorrection: Effect.fn("Documents.previewCorrection")((id, input) =>
          baseDocuments
            .previewCorrection(id, input)
            .pipe(Effect.map((view) => enrichDocumentView(view, null))),
        ),
        get: Effect.fn("Documents.get")((id) =>
          baseDocuments.get(id).pipe(Effect.flatMap((v) => projectView(v))),
        ),
        pdf: Effect.fn("Documents.pdf")((id, opts) =>
          baseDocuments
            .pdf(id, opts)
            .pipe(Effect.provideService(ExplicitPdfTemplate, opts?.template !== undefined)),
        ),
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
      const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      const hasSqlRequestLog = Option.isSome(sqlClient);
      const memoryReplays = new Map<string, DocumentView>();

      return Templates.of({
        ...baseTemplates,
        use: Effect.fn("Templates.use")((template, input, opts) =>
          runKeyedProjection({
            method: "templates.use",
            requestKey: opts?.requestKey,
            hasSqlRequestLog,
            memoryReplays,
            identityOf: (v) => `${v.id}:${v.revision}`,
            execute: baseTemplates.use(template, input, opts),
            project: (view, wasReplayed) =>
              projectMemberDocumentView(
                view,
                documentsRepo,
                coreStore,
                hasSqlRequestLog,
                wasReplayed,
              ),
          }),
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
        Effect.flatMap(
          Effect.fn("PublicShareLinks.projectOpen")(function* (view) {
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
