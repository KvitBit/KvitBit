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
 * Clients register through a Client ID Metadata Document (an HTTPS `client_id`, the preferred
 * path of section 6.2 step 4, `@better-auth/cimd`) or dynamic client registration.
 *
 * Not wired yet: the `expo` plugin of section 2.7 (`@better-auth/expo` is not a dependency).
 */
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { type ClientMetadataResourceFetch, oauthProvider } from "@better-auth/oauth-provider";
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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
  ...Arr.flatMap(SCOPE_AREAS, (area) => [
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
interface LinkData {
  readonly url: string;
  readonly token: string;
}

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
  /**
   * Transport for fetching Client ID Metadata Documents. Defaults to the cimd package's Node
   * fetch, which resolves DNS once, refuses private addresses and never follows redirects.
   */
  readonly fetchClientMetadata?: ClientMetadataResourceFetch;
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
          workspaceId: { type: "string", required: true, input: false } as const,
          createdBy: { type: "string", required: true, input: false } as const,
          access: { type: "string", required: true, input: false } as const,
          scopes: { type: "string[]", required: true, input: false } as const,
        },
      },
    },
  };
};

/**
 * Every route the `apiKey` plugin registers. Better Auth has no switch for them, so they are
 * all disabled: apps/server issues and checks keys itself (`./api-key`), and the plugin only
 * contributes its schema.
 */
export const API_KEY_PLUGIN_PATHS: ReadonlyArray<string> = Arr.map(
  Rec.values(apiKeyPlugin().endpoints),
  (endpoint) => endpoint.path,
);

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  return Arr.findFirst(exit.cause.reasons, (reason) => reason._tag === "Fail").pipe(
    Option.map((reason) => reason.error),
    Option.getOrUndefined,
  );
};

const unavailable = (what: string) =>
  new APIError(
    "SERVICE_UNAVAILABLE",
    { _tag: "Unavailable", code: "Unavailable", message: `${what} is unavailable.` },
    { "Retry-After": "5" },
  );

const isBotProtected = (ctx: { readonly path?: string }) =>
  ctx.path !== undefined && ctx.path in BOT_PROTECTED_PATHS;

// Better Auth requires a Promise and handles rejected APIErrors itself.
const runAuthPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  // biome-ignore lint/plugin: Better Auth's Promise middleware is a runtime boundary.
  Effect.runPromise(effect);

const isNonEmptyString = Schema.is(Schema.NonEmptyString);
const isString = Schema.is(Schema.String);

const metadataUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.href : input.url;

/**
 * 5 per minute per email across the bot-protected paths, after the proof passed; 429
 * `RateLimited` with `Retry-After`.
 */
export const emailRateLimitHook = (limiter: EmailRateLimiter): BeforeHook => ({
  matcher: isBotProtected,
  handler: createAuthMiddleware((ctx) =>
    runAuthPromise(
      Effect.gen(function* () {
        const email: unknown = ctx.body?.email;
        if (!isNonEmptyString(email)) return;
        const exit = yield* Effect.exit(limiter.consume(email));
        if (Exit.isFailure(exit)) return yield* Effect.fail(unavailable("Rate limiting"));
        if (exit.value.allowed) return;
        const seconds = exit.value.retryAfterSeconds;
        return yield* Effect.fail(
          new APIError(
            "TOO_MANY_REQUESTS",
            { _tag: "RateLimited", code: "RateLimited", retryAfterSeconds: seconds },
            { "Retry-After": String(seconds) },
          ),
        );
      }),
    ),
  ),
});

/**
 * Verifies the `x-altcha` proof for `BOT_PROTECTED_PATHS` before Better Auth runs any side
 * effect. A bad proof answers 400 `InvalidBotProof`; a store outage answers 503 with
 * `Retry-After: 5` and never fails open (rules B2, B3, B6).
 */
export const botProtectionHook = (botProtection: BotProtection["Service"]): BeforeHook => ({
  matcher: isBotProtected,
  handler: createAuthMiddleware((ctx) =>
    runAuthPromise(
      Effect.gen(function* () {
        const scope = BOT_PROTECTED_PATHS[ctx.path];
        if (scope === undefined) return;
        const payload = ctx.headers?.get(BOT_PROOF_HEADER) ?? "";
        const exit = yield* Effect.exit(botProtection.verify(scope, payload));
        if (Exit.isSuccess(exit)) return;
        if (failureOf(exit)?._tag === "InvalidBotProof") {
          return yield* Effect.fail(
            new APIError("BAD_REQUEST", {
              _tag: "InvalidBotProof",
              code: "InvalidBotProof",
              message: "Bot protection proof is missing, expired or invalid.",
            }),
          );
        }
        return yield* Effect.fail(unavailable("Bot protection"));
      }),
    ),
  ),
});

const invalidRequest = (description: string) =>
  new APIError("BAD_REQUEST", { error: "invalid_request", error_description: description });

const isObject = Schema.is(Schema.ObjectKeyword);
const decodeAuthorizeParams = Schema.decodeUnknownOption(
  Schema.Struct({
    state: Schema.optionalKey(Schema.Unknown),
    resource: Schema.optionalKey(Schema.Unknown),
  }),
);

const acceptsClientAuth = Schema.is(Schema.Literals(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS));

const clientAuthDescription = `token_endpoint_auth_method must be one of ${Arr.join(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS, ", ")}`;

/**
 * Section 6.2 step 5: an authorization request needs a non-empty `state` and
 * `resource=<mcpResource>`. The provider treats both as optional, so this hook enforces them.
 */
export const oauthAuthorizeHook = (mcpResource: string): BeforeHook => ({
  matcher: (ctx) => ctx.path === "/oauth2/authorize",
  handler: createAuthMiddleware((ctx) =>
    runAuthPromise(
      Effect.gen(function* () {
        const raw = ctx.method === "POST" && isObject(ctx.body) ? ctx.body : ctx.query;
        const params = decodeAuthorizeParams(raw).pipe(Option.getOrUndefined);
        if (!isNonEmptyString(params?.state)) {
          return yield* Effect.fail(invalidRequest("state is required"));
        }
        const resource = params?.resource;
        const resources = Arr.isArray(resource) ? resource : [resource];
        if (resources.length !== 1 || resources[0] !== mcpResource) {
          return yield* Effect.fail(invalidRequest(`resource must be ${mcpResource}`));
        }
      }),
    ),
  ),
});

/** Dynamic registration may only ask for the advertised client authentication methods. */
export const oauthRegisterHook: BeforeHook = {
  matcher: (ctx) => ctx.path === "/oauth2/register",
  handler: createAuthMiddleware((ctx) => {
    const method: unknown = ctx.body?.token_endpoint_auth_method;
    return runAuthPromise(
      method === undefined || acceptsClientAuth(method)
        ? Effect.void
        : Effect.fail(
            new APIError("BAD_REQUEST", {
              error: "invalid_client_metadata",
              error_description: clientAuthDescription,
            }),
          ),
    );
  }),
};

/** The cimd plugin's metadata document size limit (`MAX_RESPONSE_BYTES` in @better-auth/cimd). */
export const CLIENT_METADATA_MAX_BYTES = 5120;

/**
 * Most the metadata guard reads of a body without `Content-Length`: the larger of the cimd
 * plugin's 5 KiB document limit and the provider's 64 KiB JWKS limit, so every resource the
 * shared transport serves fits and the consumers' own (smaller) limits still decide.
 */
export const CLIENT_METADATA_GUARD_MAX_BYTES = 64 * 1024;

const refuseMetadata = (status: number, description: string) =>
  Response.json({ error: "invalid_client_metadata", error_description: description }, { status });

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/**
 * Reads at most `limit` bytes; undefined (stream cancelled) when the body is longer. Rejects
 * with the abort reason when `signal` aborts before or during the read, never returning a
 * partial body.
 */
const readBounded = Effect.fn("readBounded")(function* (
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal | null | undefined,
) {
  // A custom stream's cancel may take arbitrarily long. Start it without delaying the response.
  if (signal?.aborted === true) {
    const reason = abortError(signal);
    body.cancel(reason).catch(() => undefined);
    return yield* Effect.die(reason);
  }
  const reader = body.getReader();
  const readChunk = Effect.tryPromise({
    try: () => reader.read(),
    catch: (cause) => ({ cause }),
  }).pipe(Effect.catch(({ cause }) => Effect.die(cause)));
  const read = Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    let chunk = yield* readChunk;
    while (!chunk.done) {
      const { value } = chunk;
      size += value.byteLength;
      if (size > limit) {
        reader.cancel().catch(() => undefined);
        return;
      }
      chunks.push(value);
      chunk = yield* readChunk;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const bytesRead of chunks) {
      bytes.set(bytesRead, offset);
      offset += bytesRead.byteLength;
    }
    return bytes;
  });
  if (signal === null || signal === undefined) return yield* read;
  const aborted = Effect.callback<never>((resume) => {
    const onAbort = () => {
      const reason = abortError(signal);
      resume(Effect.die(reason));
      reader.cancel(reason).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  const bytes = yield* Effect.raceFirst(read, aborted);
  if (signal.aborted) return yield* Effect.die(abortError(signal));
  return bytes;
});

/**
 * The same response over a body whose `cancel()` returns at once while the original stream's
 * cleanup runs detached. Consumers that `await body.cancel()` before rejecting (the cimd
 * resolver's declared-size check) then settle even when a transport's cleanup stalls. Reads
 * stay on demand.
 */
const withDetachedCleanup = (response: Response): Response => {
  const original = response.body;
  if (original === null) return response;
  const reader = original.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        return reader.read().then(({ done, value }) => {
          if (done) controller.close();
          else controller.enqueue(value);
        });
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const decodeClientMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      client_id: Schema.optionalKey(Schema.Unknown),
      token_endpoint_auth_method: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

/**
 * Wraps the Client ID Metadata Document transport so a document asking for a client
 * authentication method outside `OAUTH_TOKEN_ENDPOINT_AUTH_METHODS` is refused. The cimd plugin
 * validates against the provider's built-in methods (which include `private_key_jwt`), and both
 * client creation and later revalidation fetch through this transport, so filtering here covers
 * both.
 *
 * Responses the consumers reject on their own pass through untouched, so their checks see the
 * original: anything but a plain 200 and a redirected response (both refused without touching
 * the body). A body whose declared `Content-Length` exceeds `CLIENT_METADATA_MAX_BYTES` goes on
 * unread, over a body with detached cleanup: the resolver refuses such a document from the
 * header alone, and a JWKS reader applies its own larger limit. Other bodies are read up to that
 * bound (a longer stream is cancelled and refused) and handed on as a new response with the
 * original status and headers, so the plugin's 5 KiB document limit and the provider's JWKS
 * limit still apply to them. Aborting the fetch signal aborts the read.
 */
export const guardClientMetadataFetch = (
  inner: ClientMetadataResourceFetch,
): ClientMetadataResourceFetch => {
  const fetchMetadata = Effect.fn("guardClientMetadataFetch")(function* (
    ...[input, init]: Parameters<ClientMetadataResourceFetch>
  ) {
    const response = yield* Effect.tryPromise({
      // biome-ignore lint/plugin: Better Auth transports may return a Response or a Promise.
      try: () => Promise.resolve(inner(input, init)),
      catch: (cause) => ({ cause }),
    }).pipe(Effect.catch(({ cause }) => Effect.die(cause)));
    if (response.status !== 200 || response.redirected || response.body === null) {
      return response;
    }
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > CLIENT_METADATA_MAX_BYTES) {
      return withDetachedCleanup(response);
    }
    const bytes = yield* readBounded(response.body, CLIENT_METADATA_GUARD_MAX_BYTES, init?.signal);
    if (bytes === undefined) {
      return refuseMetadata(413, `Response exceeds ${CLIENT_METADATA_GUARD_MAX_BYTES} bytes`);
    }
    const document = decodeClientMetadata(new TextDecoder().decode(bytes));
    const url = metadataUrl(input);
    if (Option.isSome(document)) {
      const { client_id: clientId, token_endpoint_auth_method: method } = document.value;
      if (clientId === url && method !== undefined && !acceptsClientAuth(method)) {
        return refuseMetadata(400, clientAuthDescription);
      }
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
  return (input, init) => runAuthPromise(fetchMetadata(input, init));
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
      customRules: Rec.map(BOT_PROTECTED_PATHS, () => ({ window: 60, max: 20 })),
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
      cimd({
        fetchClientMetadataResource: guardClientMetadataFetch(
          config.fetchClientMetadata ?? fetchClientMetadataResource,
        ),
        metadataProfile: "mcp-2026-07-28",
      }),
      extraHooks,
    ],
  } satisfies BetterAuthOptions;
};

/** Builds the Better Auth instance. Construction touches no database. */
export const makeAuth = (config: AuthConfig) => betterAuth(authOptions(config));

export type Auth = ReturnType<typeof makeAuth>;
