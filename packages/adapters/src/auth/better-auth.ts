/**
 * Better Auth configuration (http-mcp-contracts sections 2.1, 2.5-2.7).
 *
 * `makeAuth` builds the instance apps/server mounts at `/api/auth/*`: email and password with
 * required verification, magic link, passkeys, `bearer` sessions for the mobile client, the
 * `apiKey` plugin as storage for `kvb_` keys with none of its routes exposed, and the OAuth 2.1
 * provider for MCP with opaque, hashed tokens, PKCE S256 and the `kvitbit:` scopes. Every row
 * id is a UUIDv7. ALTCHA runs as a before hook on the endpoints of section 2.6.
 *
 * The `expo` plugin of section 2.7 is not wired: `@better-auth/expo` is not a dependency yet.
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
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, magicLink } from "better-auth/plugins";
import { Effect, Exit, Redacted } from "effect";
import type { BotProtection } from "../altcha";
import { API_KEY_PREFIX } from "./api-key";
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
 * OAuth scopes offered to MCP clients (section 6.3): the `kvitbit:read` and `kvitbit:write`
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

/** Better Auth paths that need a bot proof, and the scope each one signs (section 2.6). */
export const BOT_PROTECTED_PATHS: Readonly<Record<string, BotScope>> = {
  "/sign-up/email": "sign_up",
  "/sign-in/email": "sign_in",
  "/sign-in/magic-link": "magic_link",
  "/request-password-reset": "password_reset",
};

/** Header carrying the base64 ALTCHA payload. */
export const BOT_PROOF_HEADER = "x-altcha";

type Sender<K extends "user" | "email"> = (
  data: { readonly url: string; readonly token: string } & (K extends "user"
    ? { readonly user: { readonly id: string; readonly email: string; readonly name: string } }
    : { readonly email: string }),
  request?: Request,
) => Promise<void>;

export interface AuthConfig {
  /** Public origin Better Auth runs under, e.g. `https://kvitbit.example`. */
  readonly baseURL: string;
  readonly secret: Redacted.Redacted<string>;
  /** A Drizzle Postgres database over the `@kvitbit/db` schema. */
  readonly db: Parameters<typeof drizzleAdapter>[0];
  /** Passkey relying party id: the host (section 2.7). */
  readonly rpID: string;
  readonly rpName?: string;
  /** Origins allowed for cookie writes and passkeys (rule A5); `baseURL` is always trusted. */
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly sendVerificationEmail: Sender<"user">;
  readonly sendResetPassword: Sender<"user">;
  readonly sendMagicLink: Sender<"email">;
  /** OAuth sign-in and consent pages of the web app (flow 10.8). */
  readonly oauthLoginPage: string;
  readonly oauthConsentPage: string;
  /** The MCP resource URL (`https://<host>/mcp`) tokens are bound to (RFC 8707, rule A1). */
  readonly mcpResource?: string;
  /** Bot protection for `BOT_PROTECTED_PATHS`. Omit only where the install runs Noop. */
  readonly botProtection?: BotProtection["Service"];
  /** Extra before hooks, run after bot protection (invitation lock, deletion guard). */
  readonly beforeHooks?: ReadonlyArray<
    NonNullable<NonNullable<BetterAuthOptions["hooks"]>["before"]>
  >;
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

/**
 * Before hook: verifies the `x-altcha` proof for `BOT_PROTECTED_PATHS` before Better Auth runs
 * any side effect. A bad proof answers 400 `InvalidBotProof`; a store outage answers 503 with
 * `Retry-After: 5` and never fails open (rules B2, B3, B6).
 */
export const botProtectionHook = (botProtection: BotProtection["Service"]) =>
  createAuthMiddleware(async (ctx) => {
    const scope = BOT_PROTECTED_PATHS[ctx.path];
    if (scope === undefined) return;
    const payload = ctx.headers?.get(BOT_PROOF_HEADER) ?? "";
    const exit = await Effect.runPromiseExit(botProtection.verify(scope, payload));
    if (Exit.isSuccess(exit)) return;
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    if (failure?._tag === "Fail" && failure.error._tag === "InvalidBotProof") {
      throw new APIError("BAD_REQUEST", {
        _tag: "InvalidBotProof",
        code: "InvalidBotProof",
        message: "Bot protection proof is missing, expired or invalid.",
      });
    }
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      { _tag: "Unavailable", code: "Unavailable", message: "Bot protection is unavailable." },
      { "Retry-After": "5" },
    );
  });

/** The Better Auth options `makeAuth` passes; exported for inspection in tests. */
export const authOptions = (config: AuthConfig) => {
  const baseOrigin = new URL(config.baseURL).origin;
  const before = [
    ...(config.botProtection === undefined ? [] : [botProtectionHook(config.botProtection)]),
    ...(config.beforeHooks ?? []),
  ];
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
    // Section 2.5: 20 per minute per IP on the bot-protected endpoints. The 5 per minute per
    // email limit is not expressible here (Better Auth keys limits by IP); apps/server adds it.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: Object.fromEntries(
        Object.keys(BOT_PROTECTED_PATHS).map((path) => [path, { window: 60, max: 20 }]),
      ),
    },
    ...(before.length === 0
      ? {}
      : {
          hooks: {
            before: createAuthMiddleware(async (ctx) => {
              for (const hook of before) await hook(ctx);
            }),
          },
        }),
    plugins: [
      magicLink({ sendMagicLink: (data) => config.sendMagicLink(data) }),
      passkey({ rpID: config.rpID, rpName: config.rpName ?? "Kvitbit", origin: baseOrigin }),
      bearer(),
      apiKeyPlugin(),
      oauthProvider({
        scopes: [...OAUTH_SCOPES],
        clientRegistrationDefaultScopes: [`${OAUTH_SCOPE_PREFIX}read`],
        loginPage: config.oauthLoginPage,
        consentPage: config.oauthConsentPage,
        // Opaque access tokens checked against their row on every MCP call (section 2.7).
        disableJwtPlugin: true,
        // MCP clients register themselves (RFC 7591); they are public clients with PKCE.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        refreshTokenReuseInterval: 30,
        ...(config.mcpResource === undefined ? {} : { resources: [config.mcpResource] }),
      }),
    ],
  } satisfies BetterAuthOptions;
};

/** Builds the Better Auth instance. Construction touches no database. */
export const makeAuth = (config: AuthConfig) => betterAuth(authOptions(config));

export type Auth = ReturnType<typeof makeAuth>;
