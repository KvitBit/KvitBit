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
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AltchaChallenge, BotScope } from "../altcha";
import { ConfigView } from "../edge";
import { RateLimited, Unauthorized } from "../edge-errors";
import { ImageBytes, PdfBytes } from "../http";
import { Authentication, SessionOnly, ShareLinkVisitor } from "../security";

export class ConfigGroup extends HttpApiGroup.make("config").add(
  HttpApiEndpoint.get("getConfig", "/config", { success: ConfigView }),
) {}

export class BotProtectionGroup extends HttpApiGroup.make("botProtection").add(
  HttpApiEndpoint.get("issueChallenge", "/bot-protection/challenges/:scope", {
    params: { scope: BotScope },
    success: [AltchaChallenge, HttpApiSchema.NoContent], // 204 when the install runs Noop
    error: [RateLimited.schema, Unavailable.schema],
  }),
) {}

const ShareParams = { token: ShareToken };

export class PublicShareGroup extends HttpApiGroup.make("publicShare")
  .add(
    HttpApiEndpoint.get("open", "/", {
      params: ShareParams,
      success: SharedDocumentView,
      error: [NotFound.schema, RateLimited.schema],
    }),
  )
  .add(
    HttpApiEndpoint.get("pdf", "/pdf", {
      params: ShareParams,
      query: { language: Schema.optional(Locale) },
      success: PdfBytes,
      error: [NotFound.schema, Unavailable.schema, RateLimited.schema],
    }),
  )
  .add(
    HttpApiEndpoint.get("logo", "/logo", {
      params: ShareParams,
      success: ImageBytes,
      error: NotFound.schema,
    }),
  )
  .prefix("/share/:token")
  .middleware(ShareLinkVisitor) {}

const InvitationParams = { token: InvitationToken };

export class InvitationsGroup extends HttpApiGroup.make("invitations")
  .add(
    HttpApiEndpoint.get("peek", "/invitations/:token", {
      params: InvitationParams,
      success: InvitationPeek,
      error: [NotFound.schema, RateLimited.schema],
    }),
  )
  .add(
    HttpApiEndpoint.post("accept", "/invitations/:token/accept", {
      params: InvitationParams,
      success: WorkspaceSummary,
      error: [Unauthorized.schema, NotFound.schema, Conflict.schema, Forbidden.schema],
    })
      .middleware(Authentication)
      .middleware(SessionOnly),
  ) {}
