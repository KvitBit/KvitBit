/** Documents and share links (http-mcp-contracts section 3.5.4). */

import {
  AuditEntry,
  Conflict,
  DeliveryId,
  DeliveryPurpose,
  DocumentId,
  DocumentInput,
  DocumentPatch,
  DocumentQuery,
  DocumentSummary,
  DocumentView,
  Invalid,
  IsoDate,
  LineId,
  Locale,
  NotFound,
  Page,
  PdfTemplate,
  ShareViewEvent,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { RevisionedEdgeErrors } from "../edge-errors";
import {
  Accepted,
  Created,
  Disposition,
  IdempotencyHeaders,
  IfMatchHeaders,
  NoContent,
  PageQueryFields,
  PdfBytes,
  Revisioned,
  WriteHeaders,
} from "../http";
import { Authentication, EdgeGuard, WorkspaceMember } from "../security";
import { CoreErrors, WorkspaceParams } from "./shared";

const DocParams = { ...WorkspaceParams, documentId: DocumentId };

/** Core `SendOptions`; `purpose` defaults to "document" (G11). */
export const SendInput = Schema.Struct({
  to: Schema.String.pipe(Schema.Array, Schema.optionalKey),
  language: Schema.optionalKey(Locale),
  reminders: Schema.optionalKey(Schema.Boolean), // absent: Document → Contact → Workspace (rule D16)
  purpose: Schema.optionalKey(DeliveryPurpose),
});
export type SendInput = typeof SendInput.Type;

/** @public Query fields for the document PDF endpoint. */
export const PdfQuery = {
  template: Schema.optional(PdfTemplate),
  language: Schema.optional(Locale),
  disposition: Schema.optional(Disposition),
};

export const CancelInput = Schema.Struct({
  reason: Schema.NonEmptyString,
  on: Schema.optionalKey(IsoDate),
});
/** @public Response schema for document cancellation. */
export const CancelResult = Schema.Struct({
  document: DocumentView,
  creditNote: Schema.NullOr(DocumentView),
});
export type CancelResult = typeof CancelResult.Type;

/** Core `CorrectionInput["lines"]`: the whole document, or selected lines. */
export const CorrectionLines = Schema.Union([
  Schema.Literal("full"),
  Schema.Array(
    Schema.Struct({
      line: LineId,
      quantity: Schema.optionalKey(Schema.BigDecimal),
      unitPrice: Schema.optionalKey(Schema.BigDecimal),
    }),
  ),
]);
/** Core `CorrectionInput`. */
export const CorrectionInput = Schema.Struct({
  reason: Schema.NonEmptyString,
  lines: CorrectionLines,
  correctedOn: Schema.optionalKey(IsoDate),
});
export type CorrectionInput = typeof CorrectionInput.Type;

export const IssueFromInputPayload = Schema.Struct({
  input: DocumentInput,
  send: Schema.optionalKey(SendInput),
});
export const IssueDraftPayload = Schema.Struct({ send: Schema.optionalKey(SendInput) });
export const UnlockInput = Schema.Struct({ reason: Schema.NonEmptyString });
export const FinalInvoiceInput = Schema.Struct({ patch: Schema.optionalKey(DocumentPatch) });
export const DeliveryQueued = Schema.Struct({
  deliveryId: DeliveryId,
  status: Schema.Literal("queued"),
});
export type DeliveryQueued = typeof DeliveryQueued.Type;

export class DocumentsGroup extends HttpApiGroup.make("documents")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: WorkspaceParams,
      query: { ...DocumentQuery.fields, ...PageQueryFields },
      success: Page(DocumentSummary),
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "List documents"),
  )
  .add(
    HttpApiEndpoint.post("preview", "/preview", {
      params: WorkspaceParams,
      payload: DocumentInput,
      success: DocumentView,
      error: [Invalid.schema, NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Preview a document without saving it"),
  )
  .add(
    HttpApiEndpoint.post("createDraft", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: DocumentInput,
      success: Created(DocumentView),
      error: [Invalid.schema, NotFound.schema, Unavailable.schema, Conflict.schema],
    })
      .annotate(OpenApi.Summary, "Create a draft document")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("issueFromInput", "/issue", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: IssueFromInputPayload,
      success: Created(DocumentView),
      error: CoreErrors,
    })
      .annotate(OpenApi.Summary, "Issue a document directly")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("get", "/:documentId", {
      params: DocParams,
      success: DocumentView,
      error: [NotFound.schema, Unavailable.schema],
    })
      .annotate(OpenApi.Summary, "Get a document")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("edit", "/:documentId", {
      params: DocParams,
      headers: IfMatchHeaders,
      payload: DocumentPatch,
      success: DocumentView,
      error: [...CoreErrors, ...RevisionedEdgeErrors],
    })
      .annotate(OpenApi.Summary, "Edit a document")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.delete("discardDraft", "/:documentId", {
      params: DocParams,
      headers: IfMatchHeaders,
      success: NoContent,
      error: [Conflict.schema, ...RevisionedEdgeErrors, NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Discard a draft"),
  )
  .add(
    HttpApiEndpoint.post("issueDraft", "/:documentId/issue", {
      params: DocParams,
      headers: WriteHeaders,
      payload: IssueDraftPayload,
      success: DocumentView,
      error: [...CoreErrors, ...RevisionedEdgeErrors],
    })
      .annotate(OpenApi.Summary, "Issue a draft")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("lock", "/:documentId/lock", {
      params: DocParams,
      success: DocumentView,
      error: [Conflict.schema, NotFound.schema, Unavailable.schema],
    })
      .annotate(OpenApi.Summary, "Lock a document")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("unlock", "/:documentId/unlock", {
      params: DocParams,
      payload: UnlockInput,
      success: DocumentView,
      error: [Conflict.schema, Invalid.schema, NotFound.schema, Unavailable.schema],
    })
      .annotate(OpenApi.Summary, "Unlock a document")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/:documentId/cancel", {
      params: DocParams,
      headers: IdempotencyHeaders,
      payload: CancelInput,
      success: CancelResult,
      error: CoreErrors,
    }).annotate(OpenApi.Summary, "Cancel a document"),
  )
  .add(
    HttpApiEndpoint.post("correct", "/:documentId/credit-notes", {
      params: DocParams,
      headers: IdempotencyHeaders,
      payload: CorrectionInput,
      success: Created(DocumentView),
      error: CoreErrors,
    })
      .annotate(OpenApi.Summary, "Issue a credit note")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("issueFinalInvoice", "/:documentId/final-invoice", {
      params: DocParams,
      headers: IdempotencyHeaders,
      payload: FinalInvoiceInput,
      success: Created(DocumentView),
      error: CoreErrors,
    })
      .annotate(OpenApi.Summary, "Issue the final invoice for a proforma")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("send", "/:documentId/deliveries", {
      params: DocParams,
      headers: IdempotencyHeaders,
      payload: SendInput,
      success: Accepted(DeliveryQueued),
      error: [NotFound.schema, Conflict.schema, Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Send a document by email"),
  )
  .add(
    HttpApiEndpoint.get("pdf", "/:documentId/pdf", {
      params: DocParams,
      query: PdfQuery,
      success: PdfBytes,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Download a document's PDF"),
  )
  .add(
    HttpApiEndpoint.get("history", "/:documentId/history", {
      params: DocParams,
      success: Schema.Array(AuditEntry),
      error: [NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Get a document's history"),
  )
  .prefix("/workspaces/:workspaceId/documents")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication)
  .annotate(OpenApi.Description, "Invoices, Proformas, Payment Tax Documents and Credit Notes") {}

const ShareLinkCreated = Schema.Struct({ url: Schema.String });

export class ShareLinksGroup extends HttpApiGroup.make("shareLinks")
  .add(
    HttpApiEndpoint.put("create", "/", {
      params: DocParams,
      success: ShareLinkCreated,
      error: [Conflict.schema, NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Create or replace a share link"),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/", {
      params: DocParams,
      success: NoContent,
      error: [NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Revoke a share link"),
  )
  .add(
    HttpApiEndpoint.get("views", "/views", {
      params: DocParams,
      query: PageQueryFields,
      success: Page(ShareViewEvent),
      error: [Invalid.schema, NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "List share link views"),
  )
  .prefix("/workspaces/:workspaceId/documents/:documentId/share-link")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}
