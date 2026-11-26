/**
 * `oauthConsent` group handlers (http-mcp-contracts 3.5.2, 6.2-6.3; board agreement #889).
 *
 * Bridges P16 (`/oauth/consent`) to Better Auth's OAuth 2.1 provider (`/api/auth/oauth2/consent`)
 * and binds the Workspace, AccessMode and expanded core `Scope[]` onto `auth.oauth_consent`.
 */
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
  readonly originalWireScopes: ReadonlyArray<string>;
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
    originalWireScopes: rawScopes,
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
          const nowMs = yield* Clock.currentTimeMillis;
          const parsed = parseConsentRequest(params.consentId, nowMs);
          if (parsed === undefined) {
            return yield* new NotFound({ entity: "Workspace", id: params.consentId });
          }

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
          const principal = yield* CurrentPrincipal;
          const request = yield* HttpServerRequest;
          const nowMs = yield* Clock.currentTimeMillis;
          const parsed = parseConsentRequest(params.consentId, nowMs);
          if (parsed === undefined) {
            return yield* new NotFound({ entity: "Workspace", id: params.consentId });
          }

          yield* loadClient(parsed, params.consentId);

          if (payload._tag === "Deny") {
            const response = yield* Effect.tryPromise({
              try: () =>
                auth.handler(
                  new Request(`${config.appOrigin}/api/auth/oauth2/consent`, {
                    method: "POST",
                    headers: forwardHeaders(request),
                    body: JSON.stringify({
                      accept: false,
                      oauth_query: parsed.oauthQuery,
                    }),
                  }),
                ),
              catch: () => new Unavailable({ dependency: "database" }),
            });
            if (!response.ok) {
              return yield* new NotFound({ entity: "Workspace", id: params.consentId });
            }
            const body = yield* Effect.tryPromise({
              try: () => response.json() as Promise<{ url?: string }>,
              catch: () => new Unavailable({ dependency: "database" }),
            });
            if (typeof body.url !== "string" || body.url.length === 0) {
              return yield* new NotFound({ entity: "Workspace", id: params.consentId });
            }
            return { redirectTo: body.url };
          }

          // Approve: re-check membership and cap scopes against offerableScopes.
          const member = yield* workspaces.enter(payload.workspace, {
            scopes: "all",
            channel: principal.channel,
          });
          const expanded = expandAccess(payload.grant);
          const requestedSet = new Set(parsed.requestedScopes);
          const offerable = new Set(
            grantableScopesForRole(member.role).filter((scope) => requestedSet.has(scope)),
          );
          if (
            expanded.scopes.length === 0 ||
            expanded.scopes.some((scope) => !offerable.has(scope))
          ) {
            return yield* new Forbidden({ action: "grant.create" });
          }

          const wireScopes = wireScopesForGrant(
            expanded.access,
            expanded.scopes,
            parsed.offlineAccess,
          );
          const allInOriginal = wireScopes.every((s) => parsed.originalWireScopes.includes(s));

          const response = yield* Effect.tryPromise({
            try: () =>
              auth.handler(
                new Request(`${config.appOrigin}/api/auth/oauth2/consent`, {
                  method: "POST",
                  headers: forwardHeaders(request),
                  body: JSON.stringify({
                    accept: true,
                    oauth_query: parsed.oauthQuery,
                    ...(allInOriginal ? { scope: wireScopes.join(" ") } : {}),
                  }),
                }),
              ),
            catch: () => new Unavailable({ dependency: "database" }),
          });

          if (!response.ok) {
            if (response.status === 400) {
              return yield* new Invalid({
                issues: [{ path: ["consentId"], code: "request.malformed" }],
              });
            }
            return yield* new NotFound({ entity: "Workspace", id: params.consentId });
          }

          const body = yield* Effect.tryPromise({
            try: () => response.json() as Promise<{ url?: string }>,
            catch: () => new Unavailable({ dependency: "database" }),
          });
          if (typeof body.url !== "string" || body.url.length === 0) {
            return yield* new NotFound({ entity: "Workspace", id: params.consentId });
          }

          // Bind workspace_id, access and granted_scopes onto the auth.oauth_consent row (#889).
          yield* sql`
            update auth.oauth_consent
            set
              workspace_id = ${payload.workspace}::uuid,
              access = ${expanded.access}::access_mode,
              granted_scopes = ${[...expanded.scopes]}::text[],
              scopes = ${[...wireScopes]}::text[],
              updated_at = ${new Date(nowMs)}
            where client_id = ${parsed.clientId}
              and user_id = ${principal.userId}
              and (workspace_id is null or workspace_id = ${payload.workspace}::uuid)`.pipe(
            Effect.mapError(() => new Unavailable({ dependency: "database" })),
          );

          return { redirectTo: body.url };
        }),
      );
  }),
);
