/**
 * Live `PrincipalResolver` (http-mcp-contracts 2.1, 6.2-6.4; settled agreement #887/#889).
 *
 * - `fromApiRequest`: session cookie, session bearer, or `kvb_` Workspace API Key.
 * - `fromMcpBearer`: opaque OAuth 2.1 access token bound strictly to `${appOrigin}/mcp`,
 *   with `grantId = auth.oauth_consent.id` and `scopes = expanded(token.scopes) ∩ consent.granted_scopes`.
 */

import { apiKeyMatches, isApiKeyBearer, parseApiKey } from "@kvitbit/adapters/auth";
import {
  accessFromOAuthScopes,
  normalizeScopes,
  OAuthScopeToken,
  type Principal,
  SESSION_COOKIE,
  Unauthorized,
} from "@kvitbit/api-contract";
import { type Locale, Scope, UserId, WorkspaceId } from "@kvitbit/domain/contract";
import { CryptoHasher } from "bun";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpConfig } from "../http/config";
import { bearerToken, resolveLocale } from "../http/edge/request";
import { AuthServer } from "./AuthServer";
import { withDrizzleSqlContext } from "./drizzleBridge";
import { PrincipalResolver } from "./PrincipalResolver";

const isOAuthScopeToken = Schema.is(OAuthScopeToken);
const isCoreScope = Schema.is(Scope);

const hashOpaqueToken = (token: string): string => CryptoHasher.hash("sha256", token, "base64url");

const hasSessionCookie = (cookieHeader: string | null): boolean => {
  if (cookieHeader === null) return false;
  return Arr.some(
    Arr.map(Str.split(cookieHeader, ";"), (part) => Str.trim(part)),
    (part) =>
      Str.startsWith(`${SESSION_COOKIE}=`)(part) || Str.startsWith("kvitbit.session_token=")(part),
  );
};

const isString = Schema.is(Schema.String);
const dateValue = Schema.is(Schema.Union([Schema.Date, Schema.String]));
const toDate = <A>(value: A) => (dateValue(value) ? Option.getOrNull(DateTime.make(value)) : null);

const toStringArray = <A>(value: A): ReadonlyArray<string> => {
  if (Arr.isArray(value)) return Arr.filter(value, isString);
  if (isString(value) && Str.startsWith("{")(value) && Str.endsWith("}")(value)) {
    const inner = Str.slice(1, -1)(value);
    if (inner.length === 0) return [];
    return Arr.map(Str.split(inner, ","), (item) => Str.replace(/^"|"$/g, "")(item));
  }
  return [];
};

const userLocaleOf = (
  sql: SqlClient.SqlClient,
  userId: string,
  acceptLanguage: string | undefined,
): Effect.Effect<Locale> =>
  sql<{ locale: Locale | null }>`
    select locale from user_preferences where user_id = ${userId} limit 1`.pipe(
    Effect.map((rows) => resolveLocale(rows[0]?.locale, acceptLanguage)),
    Effect.catchCause(() => Effect.succeed(resolveLocale(undefined, acceptLanguage))),
  );

export const PrincipalResolverLive = Layer.effect(
  PrincipalResolver,
  Effect.gen(function* () {
    const auth = yield* AuthServer;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* HttpConfig;
    const mcpAudience = `${config.appOrigin}/mcp`;

    const resolveApiKey = Effect.fn("resolveApiKey")(function* (
      bearer: string,
      acceptLanguage: string | undefined,
    ) {
      const parts = parseApiKey(bearer);
      if (Option.isNone(parts)) return yield* Unauthorized.make({ reason: "invalid" });
      const keyId = parts.value.keyId;

      const rows = yield* sql<{
        id: string;
        name: string | null;
        key: string;
        enabled: boolean;
        expires_at: Date | string | null;
        workspace_id: string;
        created_by: string;
        scopes: unknown;
        email: string;
        deleted_at: Date | string | null;
        locale: Locale | null;
      }>`
          select
            k.id, k.name, k.key, k.enabled, k.expires_at,
            k.workspace_id, k.created_by, k.scopes,
            u.email, u.deleted_at, p.locale
          from auth.apikey k
          join auth."user" u on u.id = k.created_by
          left join user_preferences p on p.user_id = u.id
          where k.id = ${keyId}
          limit 1`.pipe(Effect.mapError(() => Unauthorized.make({ reason: "invalid" })));

      const row = rows[0];
      if (row === undefined || !row.enabled || row.deleted_at !== null) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }
      if (!apiKeyMatches(bearer, row.key)) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAt = toDate(row.expires_at);
      if (expiresAt !== null && DateTime.toEpochMillis(expiresAt) <= nowMs) {
        return yield* Unauthorized.make({ reason: "expired" });
      }

      const scopes = normalizeScopes(Arr.filter(toStringArray(row.scopes), isCoreScope));
      if (scopes.length === 0) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      // Best-effort last_request timestamp update; never fail authentication on it.
      yield* sql`
          update auth.apikey set last_request = ${DateTime.toDateUtc(DateTime.makeUnsafe(nowMs))} where id = ${keyId}`.pipe(
        Effect.ignore,
      );

      return {
        userId: UserId.make(row.created_by),
        email: row.email,
        channel: "api",
        locale: resolveLocale(row.locale, acceptLanguage),
        credential: {
          _tag: "ApiKey",
          keyId,
          keyName: row.name ?? keyId,
          workspaceId: WorkspaceId.make(row.workspace_id),
          scopes,
        },
      } satisfies Principal;
    });

    const fromApiRequest = Effect.fn("fromApiRequest")(function* (request: Request) {
      const acceptLanguage = request.headers.get("accept-language") ?? undefined;
      const bearer = bearerToken(request.headers.get("authorization") ?? undefined);
      const hasCookie = hasSessionCookie(request.headers.get("cookie"));

      if (bearer === undefined && !hasCookie) {
        return yield* Unauthorized.make({ reason: "missing" });
      }

      // Rule A1: kvb_ prefix decides API Key lookup.
      if (bearer !== undefined && isApiKeyBearer(bearer)) {
        return yield* resolveApiKey(bearer, acceptLanguage);
      }

      const sessionResult = yield* withDrizzleSqlContext(() =>
        auth.api.getSession({ headers: request.headers }),
      ).pipe(Effect.mapError(() => Unauthorized.make({ reason: "invalid" })));
      if (sessionResult === null || sessionResult === undefined) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      const { session, user } = sessionResult;
      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAt = toDate(session.expiresAt);
      if (expiresAt !== null && DateTime.toEpochMillis(expiresAt) <= nowMs) {
        return yield* Unauthorized.make({ reason: "expired" });
      }

      // Reject soft-deleted users.
      const tombstone = yield* sql<{ deleted_at: Date | string | null }>`
          select deleted_at from auth."user" where id = ${user.id} limit 1`.pipe(
        Effect.mapError(() => Unauthorized.make({ reason: "invalid" })),
      );
      if (tombstone[0] === undefined || tombstone[0].deleted_at !== null) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      const locale = yield* userLocaleOf(sql, user.id, acceptLanguage);
      const createdAt = toDate(session.createdAt) ?? DateTime.makeUnsafe(nowMs);

      return {
        userId: UserId.make(user.id),
        email: user.email,
        channel: bearer !== undefined ? "mobile" : "web",
        locale,
        credential: {
          _tag: "Session",
          sessionId: session.id,
          authenticatedAt: DateTime.formatIso(createdAt),
        },
      } satisfies Principal;
    });

    const fromMcpBearer = Effect.fn("fromMcpBearer")(function* (request: Request) {
      const acceptLanguage = request.headers.get("accept-language") ?? undefined;
      const bearer = bearerToken(request.headers.get("authorization") ?? undefined);
      if (bearer === undefined) {
        return yield* Unauthorized.make({ reason: "missing" });
      }
      // Rule A1: API keys are never accepted on /mcp.
      if (isApiKeyBearer(bearer)) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      const digest = hashOpaqueToken(bearer);
      const rows = yield* sql<{
        token_id: string;
        token_scopes: unknown;
        token_resources: unknown;
        token_expires_at: Date | string | null;
        token_revoked: Date | string | null;
        consent_id: string | null;
        workspace_id: string | null;
        granted_scopes: unknown;
        client_id: string;
        client_name: string | null;
        client_disabled: boolean | null;
        user_id: string | null;
        email: string | null;
        deleted_at: Date | string | null;
        locale: Locale | null;
      }>`
          select
            t.id as token_id,
            t.scopes as token_scopes,
            t.resources as token_resources,
            t.expires_at as token_expires_at,
            t.revoked as token_revoked,
            c.id as consent_id,
            w.id as workspace_id,
            c.granted_scopes,
            cl.client_id,
            cl.name as client_name,
            cl.disabled as client_disabled,
            u.id as user_id,
            u.email,
            u.deleted_at,
            p.locale
          from auth.oauth_access_token t
          join auth.oauth_client cl on cl.client_id = t.client_id
          left join auth.oauth_consent c
            on c.id = t.consent_id and c.client_id = t.client_id and c.user_id = t.user_id
          left join workspaces w on w.id = c.workspace_id and w.closed_at is null
          left join auth."user" u on u.id = t.user_id
          left join user_preferences p on p.user_id = u.id
          where t.token = ${digest}
          limit 1`.pipe(Effect.mapError(() => Unauthorized.make({ reason: "invalid" })));

      const row = rows[0];
      if (
        row === undefined ||
        row.token_revoked !== null ||
        row.client_disabled === true ||
        row.user_id === null ||
        row.email === null ||
        row.deleted_at !== null
      ) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAt = toDate(row.token_expires_at);
      if (expiresAt === null || DateTime.toEpochMillis(expiresAt) <= nowMs) {
        return yield* Unauthorized.make({ reason: "expired" });
      }

      // Strict audience check (#887/#889): must include ${appOrigin}/mcp.
      const resources = toStringArray(row.token_resources);
      if (!resources.includes(mcpAudience)) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      // Bound consent row required (#889): workspace_id and granted_scopes must be present.
      if (row.consent_id === null || row.workspace_id === null) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }
      const consentScopes = new Set(Arr.filter(toStringArray(row.granted_scopes), isCoreScope));
      if (consentScopes.size === 0) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      // Expand token OAuth wire scopes via access.ts and intersect with consent.granted_scopes.
      const wireTokens = Arr.filter(toStringArray(row.token_scopes), isOAuthScopeToken);
      const parsed = accessFromOAuthScopes(wireTokens);
      if (parsed === undefined) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }
      const scopes = normalizeScopes(
        Arr.filter(parsed.access.scopes, (scope) => consentScopes.has(scope)),
      );
      if (scopes.length === 0) {
        return yield* Unauthorized.make({ reason: "invalid" });
      }

      // Best-effort last_used_at update on the grant.
      yield* sql`
          update auth.oauth_consent set last_used_at = ${DateTime.toDateUtc(DateTime.makeUnsafe(nowMs))} where id = ${row.consent_id}`.pipe(
        Effect.ignore,
      );

      return {
        userId: UserId.make(row.user_id),
        email: row.email,
        channel: "mcp",
        locale: resolveLocale(row.locale, acceptLanguage),
        credential: {
          _tag: "McpGrant",
          grantId: row.consent_id,
          clientId: row.client_id,
          clientName: row.client_name ?? row.client_id,
          workspaceId: WorkspaceId.make(row.workspace_id),
          scopes,
        },
      } satisfies Principal;
    });

    return PrincipalResolver.of({ fromApiRequest, fromMcpBearer });
  }),
);
