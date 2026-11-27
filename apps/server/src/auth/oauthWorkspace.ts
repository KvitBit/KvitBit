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
import { EmailNotAccepted, EmailOutcomeUnknown, EmailRejected } from "@kvitbit/domain/ports";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { runDrizzleEffect, withDrizzleSqlContext } from "./drizzleBridge";
import type { AuthEffectRunner } from "./logging";

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

export const processWorkspaceConsent = <A>(decision: ConsentDecision, callback: () => Promise<A>) =>
  withDrizzleSqlContext(() => decisionContext.run(decision, callback));

/** A validated, session-bound provider request has one durable decision. */
export const verifyWorkspaceConsent = async (
  query: string,
  secret: Redacted.Redacted<string>,
  sessionId: string,
) => {
  const params = new URLSearchParams(query);
  const signature = params.get("sig");
  if (
    signature === null ||
    params.get("ba_pl") !== sessionId ||
    !(await verifyOAuthQueryParams(query, Redacted.value(secret)))
  ) {
    return undefined;
  }
  return {
    id: `oauth-consent:${Buffer.from(signature.replace(/ /g, "+"), "base64").toString("hex")}`,
    expiresAt: new Date(Number(params.get("exp")) * 1000),
  };
};

const invalidConsent = () => new APIError("BAD_REQUEST", { error: "invalid_request" });

const isOAuthScope = Schema.is(OAuthScopeToken);

const tokenBinding = Schema.is(
  Schema.Struct({
    referenceId: Schema.String,
    clientId: Schema.String,
    userId: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
);

const oauthRedirect = Schema.is(
  Schema.Struct({ redirect: Schema.Literal(true), url: Schema.String }),
);

const consentRedirect = (page: URL, url: string) => {
  if (!URL.canParse(url, page.href)) return undefined;
  const redirect = new URL(url, page);
  if (
    redirect.origin !== page.origin ||
    redirect.pathname !== page.pathname ||
    !redirect.searchParams.has("sig")
  ) {
    return undefined;
  }
  const signedQuery = redirect.search.slice(1);
  const query = new URLSearchParams({ consent_id: Buffer.from(signedQuery).toString("base64url") });
  return `${page.pathname}?${query}`;
};

const exposeConsentId = async (response: Response, page: URL) => {
  const location = response.headers.get("location");
  if (location !== null) {
    const redirect = consentRedirect(page, location);
    if (redirect === undefined) return response;
    const headers = new Headers(response.headers);
    headers.set("location", redirect);
    return new Response(response.body, { status: response.status, headers });
  }

  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (!oauthRedirect(body)) return response;
  const redirect = consentRedirect(page, body.url);
  if (redirect === undefined) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json({ ...body, url: redirect }, { status: response.status, headers });
};

const scopeAliasesForGrant = <T>(client: T): T => {
  if (!decisionContext.getStore()?.accept && tokenContext.getStore() === undefined) return client;
  if (
    typeof client !== "object" ||
    client === null ||
    !("scopes" in client) ||
    !Array.isArray(client.scopes)
  ) {
    return client;
  }

  const raw = client.scopes.filter(isOAuthScope);
  const expanded = accessFromOAuthScopes(raw)?.access.scopes ?? [];
  const scopes = new Set<string>(raw);
  for (const scope of expanded) scopes.add(`kvitbit:${scope}`);
  if (READ_SCOPES.every((scope) => expanded.includes(scope))) scopes.add("kvitbit:read");
  if (ALL_SCOPES.every((scope) => expanded.includes(scope))) scopes.add("kvitbit:write");
  return { ...client, scopes: [...scopes] };
};

export const makeWorkspaceAuth = (
  sql: SqlClient.SqlClient,
  config: AuthConfig,
  runAuthEffect: AuthEffectRunner,
) => {
  const options = authOptions({
    ...config,
    beforeHooks: [
      ...(config.beforeHooks ?? []),
      {
        matcher: (ctx) => ctx.path === "/oauth2/consent",
        handler: createAuthMiddleware(async () => {
          // The provider's earlier hook verifies the signed query before populating this state.
          const decision = decisionContext.getStore();
          const state = await getOAuthProviderState();
          if (decision === undefined || state?.query === undefined) throw invalidConsent();
          if (decision.accept) {
            // The edge authorizes expanded scopes, so a preset may become individual wire scopes.
            const query = new URLSearchParams(state.query);
            query.set("scope", decision.scopes.join(" "));
            state.query = query.toString();
          }
        }),
      },
    ],
  });

  // Provider continuations carry the authorization parameters in `query` even
  // when the incoming sign-in or consent request was a POST.
  const guards = options.plugins[0].hooks;
  guards.before = guards.before.map((hook) => ({
    ...hook,
    handler: Object.assign(
      (ctx: Parameters<typeof hook.handler>[0]) =>
        hook.handler("authorizeSettings" in ctx ? Object.assign({}, ctx, { method: "GET" }) : ctx),
      hook.handler,
    ),
  }));

  const provider = options.plugins.find((plugin) => plugin.id === "oauth-provider");
  if (provider === undefined || !("options" in provider) || !("schema" in provider)) {
    throw new Error("Expected Better Auth's OAuth provider");
  }

  const providerOptions: OAuthOptions<string[]> = provider.options;
  providerOptions.postLogin = {
    page: config.oauthConsentPage,
    shouldRedirect: () => false,
    consentReferenceId: ({ user, session }) => {
      const decision = decisionContext.getStore();
      // An ordinary authorization request always needs the user's workspace selection.
      if (!decision?.accept) return generateId();
      if (user.id !== decision.userId || session.id !== decision.sessionId) throw invalidConsent();
      return decision.grantId;
    },
  };

  // This plugin initializes after CIMD registers its client discovery.
  const edgeHooks = options.plugins.find((plugin) => plugin.id === "kvitbit-edge-hooks");
  if (edgeHooks === undefined) throw new Error("Expected Kvitbit's Better Auth hooks");
  Object.assign(edgeHooks, {
    init: () => {
      for (const { clientDiscovery } of providerOptions.extensions ?? []) {
        const discoveries = Array.isArray(clientDiscovery) ? clientDiscovery : [clientDiscovery];
        for (const discovery of discoveries) {
          if (discovery === undefined) continue;
          const resolve = discovery.resolve;
          discovery.resolve = async (...args) => scopeAliasesForGrant(await resolve(...args));
        }
      }
    },
  });

  if (!("oauthAccessToken" in provider.schema) || !("oauthRefreshToken" in provider.schema)) {
    throw new Error("Expected Better Auth's token schemas");
  }
  // For tokens the provider's grant reference is the consent foreign key.
  Object.assign(provider.schema.oauthAccessToken.fields.referenceId, { fieldName: "consentId" });
  Object.assign(provider.schema.oauthRefreshToken.fields.referenceId, { fieldName: "consentId" });

  const activeGrant = (binding: Parameters<typeof tokenBinding>[0]) => {
    if (!tokenBinding(binding)) return Effect.succeed(false);
    return sql<{ id: string }>`
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
  };

  const serverOptions: ReturnType<typeof authOptions> &
    Pick<BetterAuthOptions, "logger" | "onAPIError"> = {
    ...options,
    // Better Auth can pass raw SQL parameters and authentication material to its logger.
    logger: { disabled: true },
    // Better Call otherwise prints unexpected errors directly to stderr.
    onAPIError: { throw: true },
    database: (initOptions) => {
      const adapter = options.database(initOptions);
      return {
        ...adapter,
        findOne: async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
          const tokenRequest = tokenContext.getStore();
          const refreshDigest =
            tokenRequest !== undefined && input.model === "oauthRefreshToken"
              ? input.where.find(({ field }) => field === "token")?.value
              : undefined;
          if (typeof refreshDigest === "string") {
            // The second request must see the completed rotation and its replay response.
            await runDrizzleEffect(sql`
              select 1 from pg_advisory_xact_lock(hashtextextended(${`oauth-refresh:${refreshDigest}`}, 0))
            `);
          }
          const row = await adapter.findOne<T>(input);
          if (input.model === "oauthClient") return scopeAliasesForGrant(row);

          if (tokenRequest !== undefined && typeof refreshDigest === "string") {
            if (!tokenBinding(row) || !(await runDrizzleEffect(activeGrant(row)))) return null;
            tokenRequest.grantId = row.referenceId;
            tokenRequest.refreshDigest = refreshDigest;
          }
          return row;
        },
        deleteMany: (input) => {
          if (
            (input.model === "oauthAccessToken" || input.model === "oauthRefreshToken") &&
            input.where.some(({ field }) => field === "clientId") &&
            input.where.some(({ field }) => field === "userId")
          ) {
            // The provider's refresh reuse cleanup otherwise targets every workspace for this client and user.
            const grantId = tokenContext.getStore()?.grantId;
            if (grantId === undefined) return Promise.resolve(0);
            return adapter.deleteMany({
              ...input,
              where: [...input.where, { field: "referenceId", value: grantId }],
            });
          }
          return adapter.deleteMany(input);
        },
        create: <T extends Record<string, unknown>, R = T>(input: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }) => {
          if (input.model === "rateLimit" && tokenContext.getStore() !== undefined) {
            // Better Auth retries a duplicate cold-bucket insert. Roll back only the insert
            // so its retry can read and increment the winning row in the same transaction.
            return runDrizzleEffect(
              sql.withTransaction(withDrizzleSqlContext(() => adapter.create<T, R>(input))),
            );
          }
          if (input.model !== "oauthAccessToken" && input.model !== "oauthRefreshToken") {
            return adapter.create<T, R>(input);
          }

          return runDrizzleEffect(
            sql.withTransaction(
              Effect.gen(function* () {
                if (!(yield* activeGrant(input.data))) {
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
  };
  const auth = betterAuth<ReturnType<typeof authOptions>>(serverOptions);
  const handle = async (request: Request) => {
    try {
      return await auth.handler(request);
    } catch (error) {
      if (
        !(
          error instanceof EmailRejected ||
          error instanceof EmailNotAccepted ||
          error instanceof EmailOutcomeUnknown
        )
      ) {
        await runAuthEffect(Effect.logError("Authentication request failed"));
      }
      return new Response(null, { status: 500, statusText: "Internal Server Error" });
    }
  };

  const consentPage = new URL(config.oauthConsentPage, config.baseURL);
  return {
    ...auth,
    fetch: handle,
    handler: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (
        request.method !== "POST" ||
        (path !== "/api/auth/oauth2/token" && path !== "/api/auth/oauth2/revoke")
      ) {
        return exposeConsentId(await handle(request), consentPage);
      }
      const tokenRequest: TokenRequest = {};
      return runDrizzleEffect(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const response = yield* withDrizzleSqlContext(() =>
                tokenContext.run(tokenRequest, () => handle(request)),
              );
              // Provider 4xx responses can intentionally revoke a token family.
              if (response.status >= 500) return yield* Effect.fail(response);
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
                if (persisted.length === 0)
                  return yield* Effect.fail(new Error("Missing OAuth refresh replay"));
              }
              return response;
            }),
          )
          .pipe(
            Effect.provideService(
              SqlClient.BeginTransaction,
              "BEGIN ISOLATION LEVEL READ COMMITTED",
            ),
            Effect.catch((error) =>
              Effect.succeed(
                error instanceof Response
                  ? error
                  : Response.json(
                      { error: "server_error" },
                      {
                        status: 500,
                        headers: { "cache-control": "no-store", pragma: "no-cache" },
                      },
                    ),
              ),
            ),
          ),
      );
    },
  };
};
