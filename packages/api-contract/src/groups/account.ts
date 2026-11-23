/** Account groups (http-mcp-contracts section 3.5.2). */

import {
  Forbidden,
  Invalid,
  NewWorkspace,
  NotFound,
  RegistryResult,
  Unavailable,
  WorkspaceSummary,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ConsentDecision, ConsentResult, ConsentView } from "../edge";
import { RateLimited, RevisionedEdgeErrors } from "../edge-errors";
import { Created, IdempotencyHeaders, IfMatchHeaders, Revisioned } from "../http";
import { Authentication, SessionOnly } from "../security";
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
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("updatePreferences", "/me/preferences", {
      headers: IfMatchHeaders,
      payload: AccountPreferencesPatch,
      success: AccountPreferences,
      error: [Invalid.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .middleware(Authentication)
  .middleware(SessionOnly) {}

export class MyWorkspacesGroup extends HttpApiGroup.make("myWorkspaces")
  .add(HttpApiEndpoint.get("listMine", "/workspaces", { success: Schema.Array(WorkspaceSummary) }))
  .add(
    HttpApiEndpoint.post("create", "/workspaces", {
      headers: IdempotencyHeaders,
      payload: NewWorkspace,
      success: Created(WorkspaceView),
      error: [Invalid.schema, Unavailable.schema, Forbidden.schema],
    }).annotate(Revisioned, true),
  )
  .middleware(Authentication)
  .middleware(SessionOnly) {}

const ConsentParams = { consentId: Schema.NonEmptyString };

export class OAuthConsentGroup extends HttpApiGroup.make("oauthConsent")
  .add(
    HttpApiEndpoint.get("getConsent", "/oauth/consents/:consentId", {
      params: ConsentParams,
      success: ConsentView,
      error: NotFound.schema,
    }),
  )
  .add(
    HttpApiEndpoint.post("decide", "/oauth/consents/:consentId", {
      params: ConsentParams,
      payload: ConsentDecision,
      success: ConsentResult,
      error: [NotFound.schema, Invalid.schema, Forbidden.schema],
    }),
  )
  .middleware(Authentication)
  .middleware(SessionOnly) {}

/** Pure lookup: any session or API Key (no SessionOnly). */
export class RegistryGroup extends HttpApiGroup.make("registry")
  .add(
    HttpApiEndpoint.get("lookupCompany", "/registry/companies/:ico", {
      params: { ico: Schema.NonEmptyString }, // checksum is core's (Invalid{ico.checksum})
      success: RegistryResult,
      error: [Invalid.schema, NotFound.schema, Unavailable.schema, RateLimited.schema],
    }),
  )
  .middleware(Authentication) {}

/** Pure lookup: any session or API Key (no SessionOnly). */
export class ThemesGroup extends HttpApiGroup.make("themes")
  .add(
    HttpApiEndpoint.post("resolve", "/themes/resolve", {
      payload: ThemeResolveRequest,
      success: ResolvedTheme,
      error: [Invalid.schema, RateLimited.schema],
    }),
  )
  .middleware(Authentication) {}
