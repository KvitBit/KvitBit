/**
 * Edge-owned views (http-mcp-contracts sections 3.5 and 5): data that lives in apps/server or
 * Better Auth rather than core. InvitationPeek, WorkspaceSummary and the other core views come
 * from `@kvitbit/domain/contract`.
 */

import {
  ImageRef,
  IsoDate,
  PdfTemplate,
  Role,
  Scope,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import {
  AccessMode,
  AccessPreset,
  AccessRequest,
  GrantedAccess,
  isGrantedAccessConsistent,
} from "./access";
import { ApiKeyId, ApiKeyToken } from "./api-key";
import { Hex, ResolvedTheme, ThemeSource } from "./theme";

/** `GET /api/v1/config` (rule B5, section 3.4). */
export const ConfigView = Schema.Struct({
  version: Schema.String,
  botProtection: Schema.Literals(["altcha", "none"]),
  uploads: Schema.Struct({
    attachment: Schema.Struct({ maxBytes: Schema.Int, types: Schema.Array(Schema.String) }),
    brandingImage: Schema.Struct({ maxBytes: Schema.Int, types: Schema.Array(Schema.String) }),
    themeJson: Schema.Struct({ maxBytes: Schema.Int }),
  }),
  features: Schema.Struct({
    signUp: Schema.Boolean,
    mcp: Schema.Boolean,
    apiKeys: Schema.Boolean,
  }),
  analytics: Schema.optional(
    Schema.Struct({
      posthog: Schema.NullOr(
        Schema.Struct({
          apiKey: Schema.NonEmptyString,
          host: Schema.NonEmptyString,
        }),
      ),
    }),
  ),
});
export type ConfigView = typeof ConfigView.Type;

/** Workspace branding with its resolved theme; `revision` is the Workspace revision. */
export const BrandingView = Schema.Struct({
  pdfTemplate: PdfTemplate,
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(ThemeSource),
  resolvedTheme: Schema.NullOr(ResolvedTheme),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
  revision: Schema.Int,
});
export type BrandingView = typeof BrandingView.Type;

// --- API Keys (flow 10.7) ----------------------------------------------------------------------

export const ApiKeyView = Schema.Struct({
  id: ApiKeyId,
  name: Schema.String,
  prefix: Schema.String, // "kvb_<key id>", shown so users can tell keys apart
  ...GrantedAccess.fields,
  createdBy: Schema.Struct({ userId: UserId, name: Schema.String }),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
}).pipe(Schema.check(isGrantedAccessConsistent));
export type ApiKeyView = typeof ApiKeyView.Type;

/** The secret is the full `kvb_<key id>_<secret>` bearer value, returned once. */
export const ApiKeyCreated = Schema.Struct({ key: ApiKeyView, secret: ApiKeyToken });
export type ApiKeyCreated = typeof ApiKeyCreated.Type;

const ApiKeyFields = { name: Schema.NonEmptyString, expiresOn: Schema.optional(IsoDate) };
/** AccessRequest (section 2.2) plus name and expiry. Scopes are capped by the creator's role. */
export const ApiKeyCreate = Schema.Union([
  Schema.Struct({ ...ApiKeyFields, access: AccessPreset }),
  Schema.Struct({
    ...ApiKeyFields,
    access: Schema.Literal("custom"),
    scopes: Schema.NonEmptyArray(Scope),
  }),
]);
export type ApiKeyCreate = typeof ApiKeyCreate.Type;

// --- Connected apps and OAuth consent (flows 10.8, 10.9) ---------------------------------------

export const ConnectedAppView = Schema.Struct({
  grantId: Schema.String,
  client: Schema.Struct({ id: Schema.String, name: Schema.String, redirectHost: Schema.String }),
  member: Schema.Struct({ userId: UserId, name: Schema.String }),
  ...GrantedAccess.fields,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
}).pipe(Schema.check(isGrantedAccessConsistent));
export type ConnectedAppView = typeof ConnectedAppView.Type;

export const ConsentWorkspace = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  role: Role,
  maxAccess: AccessPreset, // accountant: read
  grantableScopes: Schema.Array(Scope), // role cap per area
  offerableScopes: Schema.Array(Scope), // requestedScopes ∩ grantableScopes; the picker's ceiling
});
export type ConsentWorkspace = typeof ConsentWorkspace.Type;

export const ConsentView = Schema.Struct({
  client: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    redirectHost: Schema.String,
    logoUri: Schema.NullOr(Schema.String),
  }),
  requestedAccess: AccessMode,
  requestedScopes: Schema.Array(Scope),
  workspaces: Schema.Array(ConsentWorkspace),
});
export type ConsentView = typeof ConsentView.Type;

export const ConsentDecision = Schema.Union([
  Schema.TaggedStruct("Approve", { workspace: WorkspaceId, grant: AccessRequest }),
  Schema.TaggedStruct("Deny", {}),
]);
export type ConsentDecision = typeof ConsentDecision.Type;

export const ConsentResult = Schema.Struct({ redirectTo: Schema.String });
export type ConsentResult = typeof ConsentResult.Type;

// --- Android releases (section 5) --------------------------------------------------------------

export const ReleaseInfo = Schema.Struct({
  version: Schema.String,
  versionCode: Schema.Int,
  releasedAt: Schema.String,
  apkUrl: Schema.String,
  apkSha256: Schema.String,
  sizeBytes: Schema.Int,
  signingCertSha256: Schema.String,
  minAndroidSdk: Schema.Int,
  obtainiumUrl: Schema.String,
});
export type ReleaseInfo = typeof ReleaseInfo.Type;
