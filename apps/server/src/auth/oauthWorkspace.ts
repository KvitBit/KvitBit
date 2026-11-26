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
import { Effect, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { runDrizzleEffect, withDrizzleSqlContext } from "./drizzleBridge";

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
const tokenContext = new AsyncLocalStorage<{ grantId?: string }>();

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

export const makeWorkspaceAuth = (sql: SqlClient.SqlClient) => (config: AuthConfig) => {
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

  const auth = betterAuth({
    ...options,
    database: (initOptions) => {
      const adapter = options.database(initOptions);
      return {
        ...adapter,
        findOne: async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
          const row = await adapter.findOne<T>(input);
          if (input.model === "oauthClient") return scopeAliasesForGrant(row);

          const tokenRequest = tokenContext.getStore();
          if (
            tokenRequest !== undefined &&
            input.model === "oauthRefreshToken" &&
            input.where.some(({ field }) => field === "token")
          ) {
            if (!tokenBinding(row) || !(await runDrizzleEffect(activeGrant(row)))) return null;
            tokenRequest.grantId = row.referenceId;
          }
          return row;
        },
        deleteMany: (input) => {
          const grantId = tokenContext.getStore()?.grantId;
          if (
            grantId !== undefined &&
            (input.model === "oauthAccessToken" || input.model === "oauthRefreshToken") &&
            input.where.some(({ field }) => field === "clientId") &&
            input.where.some(({ field }) => field === "userId")
          ) {
            // The provider's refresh reuse cleanup otherwise targets every workspace for this client and user.
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
  });

  return {
    ...auth,
    handler: (request: Request) =>
      new URL(request.url).pathname === "/api/auth/oauth2/token"
        ? tokenContext.run({}, () => auth.handler(request))
        : auth.handler(request),
  };
};
