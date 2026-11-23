/**
 * Access requests, stored grants and the OAuth scope wire form (http-mcp-contracts sections
 * 2.2 and 6.3). Core spells scopes `<area>:<level>`; OAuth spells them `kvitbit:<area>:<level>`
 * plus the presets `kvitbit:read` and `kvitbit:write`. Both forms meet only here.
 */

import { SCOPE_AREAS, Scope, ScopeArea, ScopeLevel } from "@kvitbit/domain/contract";
import { Schema, SchemaTransformation } from "effect";

export const AccessMode = Schema.Literals(["read", "read_write", "custom"]);
export type AccessMode = typeof AccessMode.Type;

export const AccessPreset = Schema.Literals(["read", "read_write"]);
export type AccessPreset = typeof AccessPreset.Type;

/** What a creator or consenting user asks for. Presets expand server-side; custom is non-empty. */
export const AccessRequest = Schema.Union([
  Schema.Struct({ access: AccessPreset }),
  Schema.Struct({ access: Schema.Literal("custom"), scopes: Schema.NonEmptyArray(Scope) }),
]);
export type AccessRequest = typeof AccessRequest.Type;

/** What a stored credential carries: the mode as chosen plus the expanded list. */
export const GrantedAccess = Schema.Struct({ access: AccessMode, scopes: Schema.Array(Scope) });
export type GrantedAccess = typeof GrantedAccess.Type;

const scopeOf = (area: ScopeArea, level: ScopeLevel): Scope => `${area}:${level}`;

/** Every core scope in canonical order: per area, read before write. */
export const ALL_SCOPES: ReadonlyArray<Scope> = SCOPE_AREAS.flatMap((area) => [
  scopeOf(area, "read"),
  scopeOf(area, "write"),
]);
export const READ_SCOPES: ReadonlyArray<Scope> = SCOPE_AREAS.map((area) => scopeOf(area, "read"));

/** Canonical, de-duplicated scope list where `<area>:write` adds `<area>:read`. */
export const normalizeScopes = (scopes: Iterable<Scope>): ReadonlyArray<Scope> => {
  const wanted = new Set<Scope>();
  for (const scope of scopes) {
    wanted.add(scope);
    const [area, level] = scope.split(":") as [ScopeArea, ScopeLevel];
    if (level === "write") wanted.add(scopeOf(area, "read"));
  }
  return ALL_SCOPES.filter((scope) => wanted.has(scope));
};

/** Expands a request to the stored scope list (section 2.2). Role caps are the server's job. */
export const expandAccess = (request: AccessRequest): GrantedAccess => {
  switch (request.access) {
    case "read":
      return { access: "read", scopes: READ_SCOPES };
    case "read_write":
      return { access: "read_write", scopes: ALL_SCOPES };
    case "custom":
      return { access: "custom", scopes: normalizeScopes(request.scopes) };
  }
};

// --- OAuth wire form ---------------------------------------------------------------------------

export const OAUTH_SCOPE_PREFIX = "kvitbit:";

/** `kvitbit:<area>:<level>` on the wire. */
export const OAuthAreaScope = Schema.TemplateLiteral(["kvitbit:", ScopeArea, ":", ScopeLevel]);
export type OAuthAreaScope = typeof OAuthAreaScope.Type;

/** Decodes `kvitbit:<area>:<level>` to the core `Scope` and encodes it back. */
export const ScopeFromOAuth = OAuthAreaScope.pipe(
  Schema.decodeTo(
    Scope,
    SchemaTransformation.transform<Scope, OAuthAreaScope>({
      decode: (wire) => wire.slice(OAUTH_SCOPE_PREFIX.length) as Scope,
      encode: (scope) => `${OAUTH_SCOPE_PREFIX}${scope}`,
    }),
  ),
);

export const OAuthPresetScope = Schema.Literals(["kvitbit:read", "kvitbit:write"]);
export type OAuthPresetScope = typeof OAuthPresetScope.Type;

/** One token of the OAuth `scope` parameter that Kvitbit understands. */
export const OAuthScopeToken = Schema.Union([
  OAuthPresetScope,
  OAuthAreaScope,
  Schema.Literal("offline_access"),
]);
export type OAuthScopeToken = typeof OAuthScopeToken.Type;

/** `scopes_supported` of the protected resource metadata (section 6.2), in that order. */
export const OAUTH_SCOPES_SUPPORTED: ReadonlyArray<OAuthScopeToken> = [
  "kvitbit:read",
  "kvitbit:write",
  ...ALL_SCOPES.map((scope): OAuthAreaScope => `${OAUTH_SCOPE_PREFIX}${scope}`),
  "offline_access",
];

/** A parsed OAuth scope request: the access it asks for and whether it wants a refresh token. */
export interface OAuthScopeRequest {
  readonly access: GrantedAccess;
  readonly offlineAccess: boolean;
}

/**
 * Reads the tokens of an OAuth `scope` parameter. `kvitbit:write` wins over everything,
 * `kvitbit:read` alone is the read preset, per-area scopes on top of `kvitbit:read` widen it to
 * custom. Returns `undefined` when no Kvitbit scope is present.
 */
export const accessFromOAuthScopes = (
  tokens: ReadonlyArray<OAuthScopeToken>,
): OAuthScopeRequest | undefined => {
  const offlineAccess = tokens.includes("offline_access");
  if (tokens.includes("kvitbit:write")) {
    return { access: { access: "read_write", scopes: ALL_SCOPES }, offlineAccess };
  }
  const areaScopes = tokens.flatMap(
    (token): Array<Scope> =>
      token.startsWith(OAUTH_SCOPE_PREFIX) && token !== "kvitbit:read"
        ? [token.slice(OAUTH_SCOPE_PREFIX.length) as Scope]
        : [],
  );
  const wantsReadPreset = tokens.includes("kvitbit:read");
  if (!wantsReadPreset && areaScopes.length === 0) return undefined;
  const scopes = normalizeScopes(wantsReadPreset ? [...READ_SCOPES, ...areaScopes] : areaScopes);
  if (scopes.length === ALL_SCOPES.length) {
    return { access: { access: "read_write", scopes }, offlineAccess };
  }
  if (sameScopes(scopes, READ_SCOPES)) return { access: { access: "read", scopes }, offlineAccess };
  return { access: { access: "custom", scopes }, offlineAccess };
};

/** The token response `scope` for a grant: the preset name, or per-area wire scopes (6.3). */
export const oauthScopesForGrant = (grant: GrantedAccess): ReadonlyArray<OAuthScopeToken> => {
  switch (grant.access) {
    case "read":
      return ["kvitbit:read"];
    case "read_write":
      return ["kvitbit:write"];
    case "custom":
      return normalizeScopes(grant.scopes).map(
        (scope): OAuthAreaScope => `${OAUTH_SCOPE_PREFIX}${scope}`,
      );
  }
};

const sameScopes = (a: ReadonlyArray<Scope>, b: ReadonlyArray<Scope>): boolean =>
  a.length === b.length && a.every((scope) => b.includes(scope));
