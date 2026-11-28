/** Public groups, no credential (http-mcp-contracts section 3.5.1). */

import {
  Conflict,
  Forbidden,
  InvitationPeek,
  InvitationToken,
  Locale,
  NotFound,
  SharedDocumentView,
  ShareToken,
  Unavailable,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { AltchaChallenge, BotScope } from "../altcha";
import { ConfigView } from "../edge";
import { RateLimited, Unauthorized } from "../edge-errors";
import { ImageBytes, PdfBytes } from "../http";
import { Authentication, EdgeGuard, SessionOnly, ShareLinkVisitor } from "../security";

export class ConfigGroup extends HttpApiGroup.make("config").add(
  HttpApiEndpoint.get("getConfig", "/config", { success: ConfigView }).annotate(
    OpenApi.Summary,
    "Get public install configuration",
  ),
) {}

export class BotProtectionGroup extends HttpApiGroup.make("botProtection").add(
  HttpApiEndpoint.get("issueChallenge", "/bot-protection/challenges/:scope", {
    params: { scope: BotScope },
    success: [AltchaChallenge, HttpApiSchema.NoContent], // 204 when the install runs Noop
    error: [RateLimited.schema, Unavailable.schema],
  }).annotate(OpenApi.Summary, "Issue a bot-protection challenge"),
) {}

const ShareParams = { token: ShareToken };

export class PublicShareGroup extends HttpApiGroup.make("publicShare")
  .add(
    HttpApiEndpoint.get("open", "/", {
      params: ShareParams,
      success: SharedDocumentView,
      error: [NotFound.schema, Unavailable.schema, Forbidden.schema, RateLimited.schema],
    }).annotate(OpenApi.Summary, "Open a shared document"),
  )
  .add(
    HttpApiEndpoint.get("pdf", "/pdf", {
      params: ShareParams,
      query: { language: Schema.optional(Locale) },
      success: PdfBytes,
      error: [NotFound.schema, Unavailable.schema, Forbidden.schema, RateLimited.schema],
    }).annotate(OpenApi.Summary, "Download a shared document's PDF"),
  )
  .add(
    HttpApiEndpoint.get("logo", "/logo", {
      params: ShareParams,
      success: ImageBytes,
      error: [NotFound.schema, Unavailable.schema, Forbidden.schema],
    }).annotate(OpenApi.Summary, "Get a shared document's logo"),
  )
  .prefix("/share/:token")
  .middleware(ShareLinkVisitor) {}

const InvitationParams = { token: InvitationToken };

export class InvitationsGroup extends HttpApiGroup.make("invitations")
  .add(
    HttpApiEndpoint.get("peek", "/invitations/:token", {
      params: InvitationParams,
      success: InvitationPeek,
      error: [NotFound.schema, RateLimited.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Preview an invitation"),
  )
  .add(
    HttpApiEndpoint.post("accept", "/invitations/:token/accept", {
      params: InvitationParams,
      success: WorkspaceSummary,
      error: [
        Unauthorized.schema,
        NotFound.schema,
        Conflict.schema,
        Unavailable.schema,
        Forbidden.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Accept an invitation")
      .middleware(SessionOnly)
      .middleware(EdgeGuard)
      .middleware(Authentication),
  ) {}
