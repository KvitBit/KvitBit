/** Account groups (http-mcp-contracts section 3.5.2). */

import {
  Conflict,
  Forbidden,
  Invalid,
  NewWorkspace,
  NotFound,
  RegistryResult,
  Unavailable,
  WorkspaceSummary,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { ConsentDecision, ConsentResult, ConsentView } from "../edge";
import { RateLimited, RevisionedEdgeErrors } from "../edge-errors";
import { Created, IdempotencyHeaders, IfMatchHeaders, Revisioned } from "../http";
import { Authentication, EdgeGuard, SessionOnly } from "../security";
import {
  AccountPreferences,
  AccountPreferencesPatch,
  ResolvedTheme,
  ThemeResolveRequest,
} from "../theme";

export class MeGroup extends HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("getPreferences", "/me/preferences", {
      success: AccountPreferences,
    })
      .annotate(OpenApi.Summary, "Get account preferences")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("updatePreferences", "/me/preferences", {
      headers: IfMatchHeaders,
      payload: AccountPreferencesPatch,
      success: AccountPreferences,
      error: [Invalid.schema, ...RevisionedEdgeErrors],
    })
      .annotate(OpenApi.Summary, "Update account preferences")
      .annotate(Revisioned, true),
  )
  .middleware(SessionOnly)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

export class MyWorkspacesGroup extends HttpApiGroup.make("myWorkspaces")
  .add(
    HttpApiEndpoint.get("listMine", "/workspaces", {
      success: Schema.Array(WorkspaceSummary),
      error: [Unavailable.schema, Forbidden.schema],
    }).annotate(OpenApi.Summary, "List my workspaces"),
  )
  .add(
    HttpApiEndpoint.post("create", "/workspaces", {
      headers: IdempotencyHeaders,
      payload: NewWorkspace,
      success: Created(WorkspaceView),
      error: [Invalid.schema, Unavailable.schema, Forbidden.schema, Conflict.schema],
    })
      .annotate(OpenApi.Summary, "Create a workspace")
      .annotate(Revisioned, true),
  )
  .middleware(SessionOnly)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

const ConsentParams = { consentId: Schema.NonEmptyString };

export class OAuthConsentGroup extends HttpApiGroup.make("oauthConsent")
  .add(
    HttpApiEndpoint.get("getConsent", "/oauth/consents/:consentId", {
      params: ConsentParams,
      success: ConsentView,
      error: [NotFound.schema, Unavailable.schema, Forbidden.schema],
    }).annotate(OpenApi.Summary, "Get an OAuth consent request"),
  )
  .add(
    HttpApiEndpoint.post("decide", "/oauth/consents/:consentId", {
      params: ConsentParams,
      payload: ConsentDecision,
      success: ConsentResult,
      error: [NotFound.schema, Invalid.schema, Unavailable.schema, Forbidden.schema],
    }).annotate(OpenApi.Summary, "Approve or deny an OAuth consent request"),
  )
  .middleware(SessionOnly)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

/** Pure lookup: any session or API Key (no SessionOnly). */
export class RegistryGroup extends HttpApiGroup.make("registry")
  .add(
    HttpApiEndpoint.get("lookupCompany", "/registry/companies/:ico", {
      params: { ico: Schema.NonEmptyString }, // checksum is core's (Invalid{ico.checksum})
      success: RegistryResult,
      error: [
        Invalid.schema,
        NotFound.schema,
        Unavailable.schema,
        RateLimited.schema,
        Forbidden.schema,
      ],
    }).annotate(OpenApi.Summary, "Look up a company by IČO"),
  )
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

/** Pure lookup: any session or API Key (no SessionOnly). */
export class ThemesGroup extends HttpApiGroup.make("themes")
  .add(
    HttpApiEndpoint.post("resolve", "/themes/resolve", {
      payload: ThemeResolveRequest,
      success: ResolvedTheme,
      error: [Invalid.schema, RateLimited.schema],
    }).annotate(OpenApi.Summary, "Resolve a theme"),
  )
  .middleware(EdgeGuard)
  .middleware(Authentication) {}
