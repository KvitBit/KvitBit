/**
 * `oauthConsent` group handlers (http-mcp-contracts 3.5.2, 6.2-6.3; board agreement #889).
 *
 * Bridges P16 (`/oauth/consent`) to Better Auth's OAuth 2.1 provider (`/api/auth/oauth2/consent`)
 * and binds the Workspace, AccessMode and expanded core `Scope[]` onto `auth.oauth_consent`.
 */

import { generateId } from "@kvitbit/adapters/auth";
import { transactionWithRetry } from "@kvitbit/adapters/sql";
import {
  ALL_SCOPES,
  Api,
  accessFromOAuthScopes,
  CurrentPrincipal,
  expandAccess,
  normalizeScopes,
  OAUTH_OFFLINE_ACCESS,
  OAuthScopeToken,
  READ_SCOPES,
} from "@kvitbit/api-contract";
import {
  Forbidden,
  Invalid,
  NotFound,
  type Role,
  type Scope,
  Unavailable,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Clock, Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { AuthServer } from "../../auth/AuthServer";
import { bindAuthLogging } from "../../auth/logging";
import { processWorkspaceConsent, verifyWorkspaceConsent } from "../../auth/oauthWorkspace";
import { HttpConfig } from "../config";

const isOAuthScopeToken = Schema.is(OAuthScopeToken);

const MEMBER_WRITE_SCOPES: ReadonlyArray<Scope> = [
  "contacts:write",
  "catalog:write",
  "templates:write",
  "expenses:write",
  "documents:write",
  "share:write",
  "payments:write",
];

const grantableScopesForRole = (role: Role): ReadonlyArray<Scope> => {
  switch (role) {
    case "accountant":
      return READ_SCOPES;
    case "member":
      return normalizeScopes([...READ_SCOPES, ...MEMBER_WRITE_SCOPES]);
    case "admin":
    case "owner":
      return ALL_SCOPES;
  }
};

const maxAccessForRole = (role: Role): "read" | "read_write" =>
  role === "accountant" ? "read" : "read_write";

const toStringArray = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    if (inner.length === 0) return [];
    return inner.split(",").map((item) => item.replace(/^"|"$/g, ""));
  }
  return [];
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const redirectUriMatches = (registered: ReadonlyArray<string>, candidate: string): boolean => {
  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    return false;
  }
  for (const uri of registered) {
    if (uri === candidate) return true;
    try {
      const regUrl = new URL(uri);
      // RFC 8252 / 6.2 step 4: loopback redirects may use any port.
      if (
        isLoopbackHost(regUrl.hostname) &&
        isLoopbackHost(candidateUrl.hostname) &&
        regUrl.protocol === candidateUrl.protocol &&
        regUrl.hostname === candidateUrl.hostname &&
        regUrl.pathname === candidateUrl.pathname
      ) {
        return true;
      }
    } catch {
      // Ignore malformed stored entry.
    }
  }
  return false;
};

/** Decodes `consentId` (either a raw query string or base64url-encoded query string). */
const decodeConsentQuery = (consentId: string): string => {
  if (consentId.includes("client_id=")) return consentId;
  try {
    const decoded = Buffer.from(consentId, "base64url").toString("utf8");
    if (decoded.includes("client_id=")) return decoded;
  } catch {
    // Fall through to raw query.
  }
  return consentId;
};

interface ParsedConsentRequest {
  readonly oauthQuery: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly redirectHost: string;
  readonly requestedAccess: "read" | "read_write" | "custom";
  readonly requestedScopes: ReadonlyArray<Scope>;
  readonly offlineAccess: boolean;
}

const parseConsentRequest = (
  consentId: string,
  nowMs: number,
): ParsedConsentRequest | undefined => {
  const oauthQuery = decodeConsentQuery(consentId);
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || !redirectUri) return undefined;

  let redirectHost: string;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    return undefined;
  }

  const expRaw = params.get("exp");
  if (expRaw !== null) {
    const expSec = Number(expRaw);
    if (!Number.isFinite(expSec) || expSec * 1000 <= nowMs) return undefined;
  }

  const rawScopes = (params.get("scope") ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validTokens = rawScopes.filter(isOAuthScopeToken);
  const parsed = accessFromOAuthScopes(validTokens);
  if (parsed === undefined) return undefined;

  return {
    oauthQuery,
    clientId,
    redirectUri,
    redirectHost,
    requestedAccess: parsed.access.access,
    requestedScopes: parsed.access.scopes,
    offlineAccess: parsed.offlineAccess,
  };
};

const wireScopesForGrant = (
  access: "read" | "read_write" | "custom",
  scopes: ReadonlyArray<Scope>,
  offlineAccess: boolean,
): ReadonlyArray<string> => {
  const base =
    access === "read"
      ? ["kvitbit:read"]
      : access === "read_write"
        ? ["kvitbit:write"]
        : scopes.map((s) => `kvitbit:${s}`);
  return offlineAccess ? [...base, OAUTH_OFFLINE_ACCESS] : base;
};

const forwardHeaders = (request: HttpServerRequest): Headers => {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (request.headers.cookie !== undefined) headers.set("cookie", request.headers.cookie);
  if (request.headers.authorization !== undefined) {
    headers.set("authorization", request.headers.authorization);
  }
  if (request.headers.origin !== undefined) headers.set("origin", request.headers.origin);
  return headers;
};

export const OauthConsentGroupLive = HttpApiBuilder.group(Api, "oauthConsent", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthServer;
    const sql = yield* SqlClient.SqlClient;
    const workspaces = yield* Workspaces;
    const config = yield* HttpConfig;

    const loadConsent = (consentId: string) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const nowMs = yield* Clock.currentTimeMillis;
        const parsed = parseConsentRequest(consentId, nowMs);
        const notFound = new NotFound({ entity: "Workspace", id: consentId });
        if (parsed === undefined || principal.credential._tag !== "Session") {
          return yield* notFound;
        }
        const sessionId = principal.credential.sessionId;
        const decision = yield* Effect.promise(() =>
          verifyWorkspaceConsent(parsed.oauthQuery, config.visitorSecret, sessionId),
        );
        if (decision === undefined) return yield* notFound;
        return { principal, sessionId, parsed, decision, notFound, nowMs };
      });

    const loadClient = (parsed: ParsedConsentRequest, consentId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          client_id: string;
          name: string | null;
          icon: string | null;
          disabled: boolean | null;
          redirect_uris: unknown;
        }>`
          select client_id, name, icon, disabled, redirect_uris
          from auth.oauth_client
          where client_id = ${parsed.clientId}
          limit 1`.pipe(Effect.mapError(() => new Unavailable({ dependency: "database" })));
        const client = rows[0];
        if (
          client === undefined ||
          client.disabled === true ||
          !redirectUriMatches(toStringArray(client.redirect_uris), parsed.redirectUri)
        ) {
          return yield* new NotFound({ entity: "Workspace", id: consentId });
        }
        return client;
      });

    return handlers
      .handle("getConsent", ({ params }) =>
        Effect.gen(function* () {
          const { parsed, decision, notFound } = yield* loadConsent(params.consentId);
          const used = yield* sql`select id from auth.verification where id = ${decision.id}`.pipe(
            Effect.mapError(() => new Unavailable({ dependency: "database" })),
          );
          if (used.length > 0) return yield* notFound;

          const client = yield* loadClient(parsed, params.consentId);
          const mine = yield* workspaces.listMine;

          const requestedSet = new Set(parsed.requestedScopes);
          const consentWorkspaces = mine.map((ws) => {
            const grantable = grantableScopesForRole(ws.role);
            const offerable = grantable.filter((scope) => requestedSet.has(scope));
            return {
              id: ws.id,
              name: ws.name,
              role: ws.role,
              maxAccess: maxAccessForRole(ws.role),
              grantableScopes: [...grantable],
              offerableScopes: offerable,
            };
          });

          return {
            client: {
              id: client.client_id,
              name: client.name ?? client.client_id,
              redirectHost: parsed.redirectHost,
              logoUri: client.icon ?? null,
            },
            requestedAccess: parsed.requestedAccess,
            requestedScopes: [...parsed.requestedScopes],
            workspaces: consentWorkspaces,
          };
        }),
      )
      .handle("decide", ({ params, payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const { principal, sessionId, parsed, decision, notFound, nowMs } = yield* loadConsent(
            params.consentId,
          );
          yield* loadClient(parsed, params.consentId);

          return yield* transactionWithRetry(
            Effect.gen(function* () {
              const claimed = yield* sql`
              insert into auth.verification (id, identifier, value, expires_at)
              values (${decision.id}, ${decision.id}, '', ${decision.expiresAt})
              on conflict (id) do nothing
              returning id`;
              if (claimed.length === 0) return yield* notFound;

              const accept = payload._tag === "Approve";
              let providerDecision: Parameters<typeof processWorkspaceConsent>[0] = {
                accept: false,
              };
              if (accept) {
                // Membership removal and role changes take this same workspace lock.
                const openWorkspaces = yield* sql`
                    select id from workspaces
                    where id = ${payload.workspace} and closed_at is null
                    for update
                  `;
                if (openWorkspaces.length === 0) return yield* notFound;
                const member = yield* workspaces.enter(payload.workspace, {
                  scopes: "all",
                  channel: principal.channel,
                });
                const expanded = expandAccess(payload.grant);
                const requestedSet = new Set(parsed.requestedScopes);
                const offerable = grantableScopesForRole(member.role).filter((scope) =>
                  requestedSet.has(scope),
                );
                if (
                  expanded.scopes.length === 0 ||
                  expanded.scopes.some((scope) => !offerable.includes(scope))
                ) {
                  return yield* new Forbidden({ action: "grant.create" });
                }

                const wireScopes = wireScopesForGrant(
                  expanded.access,
                  expanded.scopes,
                  parsed.offlineAccess,
                );
                const referenceId = generateId();
                const grants = yield* sql<{ id: string }>`
                insert into auth.oauth_consent as existing
                  (id, reference_id, client_id, user_id, workspace_id, access, granted_scopes, scopes, created_at, updated_at)
                select ${referenceId}, ${referenceId}, ${parsed.clientId}, ${principal.userId},
                  w.id, ${expanded.access}::access_mode, ${[...expanded.scopes]}::text[],
                  ${[...wireScopes]}::text[], ${new Date(nowMs)}, ${new Date(nowMs)}
                from workspaces w where w.id = ${payload.workspace}::uuid and w.closed_at is null
                on conflict (client_id, user_id, workspace_id) do update set
                  reference_id = existing.id,
                  access = excluded.access,
                  granted_scopes = excluded.granted_scopes,
                  scopes = excluded.scopes,
                  updated_at = excluded.updated_at
                returning id`;
                const grant = grants[0];
                if (grant === undefined) return yield* notFound;
                providerDecision = {
                  accept: true,
                  grantId: grant.id,
                  userId: principal.userId,
                  sessionId,
                  scopes: wireScopes,
                };
              }

              const runAuth = yield* bindAuthLogging;
              const response = yield* processWorkspaceConsent(providerDecision, () =>
                runAuth(() =>
                  auth.handler(
                    new Request(`${config.appOrigin}/api/auth/oauth2/consent`, {
                      method: "POST",
                      headers: forwardHeaders(request),
                      body: JSON.stringify({ accept, oauth_query: parsed.oauthQuery }),
                    }),
                  ),
                ),
              ).pipe(Effect.mapError(() => new Unavailable({ dependency: "database" })));
              if (response.status >= 500) return yield* new Unavailable({ dependency: "database" });
              if (!response.ok) return yield* notFound;

              const callback = yield* Effect.tryPromise({
                try: async () => {
                  const body = (await response.json()) as { url: string };
                  return new URL(body.url);
                },
                catch: () => notFound,
              });
              if (
                accept
                  ? !callback.searchParams.has("code")
                  : callback.searchParams.get("error") !== "access_denied"
              ) {
                return yield* new Invalid({
                  issues: [{ path: ["consentId"], code: "request.malformed" }],
                });
              }
              return { redirectTo: callback.href };
            }),
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", () => new Unavailable({ dependency: "database" })),
          );
        }),
      );
  }),
);
