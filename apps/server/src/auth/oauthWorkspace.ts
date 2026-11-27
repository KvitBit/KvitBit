import { AsyncLocalStorage } from "node:async_hooks";
import {
  getOAuthProviderState,
  type OAuthOptions,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { type AuthConfig, authOptions, generateId } from "@kvitbit/adapters/auth";
import {
  ALL_SCOPES,
  accessFromOAuthScopes,
  OAuthScopeToken,
  READ_SCOPES,
} from "@kvitbit/api-contract";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import {
  AuthCallbackError,
  fromAuthPromise,
  runAuthEffect,
  withDrizzleSqlContext,
} from "./drizzleBridge";

type ConsentDecision =
  | { readonly accept: false }
  | {
      readonly accept: true;
      readonly grantId: string;
      readonly userId: string;
      readonly sessionId: string;
      readonly scopes: ReadonlyArray<string>;
    };

const decisionContext = new AsyncLocalStorage<ConsentDecision>();
interface TokenRequest {
  grantId?: string;
  refreshDigest?: string;
}
const tokenContext = new AsyncLocalStorage<TokenRequest>();

const runWorkspaceConsent = <A>(decision: ConsentDecision, callback: () => PromiseLike<A>) =>
  withDrizzleSqlContext(() => decisionContext.run(decision, callback));

export const processWorkspaceConsent: {
  <A>(
    callback: () => PromiseLike<A>,
  ): (decision: ConsentDecision) => ReturnType<typeof runWorkspaceConsent<A>>;
  <A>(
    decision: ConsentDecision,
    callback: () => PromiseLike<A>,
  ): ReturnType<typeof runWorkspaceConsent<A>>;
} = Fn.dual(2, runWorkspaceConsent);

/** A validated, session-bound provider request has one durable decision. */
export const verifyWorkspaceConsent = Effect.fn("verifyWorkspaceConsent")(function* (
  query: string,
  secret: Redacted.Redacted<string>,
  sessionId: string,
) {
  const params = new URLSearchParams(query);
  const signature = params.get("sig");
  if (
    signature === null ||
    params.get("ba_pl") !== sessionId ||
    !(yield* withDrizzleSqlContext(() =>
      verifyOAuthQueryParams(query, Redacted.value(secret)),
    ).pipe(Effect.orDie))
  ) {
    return;
  }
  return {
    id: `oauth-consent:${Buffer.from(Str.replace(/ /g, "+")(signature), "base64").toString("hex")}`,
    expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(Number(params.get("exp")) * 1000)),
  };
});

const invalidConsent = () => new APIError("BAD_REQUEST", { error: "invalid_request" });

const isOAuthScope = Schema.is(OAuthScopeToken);

const TokenBinding = Schema.Struct({
  referenceId: Schema.String,
  clientId: Schema.String,
  userId: Schema.String,
  scopes: Schema.Array(Schema.String),
});
const tokenBinding = Schema.is(TokenBinding);
const isString = Schema.is(Schema.String);
const isResponse = Schema.is(Schema.instanceOf(Response));

const oauthRedirect = Schema.is(
  Schema.Struct({ redirect: Schema.Literal(true), url: Schema.String }),
);

const consentRedirect = (page: URL, url: string) => {
  if (!URL.canParse(url, page.href)) return;
  const redirect = new URL(url, page);
  if (
    redirect.origin !== page.origin ||
    redirect.pathname !== page.pathname ||
    !redirect.searchParams.has("sig")
  ) {
    return;
  }
  const signedQuery = Str.slice(1)(redirect.search);
  const query = new URLSearchParams({ consent_id: Buffer.from(signedQuery).toString("base64url") });
  return `${page.pathname}?${query}`;
};

const exposeConsentId = Effect.fn("exposeOAuthConsentId")(function* (
  response: Response,
  page: URL,
) {
  const location = response.headers.get("location");
  if (location !== null) {
    const redirect = consentRedirect(page, location);
    if (redirect === undefined) return response;
    const headers = new Headers(response.headers);
    headers.set("location", redirect);
    return new Response(response.body, { status: response.status, headers });
  }

  const contentType = response.headers.get("content-type");
  if (!response.ok || contentType === null || !Str.includes("application/json")(contentType)) {
    return response;
  }
  const body = yield* fromAuthPromise(() => response.clone().text()).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.orElseSucceed(() => undefined),
  );
  if (!oauthRedirect(body)) return response;
  const redirect = consentRedirect(page, body.url);
  if (redirect === undefined) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json({ ...body, url: redirect }, { status: response.status, headers });
});

const scopeAliasesForGrant = <T>(client: T): T => {
  if (decisionContext.getStore()?.accept !== true && tokenContext.getStore() === undefined)
    return client;
  if (!(Predicate.isObject(client) && "scopes" in client && Arr.isArray(client["scopes"]))) {
    return client;
  }

  const raw = Arr.filter(client["scopes"], isOAuthScope);
  const expanded = accessFromOAuthScopes(raw)?.access.scopes ?? [];
  const scopes = new Set<string>(raw);
  for (const scope of expanded) scopes.add(`kvitbit:${scope}`);
  if (Arr.every(READ_SCOPES, (scope) => expanded.includes(scope))) scopes.add("kvitbit:read");
  if (Arr.every(ALL_SCOPES, (scope) => expanded.includes(scope))) scopes.add("kvitbit:write");
  return { ...client, scopes: [...scopes] };
};

class OAuthProviderConfigurationError extends Schema.TaggedError<
  OAuthProviderConfigurationError,
  { readonly brand: unique symbol }
>()("OAuthProviderConfigurationError", { component: Schema.String }) {}

class OAuthProviderServerFailure extends Schema.TaggedError<
  OAuthProviderServerFailure,
  { readonly brand: unique symbol }
>()("OAuthProviderServerFailure", { response: Schema.instanceOf(Response) }) {}

class OAuthRefreshReplayMissing extends Schema.TaggedError<
  OAuthRefreshReplayMissing,
  { readonly brand: unique symbol }
>()("MissingReplay", {}) {}

export const makeWorkspaceAuth = (sql: SqlClient.SqlClient) =>
  Effect.fn("makeWorkspaceAuth")(function* (config: AuthConfig) {
    const authorizeConsent = Effect.fn("authorizeWorkspaceConsent")(function* () {
      // The provider's earlier hook verifies the signed query before populating this state.
      const decision = decisionContext.getStore();
      const state = yield* fromAuthPromise(getOAuthProviderState);
      if (decision === undefined || state?.query === undefined)
        return yield* Effect.fail(invalidConsent());
      if (decision.accept) {
        const query = new URLSearchParams(state.query);
        query.set("scope", Arr.join(decision.scopes, " "));
        state.query = query.toString();
      }
    });
    const options = authOptions({
      ...config,
      beforeHooks: [
        ...(config.beforeHooks ?? []),
        {
          matcher: (ctx) => ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware(() => runAuthEffect(authorizeConsent())),
        },
      ],
    });

    // Provider continuations carry the authorization parameters in `query` even
    // when the incoming sign-in or consent request was a POST.
    const guards = options.plugins[0].hooks;
    guards.before = Arr.map(guards.before, (hook) => ({
      ...hook,
      handler: Object.assign((ctx: Parameters<typeof hook.handler>[0]) => {
        const continuation = { ...ctx, method: "GET" };
        return hook.handler("authorizeSettings" in ctx ? continuation : ctx);
      }, hook.handler),
    }));

    const provider = Option.getOrUndefined(
      Arr.findFirst(options.plugins, (plugin) => plugin.id === "oauth-provider"),
    );
    if (provider === undefined || !("options" in provider) || !("schema" in provider)) {
      return yield* OAuthProviderConfigurationError.make({ component: "oauth-provider" });
    }

    const providerOptions: OAuthOptions<string[]> = provider.options;
    providerOptions.postLogin = {
      page: config.oauthConsentPage,
      shouldRedirect: () => false,
      consentReferenceId: ({ user, session }) =>
        runAuthEffect(
          Effect.suspend(() => {
            const decision = decisionContext.getStore();
            // An ordinary authorization request always needs the user's workspace selection.
            if (decision?.accept !== true) return Effect.sync(generateId);
            if (user.id !== decision.userId || session.id !== decision.sessionId) {
              return Effect.fail(invalidConsent());
            }
            return Effect.succeed(decision.grantId);
          }),
        ),
    };

    // This plugin initializes after CIMD registers its client discovery.
    const edgeHooks = Option.getOrUndefined(
      Arr.findFirst(options.plugins, (plugin) => plugin.id === "kvitbit-edge-hooks"),
    );
    if (edgeHooks === undefined)
      return yield* OAuthProviderConfigurationError.make({ component: "kvitbit-edge-hooks" });
    Object.assign(edgeHooks, {
      init: () => {
        for (const { clientDiscovery } of providerOptions.extensions ?? []) {
          const discoveries = Arr.isArray(clientDiscovery) ? clientDiscovery : [clientDiscovery];
          for (const discovery of discoveries) {
            if (discovery === undefined) continue;
            const resolve = discovery.resolve;
            discovery.resolve = (...args) =>
              runAuthEffect(
                Effect.try({
                  try: () => ({ result: resolve(...args) }),
                  catch: (cause) => AuthCallbackError.make({ cause }),
                }).pipe(
                  Effect.flatMap(({ result }) => {
                    if (Predicate.isPromiseLike(result)) return fromAuthPromise(() => result);
                    return Effect.succeed(result);
                  }),
                  Effect.map(scopeAliasesForGrant),
                ),
              );
          }
        }
      },
    });

    if (!("oauthAccessToken" in provider.schema && "oauthRefreshToken" in provider.schema)) {
      return yield* OAuthProviderConfigurationError.make({ component: "token-schemas" });
    }
    // For tokens the provider's grant reference is the consent foreign key.
    Object.assign(provider.schema.oauthAccessToken.fields.referenceId, { fieldName: "consentId" });
    Object.assign(provider.schema.oauthRefreshToken.fields.referenceId, { fieldName: "consentId" });

    const activeGrant = (binding: typeof TokenBinding.Type) =>
      sql<{ id: string }>`
      select c.id from auth.oauth_consent c
      join workspaces w on w.id = c.workspace_id
      join auth."user" u on u.id = c.user_id
      where c.id = ${binding.referenceId}
        and c.client_id = ${binding.clientId}
        and c.user_id = ${binding.userId}
        and c.scopes @> ${[...binding.scopes]}::text[]
        and w.closed_at is null
        and u.deleted_at is null
      for share of c`.pipe(Effect.map((rows) => rows.length > 0));

    const auth = betterAuth({
      ...options,
      database: (initOptions) => {
        const adapter = options.database(initOptions);
        const findOne = Effect.fn("oauth.findOne")(function* <T>(
          input: Parameters<typeof adapter.findOne>[0],
        ) {
          const tokenRequest = tokenContext.getStore();
          const refreshDigest =
            tokenRequest !== undefined && input.model === "oauthRefreshToken"
              ? Option.map(
                  Arr.findFirst(input.where, ({ field }) => field === "token"),
                  ({ value }) => value,
                )
              : Option.none();
          const digest = Option.getOrUndefined(Option.filter(refreshDigest, isString));
          if (digest !== undefined) {
            // The second request must see the completed rotation and its replay response.
            yield* sql`
            select 1 from pg_advisory_xact_lock(hashtextextended(${`oauth-refresh:${digest}`}, 0))
          `;
          }
          const row = yield* withDrizzleSqlContext(() => adapter.findOne<T>(input));
          if (input.model === "oauthClient") return scopeAliasesForGrant(row);

          if (tokenRequest !== undefined && digest !== undefined) {
            if (!(tokenBinding(row) && (yield* activeGrant(row)))) return null;
            tokenRequest.grantId = row.referenceId;
            tokenRequest.refreshDigest = digest;
          }
          return row;
        });
        return {
          ...adapter,
          findOne: <T>(input: Parameters<typeof adapter.findOne>[0]) =>
            runAuthEffect(findOne<T>(input)),
          deleteMany: (input) => {
            if (
              (input.model === "oauthAccessToken" || input.model === "oauthRefreshToken") &&
              Arr.some(input.where, ({ field }) => field === "clientId") &&
              Arr.some(input.where, ({ field }) => field === "userId")
            ) {
              // The provider's refresh reuse cleanup otherwise targets every workspace for this client and user.
              const grantId = tokenContext.getStore()?.grantId;
              if (grantId === undefined) return runAuthEffect(Effect.succeed(0));
              return adapter.deleteMany({
                ...input,
                where: [...input.where, { field: "referenceId", value: grantId }],
              });
            }
            return adapter.deleteMany(input);
          },
          create: <T extends Parameters<typeof adapter.create>[0]["data"], R = T>(input: {
            model: string;
            data: Omit<T, "id">;
            select?: string[] | undefined;
            forceAllowId?: boolean | undefined;
          }) => {
            if (input.model === "rateLimit" && tokenContext.getStore() !== undefined) {
              // Better Auth retries a duplicate cold-bucket insert. Roll back only the insert
              // so its retry can read and increment the winning row in the same transaction.
              return runAuthEffect(
                sql.withTransaction(withDrizzleSqlContext(() => adapter.create<T, R>(input))),
              );
            }
            if (input.model !== "oauthAccessToken" && input.model !== "oauthRefreshToken") {
              return adapter.create<T, R>(input);
            }

            return runAuthEffect(
              sql.withTransaction(
                Effect.gen(function* () {
                  if (!(tokenBinding(input.data) && (yield* activeGrant(input.data)))) {
                    return yield* Effect.fail(
                      new APIError("BAD_REQUEST", { error: "invalid_grant" }),
                    );
                  }
                  return yield* withDrizzleSqlContext(() => adapter.create<T, R>(input));
                }),
              ),
            );
          },
        };
      },
    });

    const consentPage = new URL(config.oauthConsentPage, config.baseURL);
    const handleOAuth = Effect.fn("oauth.handle")(function* (request: Request) {
      const path = new URL(request.url).pathname;
      if (
        request.method !== "POST" ||
        (path !== "/api/auth/oauth2/token" && path !== "/api/auth/oauth2/revoke")
      ) {
        const response = yield* withDrizzleSqlContext(() => auth.handler(request));
        return yield* exposeConsentId(response, consentPage);
      }

      const tokenRequest: TokenRequest = {};
      const handleToken = Effect.gen(function* () {
        const response = yield* withDrizzleSqlContext(() =>
          tokenContext.run(tokenRequest, () => auth.handler(request)),
        );
        // Provider 4xx responses can intentionally revoke a token family.
        if (response.status >= 500) return yield* OAuthProviderServerFailure.make({ response });
        if (
          response.ok &&
          path === "/api/auth/oauth2/token" &&
          tokenRequest.refreshDigest !== undefined
        ) {
          // Better Auth can swallow a replay-write failure and return success.
          const persisted = yield* sql`
          select 1 from auth.oauth_refresh_token
          where token = ${tokenRequest.refreshDigest} and rotation_replay_response is not null
        `;
          if (persisted.length === 0) return yield* OAuthRefreshReplayMissing.make();
        }
        return response;
      });
      return yield* sql.withTransaction(handleToken).pipe(
        Effect.provideService(SqlClient.BeginTransaction, "BEGIN ISOLATION LEVEL READ COMMITTED"),
        Effect.catch((error) => {
          if (error._tag === "OAuthProviderServerFailure") return Effect.succeed(error.response);
          if (error._tag === "AuthCallbackError" && isResponse(error.cause)) {
            return Effect.succeed(error.cause);
          }
          return Effect.succeed(
            Response.json(
              { error: "server_error" },
              { status: 500, headers: { "cache-control": "no-store", pragma: "no-cache" } },
            ),
          );
        }),
      );
    });

    return { ...auth, handler: (request: Request) => runAuthEffect(handleOAuth(request)) };
  });
