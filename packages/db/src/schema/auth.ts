import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accessMode } from "./enums";
import { workspaces } from "./workspaces";

/**
 * Better Auth storage (http-mcp-contracts.md §2.6-2.7): core tables, passkey, apiKey and the
 * OAuth 2.1 provider. Kept in the `auth` Postgres schema because auth never enters core
 * (http-mcp-contracts.md T5) and because Better Auth's `account` is not the Kvitbit Account.
 * Ids are Better Auth's text ids. Property names equal the Better Auth 1.7.27 model field names
 * (the Drizzle adapter maps by property), and SQL columns are their snake_case forms. Kvitbit-owned additions on
 * `apikey` and `oauth_consent` (workspace_id, created_by, access, scopes) follow
 * http-mcp-contracts.md:853-858.
 */
export const authSchema = pgSchema("auth");

const at = (name: string) => timestamp(name, { withTimezone: true });

export const user = authSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    /**
     * Account deletion tombstone (http-mcp-contracts.md G10, user-flows.md Q7): a deleted account
     * is hidden at once and retained until `purge_after`.
     */
    deletedAt: at("deleted_at"),
    purgeAfter: at("purge_after"),
  },
  (t) => [
    uniqueIndex("user_email_unique").on(t.email),
    check("user_deletion_complete", sql`(${t.deletedAt} is null) = (${t.purgeAfter} is null)`),
  ],
);

export const session = authSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: at("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("session_token_unique").on(t.token),
    index("session_user_id_idx").on(t.userId),
    index("session_expires_at_idx").on(t.expiresAt),
  ],
);

export const account = authSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("account_provider_account_unique").on(t.providerId, t.accountId),
    index("account_user_id_idx").on(t.userId),
  ],
);

export const verification = authSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("verification_identifier_idx").on(t.identifier),
    index("verification_expires_at_idx").on(t.expiresAt),
  ],
);

export const rateLimit = authSchema.table(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("rate_limit_key_unique").on(t.key)],
);

/** WebAuthn credentials of the passkey plugin (flow 1.5). */
export const passkey = authSchema.table(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: at("created_at").defaultNow(),
  },
  (t) => [
    index("passkey_user_id_idx").on(t.userId),
    uniqueIndex("passkey_credential_id_unique").on(t.credentialID),
  ],
);

/**
 * API Keys (`kvb_<key id>_<secret>`, http-mcp-contracts.md:64-79). Better Auth apiKey plugin
 * storage: `key` is the secret hash, `prefix`/`start` are display text, `reference_id` is the
 * creator's user id. Kvitbit adds the Workspace binding, the creator, and the granted access.
 */
export const apikey = authSchema.table(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: at("last_refill_at"),
    enabled: boolean("enabled").notNull().default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").notNull().default(0),
    remaining: integer("remaining"),
    lastRequest: at("last_request"),
    expiresAt: at("expires_at"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    access: accessMode("access").notNull(),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    uniqueIndex("apikey_key_unique").on(t.key),
    index("apikey_reference_id_idx").on(t.referenceId),
    index("apikey_workspace_created_by_idx").on(t.workspaceId, t.createdBy),
    check("apikey_scopes_nonempty", sql`cardinality(${t.scopes}) > 0`),
  ],
);

/** Registered OAuth 2.1 clients (dynamic client registration, flow 10.8). */
export const oauthClient = authSchema.table(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes").array(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    uniqueIndex("oauth_client_client_id_unique").on(t.clientId),
    index("oauth_client_user_id_idx").on(t.userId),
  ],
);

/**
 * Consent records. One row is one MCP grant (http-mcp-contracts.md:1282): one client, one
 * Member, one Workspace. `scopes` holds the OAuth wire scopes; `granted_scopes` the expanded
 * core `Scope[]` with its `access` mode.
 */
export const oauthConsent = authSchema.table(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    access: accessMode("access"),
    grantedScopes: text("granted_scopes").array(),
    lastUsedAt: at("last_used_at"),
  },
  (t) => [
    index("oauth_consent_client_id_idx").on(t.clientId),
    index("oauth_consent_user_id_idx").on(t.userId),
    uniqueIndex("oauth_consent_grant_unique").on(t.clientId, t.userId, t.workspaceId),
    index("oauth_consent_workspace_id_idx").on(t.workspaceId),
    check(
      "oauth_consent_grant_complete",
      sql`(${t.workspaceId} is null) = (${t.access} is null) and (${t.workspaceId} is null) = (${t.grantedScopes} is null)`,
    ),
    check(
      "oauth_consent_grant_bound",
      sql`${t.workspaceId} is null or (${t.userId} is not null and cardinality(${t.grantedScopes}) > 0)`,
    ),
  ],
);

/** Opaque refresh tokens; rotated on use. */
export const oauthRefreshToken = authSchema.table(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    consentId: text("consent_id").references(() => oauthConsent.id, { onDelete: "cascade" }),
    resources: text("resources").array(),
    scopes: text("scopes").array().notNull(),
    expiresAt: at("expires_at"),
    createdAt: at("created_at"),
    revoked: at("revoked"),
    /** Refresh rotation replay window (http-mcp-contracts.md:1268): the first rotation's response. */
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authorizationCodeId: text("authorization_code_id"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    confirmation: jsonb("confirmation"),
    authTime: at("auth_time"),
  },
  (t) => [
    uniqueIndex("oauth_refresh_token_token_unique").on(t.token),
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
    index("oauth_refresh_token_consent_id_idx").on(t.consentId),
  ],
);

/** Opaque access tokens (audience `https://<host>/mcp`), stored for revocation. */
export const oauthAccessToken = authSchema.table(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    consentId: text("consent_id").references(() => oauthConsent.id, { onDelete: "cascade" }),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    resources: text("resources").array(),
    scopes: text("scopes").array().notNull(),
    expiresAt: at("expires_at"),
    createdAt: at("created_at"),
    revoked: at("revoked"),
    authorizationCodeId: text("authorization_code_id"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    confirmation: jsonb("confirmation"),
  },
  (t) => [
    uniqueIndex("oauth_access_token_token_unique").on(t.token),
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_consent_id_idx").on(t.consentId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

/** Protected resources (the `/mcp` audience) and their token policy. */
export const oauthResource = authSchema.table(
  "oauth_resource",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes").array(),
    customClaims: jsonb("custom_claims"),
    dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
    disabled: boolean("disabled").default(false),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    policyVersion: integer("policy_version").default(1),
    metadata: jsonb("metadata"),
  },
  (t) => [uniqueIndex("oauth_resource_identifier_unique").on(t.identifier)],
);

/** Which protected resources a client may request. */
export const oauthClientResource = authSchema.table(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: at("created_at"),
  },
  (t) => [uniqueIndex("oauth_client_resource_pair_unique").on(t.clientId, t.resourceId)],
);

/** Single-use ids of client assertions (private_key_jwt), kept until they expire. */
export const oauthClientAssertion = authSchema.table("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
});
