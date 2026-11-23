/** Workspace administration groups (http-mcp-contracts section 3.5.3). */

import {
  BankAccountId,
  BankAccountInput,
  BankAccountView,
  BrandingImage,
  BrandingPatch,
  Conflict,
  DocumentKind,
  ImageRef,
  Invalid,
  InvitationId,
  InvitationRole,
  InvitationView,
  IssuingEntityPatch,
  Locale,
  MemberView,
  NumberingSeriesId,
  NumberingSeriesView,
  Unavailable,
  UserId,
  WorkspaceSettingsPatch,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { ApiKeyId } from "../api-key";
import { ApiKeyCreate, ApiKeyCreated, ApiKeyView, BrandingView, ConnectedAppView } from "../edge";
import { PayloadTooLarge, RateLimited, RevisionedEdgeErrors, Unauthorized } from "../edge-errors";
import {
  AcceptedEmpty,
  BrandingImagePayload,
  Created,
  IdempotencyHeaders,
  IfMatchHeaders,
  ImageBytes,
  NoContent,
  PdfBytes,
  Revisioned,
} from "../http";
import { Authentication, SessionOnly, WorkspaceMember } from "../security";
import { WorkspaceParams } from "./shared";

/** `Workspaces.configureSeries` input without the id (the id travels in the path). */
export const SeriesInput = Schema.Struct({
  kind: DocumentKind,
  name: Schema.NonEmptyString,
  pattern: Schema.NonEmptyString, // tokens: YYYY YY MM N…; e.g. "YYYY-NNNN"
  nextNumber: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  isDefault: Schema.optional(Schema.Boolean),
});
export type SeriesInput = typeof SeriesInput.Type;

export const CloseWorkspaceInput = Schema.Struct({ confirmName: Schema.String });
export const SetRoleInput = Schema.Struct({ role: InvitationRole });
export const InviteInput = Schema.Struct({ email: Schema.NonEmptyString, role: InvitationRole });
export const TransferOwnershipInput = Schema.Struct({ to: UserId });
export const BrandingPreviewInput = Schema.Struct({
  branding: BrandingPatch,
  kind: DocumentKind,
  language: Locale,
});

const BankAccountParams = { ...WorkspaceParams, bankAccountId: BankAccountId };
const SeriesParams = { ...WorkspaceParams, seriesId: NumberingSeriesId };

export class WorkspaceGroup extends HttpApiGroup.make("workspace")
  .add(
    HttpApiEndpoint.get("current", "/", {
      params: WorkspaceParams,
      success: WorkspaceView,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("updateIssuingEntity", "/issuing-entity", {
      params: WorkspaceParams,
      headers: IfMatchHeaders,
      payload: IssuingEntityPatch,
      success: WorkspaceView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("updateSettings", "/settings", {
      params: WorkspaceParams,
      headers: IfMatchHeaders,
      payload: WorkspaceSettingsPatch,
      success: WorkspaceView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("listBankAccounts", "/bank-accounts", {
      params: WorkspaceParams,
      success: Schema.Array(BankAccountView),
    }),
  )
  .add(
    HttpApiEndpoint.post("createBankAccount", "/bank-accounts", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: BankAccountInput,
      success: Created(BankAccountView),
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.put("updateBankAccount", "/bank-accounts/:bankAccountId", {
      params: BankAccountParams,
      payload: BankAccountInput,
      success: BankAccountView,
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeBankAccount", "/bank-accounts/:bankAccountId", {
      params: BankAccountParams,
      query: { replacement: Schema.optional(BankAccountId) },
      success: NoContent,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("listSeries", "/numbering-series", {
      params: WorkspaceParams,
      success: Schema.Array(NumberingSeriesView),
    }),
  )
  .add(
    HttpApiEndpoint.post("createSeries", "/numbering-series", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: SeriesInput,
      success: Created(NumberingSeriesView),
      error: [Invalid.schema, Conflict.schema],
    }),
  )
  .add(
    HttpApiEndpoint.put("updateSeries", "/numbering-series/:seriesId", {
      params: SeriesParams,
      payload: SeriesInput,
      success: NumberingSeriesView,
      error: [Invalid.schema, Conflict.schema],
    }),
  )
  .add(
    HttpApiEndpoint.post("close", "/close", {
      params: WorkspaceParams,
      payload: CloseWorkspaceInput,
      success: NoContent,
      error: [Invalid.schema, Unauthorized.schema], // fresh session required (rule A6)
    }),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication)
  .middleware(WorkspaceMember)
  .annotate(
    OpenApi.Description,
    "Issuing Entity, Tax Regime, defaults, bank accounts and Numbering Series",
  ) {}

const MemberParams = { ...WorkspaceParams, userId: UserId };
const InvitationParams = { ...WorkspaceParams, invitationId: InvitationId };

export class TeamGroup extends HttpApiGroup.make("team")
  .add(
    HttpApiEndpoint.get("listMembers", "/members", {
      params: WorkspaceParams,
      success: Schema.Array(MemberView),
    }),
  )
  .add(
    HttpApiEndpoint.put("setRole", "/members/:userId/role", {
      params: MemberParams,
      payload: SetRoleInput,
      success: NoContent,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/members/:userId", {
      params: MemberParams,
      success: NoContent,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.post("leave", "/members/me/leave", {
      params: WorkspaceParams,
      success: NoContent,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("listInvitations", "/invitations", {
      params: WorkspaceParams,
      success: Schema.Array(InvitationView),
    }),
  )
  .add(
    HttpApiEndpoint.post("invite", "/invitations", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: InviteInput,
      success: Created(InvitationView),
      error: [Invalid.schema, Conflict.schema],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeInvitation", "/invitations/:invitationId", {
      params: InvitationParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("resendInvitation", "/invitations/:invitationId/resend", {
      params: InvitationParams,
      success: AcceptedEmpty,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.post("transferOwnership", "/ownership-transfer", {
      params: WorkspaceParams,
      payload: TransferOwnershipInput,
      success: NoContent,
      error: [Conflict.schema, Unauthorized.schema], // fresh session required (rule A6)
    }),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

const ImageParams = { ...WorkspaceParams, image: BrandingImage };

export class BrandingGroup extends HttpApiGroup.make("branding")
  .add(
    HttpApiEndpoint.get("getBranding", "/", {
      params: WorkspaceParams,
      success: BrandingView,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("updateBranding", "/", {
      params: WorkspaceParams,
      headers: IfMatchHeaders,
      payload: BrandingPatch,
      success: BrandingView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("previewPdf", "/preview-pdf", {
      params: WorkspaceParams,
      payload: BrandingPreviewInput,
      success: PdfBytes,
      error: [Invalid.schema, Unavailable.schema, RateLimited.schema],
    }),
  )
  .add(
    HttpApiEndpoint.put("putImage", "/:image", {
      params: ImageParams,
      payload: BrandingImagePayload,
      success: ImageRef,
      error: [Invalid.schema, PayloadTooLarge.schema, Unavailable.schema],
    }),
  )
  .add(
    HttpApiEndpoint.get("getImage", "/:image", {
      params: ImageParams,
      success: ImageBytes,
      error: Unavailable.schema,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeImage", "/:image", { params: ImageParams, success: NoContent }),
  )
  .prefix("/workspaces/:workspaceId/branding")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys")
  .add(
    HttpApiEndpoint.get("listApiKeys", "/", {
      params: WorkspaceParams,
      success: Schema.Array(ApiKeyView),
    }),
  )
  .add(
    // No Idempotency-Key: a replay would have to store the secret.
    HttpApiEndpoint.post("createApiKey", "/", {
      params: WorkspaceParams,
      payload: ApiKeyCreate,
      success: Created(ApiKeyCreated),
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeApiKey", "/:keyId", {
      params: { ...WorkspaceParams, keyId: ApiKeyId },
      success: NoContent,
    }),
  )
  .prefix("/workspaces/:workspaceId/api-keys")
  .middleware(Authentication)
  .middleware(SessionOnly)
  .middleware(WorkspaceMember) {}

export class ConnectedAppsGroup extends HttpApiGroup.make("connectedApps")
  .add(
    HttpApiEndpoint.get("listConnectedApps", "/", {
      params: WorkspaceParams,
      success: Schema.Array(ConnectedAppView),
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeConnectedApp", "/:grantId", {
      params: { ...WorkspaceParams, grantId: Schema.NonEmptyString },
      success: NoContent,
    }),
  )
  .prefix("/workspaces/:workspaceId/connected-apps")
  .middleware(Authentication)
  .middleware(SessionOnly)
  .middleware(WorkspaceMember) {}
