/**
 * Better Auth configuration (http-mcp-contracts sections 2.1, 2.5-2.7, 6.2).
 *
 * `makeAuth` builds the instance apps/server mounts at `/api/auth/*`: email and password with
 * required verification, magic link, passkeys, `bearer` sessions for the mobile client, email
 * change and guarded account deletion, the `apiKey` plugin as storage for `kvb_` keys with none
 * of its routes exposed, and the OAuth 2.1 provider for MCP (opaque tokens, PKCE S256, required
 * `state` and `resource`, the `kvitbit:` scopes). Every row id is a UUIDv7. The bot-protected
 * endpoints of section 2.6 get an ALTCHA check, then a per-email rate limit, before anything else.
 *
 * Not wired yet, because their packages are not dependencies: the `expo` plugin (section 2.7)
 * and Client ID Metadata Documents (`@better-auth/cimd`, section 6.2 step 4). Discovery
 * therefore does not advertise `client_id_metadata_document_supported`, and dynamic client
 * registration is the only registration path.
 */
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import {
  type BotScope,
  OAUTH_OFFLINE_ACCESS,
  OAUTH_SCOPE_PREFIX,
  SCOPE_AREAS,
} from "@kvitbit/api-contract";
import {
  account,
  apikey,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  passkey as passkeyTable,
  rateLimit,
  session,
  user,
  verification,
} from "@kvitbit/db/schema";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth, type User } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, magicLink } from "better-auth/plugins";
import { Effect, Exit, Redacted } from "effect";
import type { BotProtection } from "../altcha";
import { API_KEY_PREFIX } from "./api-key";
import type { EmailRateLimiter } from "./email-rate-limit";
import { generateId } from "./ids";

/** The Better Auth tables of `@kvitbit/db`, keyed by the model names the adapter looks up. */
export const authTables = {
  user,
  session,
  account,
  verification,
  rateLimit,
  apikey,
  passkey: passkeyTable,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  oauthAccessToken,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
} as const;

/**
 * OAuth scopes offered to MCP clients (section 6.2): the `kvitbit:read` and `kvitbit:write`
 * presets, `kvitbit:<area>:read|write` for each of the ten areas, and `offline_access`.
 */
export const OAUTH_SCOPES: ReadonlyArray<string> = [
  `${OAUTH_SCOPE_PREFIX}read`,
  `${OAUTH_SCOPE_PREFIX}write`,
  ...SCOPE_AREAS.flatMap((area) => [
    `${OAUTH_SCOPE_PREFIX}${area}:read`,
    `${OAUTH_SCOPE_PREFIX}${area}:write`,
  ]),
  OAUTH_OFFLINE_ACCESS,
];

/** Grants and client authentication methods of the authorization server (section 6.2 step 3). */
export const OAUTH_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = ["none", "client_secret_basic"] as const;

/** Better Auth paths that need a bot proof, and the scope each one signs (section 2.6). */
export const BOT_PROTECTED_PATHS: Readonly<Record<string, BotScope>> = {
  "/sign-up/email": "sign_up",
  "/sign-in/email": "sign_in",
  "/sign-in/magic-link": "magic_link",
  "/request-password-reset": "password_reset",
};

/** Header carrying the base64 ALTCHA payload. */
export const BOT_PROOF_HEADER = "x-altcha";

type Sender<Data> = (data: Data, request?: Request) => Promise<void>;
type LinkData = { readonly url: string; readonly token: string };

/** A before hook in Better Auth's native plugin form: dispatch keeps its return value. */
export type BeforeHook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["before"]>[number];

export interface AuthConfig {
  /** Public origin Better Auth runs under, e.g. `https://kvitbit.example`. */
  readonly baseURL: string;
  readonly secret: Redacted.Redacted<string>;
  /** A Drizzle Postgres database over the `@kvitbit/db` schema. */
  readonly db: Parameters<typeof drizzleAdapter>[0];
  /** Passkey relying party id: the host (section 2.7). */
  readonly rpID: string;
  readonly rpName?: string;
  /**
   * Origins allowed for cookie writes and passkey ceremonies (rule A5); the `baseURL` origin is
   * always trusted.
   */
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly sendVerificationEmail: Sender<LinkData & { readonly user: User }>;
  readonly sendResetPassword: Sender<LinkData & { readonly user: User }>;
  readonly sendMagicLink: Sender<LinkData & { readonly email: string }>;
  /** Sent to the current address when a verified user asks to change it (flow 1.8). */
  readonly sendChangeEmailConfirmation: Sender<
    LinkData & { readonly user: User; readonly newEmail: string }
  >;
  /**
   * Account deletion guard (flow 1.9): rejects (throw an `APIError`) while the user still owns a
   * Workspace. Runs before Better Auth deletes anything.
   */
  readonly beforeDeleteUser: (user: User, request?: Request) => Promise<void>;
  /** OAuth sign-in and consent pages of the web app (flow 10.8). */
  readonly oauthLoginPage: string;
  readonly oauthConsentPage: string;
  /** The MCP resource URL (`https://<host>/mcp`) every token is bound to (RFC 8707). */
  readonly mcpResource: string;
  /** Bot protection for `BOT_PROTECTED_PATHS`; a self-host opt-out passes `NoopBotProtection`. */
  readonly botProtection: BotProtection["Service"];
  /** Per-email limit for `BOT_PROTECTED_PATHS` (`makeEmailRateLimiter`). */
  readonly emailRateLimiter: EmailRateLimiter;
  /** Further before hooks (invitation lock, ...), run after the guards with native semantics. */
  readonly beforeHooks?: ReadonlyArray<BeforeHook>;
}

/**
 * The `apiKey` plugin with the Kvitbit columns of `auth.apikey` (Workspace binding, creator,
 * access mode, scopes) added to its schema. The plugin never writes them, and its routes are
 * disabled, so declaring them only keeps Better Auth's schema check (`validateSchema`) on.
 */
const apiKeyPlugin = () => {
  const plugin = apiKey({ defaultPrefix: API_KEY_PREFIX, enableMetadata: true });
  return {
    ...plugin,
    schema: {
      ...plugin.schema,
      apikey: {
        ...plugin.schema.apikey,
        fields: {
          ...plugin.schema.apikey.fields,
          workspaceId: { type: "string", required: true, input: false },
          createdBy: { type: "string", required: true, input: false },
          access: { type: "string", required: true, input: false },
          scopes: { type: "string[]", required: true, input: false },
        },
      },
    },
  } as typeof plugin;
};

/**
 * Every route the `apiKey` plugin registers. Better Auth has no switch for them, so they are
 * all disabled: apps/server issues and checks keys itself (`./api-key`), and the plugin only
 * contributes its schema.
 */
export const API_KEY_PLUGIN_PATHS: ReadonlyArray<string> = Object.values(
  apiKeyPlugin().endpoints,
).map((endpoint) => endpoint.path);

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail");
  return reason?._tag === "Fail" ? reason.error : undefined;
};

const unavailable = (what: string) =>
  new APIError(
    "SERVICE_UNAVAILABLE",
    { _tag: "Unavailable", code: "Unavailable", message: `${what} is unavailable.` },
    { "Retry-After": "5" },
  );

const isBotProtected = (ctx: { readonly path?: string }) =>
  ctx.path !== undefined && ctx.path in BOT_PROTECTED_PATHS;

/**
 * 5 per minute per email across the bot-protected paths, after the proof passed; 429
 * `RateLimited` with `Retry-After`.
 */
export const emailRateLimitHook = (limiter: EmailRateLimiter): BeforeHook => ({
  matcher: isBotProtected,
  handler: createAuthMiddleware(async (ctx) => {
    const email: unknown = ctx.body?.email;
    if (typeof email !== "string" || email.length === 0) return;
    const exit = await Effect.runPromiseExit(limiter.consume(email));
    if (Exit.isFailure(exit)) throw unavailable("Rate limiting");
    if (exit.value.allowed) return;
    const seconds = exit.value.retryAfterSeconds;
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { _tag: "RateLimited", code: "RateLimited", retryAfterSeconds: seconds },
      { "Retry-After": String(seconds) },
    );
  }),
});

/**
 * Verifies the `x-altcha` proof for `BOT_PROTECTED_PATHS` before Better Auth runs any side
 * effect. A bad proof answers 400 `InvalidBotProof`; a store outage answers 503 with
 * `Retry-After: 5` and never fails open (rules B2, B3, B6).
 */
export const botProtectionHook = (botProtection: BotProtection["Service"]): BeforeHook => ({
  matcher: isBotProtected,
  handler: createAuthMiddleware(async (ctx) => {
    const scope = BOT_PROTECTED_PATHS[ctx.path];
    if (scope === undefined) return;
    const payload = ctx.headers?.get(BOT_PROOF_HEADER) ?? "";
    const exit = await Effect.runPromiseExit(botProtection.verify(scope, payload));
    if (Exit.isSuccess(exit)) return;
    if (failureOf(exit)?._tag === "InvalidBotProof") {
      throw new APIError("BAD_REQUEST", {
        _tag: "InvalidBotProof",
        code: "InvalidBotProof",
        message: "Bot protection proof is missing, expired or invalid.",
      });
    }
    throw unavailable("Bot protection");
  }),
});

const invalidRequest = (description: string) =>
  new APIError("BAD_REQUEST", { error: "invalid_request", error_description: description });

/**
 * Section 6.2 step 5: an authorization request needs a non-empty `state` and
 * `resource=<mcpResource>`. The provider treats both as optional, so this hook enforces them.
 */
export const oauthAuthorizeHook = (mcpResource: string): BeforeHook => ({
  matcher: (ctx) => ctx.path === "/oauth2/authorize",
  handler: createAuthMiddleware(async (ctx) => {
    const params: Record<string, unknown> =
      ctx.method === "POST" && typeof ctx.body === "object" && ctx.body !== null
        ? ctx.body
        : (ctx.query ?? {});
    const { state, resource } = params;
    if (typeof state !== "string" || state.length === 0) throw invalidRequest("state is required");
    const resources = Array.isArray(resource) ? resource : [resource];
    if (resources.length !== 1 || resources[0] !== mcpResource) {
      throw invalidRequest(`resource must be ${mcpResource}`);
    }
  }),
});

/** Dynamic registration may only ask for the advertised client authentication methods. */
export const oauthRegisterHook: BeforeHook = {
  matcher: (ctx) => ctx.path === "/oauth2/register",
  handler: createAuthMiddleware(async (ctx) => {
    const method: unknown = ctx.body?.token_endpoint_auth_method;
    if (method === undefined) return;
    if (!(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS as ReadonlyArray<unknown>).includes(method)) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client_metadata",
        error_description: `token_endpoint_auth_method must be one of ${OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}`,
      });
    }
  }),
};

/** The Better Auth options `makeAuth` passes; exported for inspection in tests. */
export const authOptions = (config: AuthConfig) => {
  const baseOrigin = new URL(config.baseURL).origin;
  // Plugin hooks dispatch in plugin order, so these run first, before any endpoint side effect.
  const guards = {
    id: "kvitbit-edge-guards",
    hooks: {
      before: [
        // Proof first: a request without a valid proof never touches the email allowance, so
        // bots cannot spend a victim's quota (rule B2).
        botProtectionHook(config.botProtection),
        emailRateLimitHook(config.emailRateLimiter),
        oauthAuthorizeHook(config.mcpResource),
        oauthRegisterHook,
      ],
    },
  } satisfies BetterAuthPlugin;
  const extraHooks = {
    id: "kvitbit-edge-hooks",
    hooks: { before: [...(config.beforeHooks ?? [])] },
  } satisfies BetterAuthPlugin;
  return {
    appName: "Kvitbit",
    baseURL: config.baseURL,
    secret: Redacted.value(config.secret),
    trustedOrigins: [baseOrigin, ...(config.trustedOrigins ?? [])],
    database: drizzleAdapter(config.db, { provider: "pg", schema: authTables }),
    advanced: {
      // Cookie `__Secure-kvitbit.session_token` (section 2.1).
      cookiePrefix: "kvitbit",
      database: { generateId: () => generateId() },
    },
    disabledPaths: [...API_KEY_PLUGIN_PATHS],
    emailAndPassword: {
      enabled: true,
      // No session until the address is verified (rule A7).
      requireEmailVerification: true,
      sendResetPassword: (data, request) => config.sendResetPassword(data, request),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: (data, request) => config.sendVerificationEmail(data, request),
    },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: (data, request) =>
          config.sendChangeEmailConfirmation(data, request),
      },
      deleteUser: {
        enabled: true,
        beforeDelete: (deleted, request) => config.beforeDeleteUser(deleted, request),
      },
    },
    // Section 2.5: 20 per minute per IP on the bot-protected endpoints (the per-email limit is
    // `emailRateLimitHook`); Better Auth's defaults elsewhere.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: Object.fromEntries(
        Object.keys(BOT_PROTECTED_PATHS).map((path) => [path, { window: 60, max: 20 }]),
      ),
    },
    plugins: [
      guards,
      magicLink({ sendMagicLink: (data) => config.sendMagicLink(data) }),
      // No `origin` override: the plugin checks the ceremony origin against `trustedOrigins`.
      passkey({ rpID: config.rpID, rpName: config.rpName ?? "Kvitbit" }),
      bearer(),
      apiKeyPlugin(),
      oauthProvider({
        scopes: [...OAUTH_SCOPES],
        clientRegistrationDefaultScopes: [`${OAUTH_SCOPE_PREFIX}read`],
        clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
        resources: [config.mcpResource],
        clientRegistrationDefaultResources: [config.mcpResource],
        grantTypes: [...OAUTH_GRANT_TYPES],
        advertisedMetadata: {
          token_endpoint_auth_methods_supported: [...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS],
        },
        loginPage: config.oauthLoginPage,
        consentPage: config.oauthConsentPage,
        // Opaque access tokens checked against their row on every MCP call (section 6.2).
        disableJwtPlugin: true,
        // MCP clients register themselves (RFC 7591); they are public clients with PKCE.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        // Seconds: parallel refreshes within 10 s get the same tokens (section 6.2 step 6).
        refreshTokenReuseInterval: 10,
      }),
      extraHooks,
    ],
  } satisfies BetterAuthOptions;
};

/** Builds the Better Auth instance. Construction touches no database. */
export const makeAuth = (config: AuthConfig) => betterAuth(authOptions(config));

export type Auth = ReturnType<typeof makeAuth>;
