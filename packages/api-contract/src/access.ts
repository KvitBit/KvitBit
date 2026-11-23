/**
 * Access requests, stored grants and the OAuth scope wire form (http-mcp-contracts sections
 * 2.2 and 6.3). Core spells scopes `<area>:<level>`; OAuth spells them `kvitbit:<area>:<level>`
 * plus the presets `kvitbit:read` and `kvitbit:write`. Both forms meet only here.
 */

import { SCOPE_AREAS, Scope, ScopeArea, ScopeLevel } from "@kvitbit/domain/contract";
import { Schema, SchemaTransformation } from "effect";

export { SCOPE_AREAS, Scope, ScopeArea, ScopeLevel };

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

const sameList = (a: ReadonlyArray<Scope>, b: ReadonlyArray<Scope>): boolean =>
  a.length === b.length && a.every((scope, i) => scope === b[i]);

/** Same members, no duplicates, any order. */
const sameMembers = (a: ReadonlyArray<Scope>, b: ReadonlyArray<Scope>): boolean => {
  const set = new Set(a);
  return a.length === b.length && set.size === a.length && b.every((scope) => set.has(scope));
};

/**
 * Consistency of a mode with its stored list: `read` is exactly the ten reads and `read_write`
 * all twenty scopes (each once, any order); `custom` is a non-empty list in `normalizeScopes`
 * form. Applies to every struct that
 * spreads `GrantedAccess.fields`, since spreading fields drops struct-level checks.
 */
export const isGrantedAccessConsistent = Schema.makeFilter<{
  readonly access: AccessMode;
  readonly scopes: ReadonlyArray<Scope>;
}>(
  ({ access, scopes }) => {
    switch (access) {
      case "read":
        return (
          sameMembers(scopes, READ_SCOPES) || "read access carries exactly the ten <area>:read"
        );
      case "read_write":
        return sameMembers(scopes, ALL_SCOPES) || "read_write access carries all twenty scopes";
      case "custom":
        return (
          (scopes.length > 0 && sameList(scopes, normalizeScopes(scopes))) ||
          "custom access carries a non-empty, normalized scope list"
        );
    }
  },
  { expected: "scopes consistent with the access mode" },
);

/** What a stored credential carries: the mode as chosen plus the expanded list. */
export const GrantedAccess = Schema.Struct({
  access: AccessMode,
  scopes: Schema.Array(Scope),
}).pipe(Schema.check(isGrantedAccessConsistent));
export type GrantedAccess = typeof GrantedAccess.Type;

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
      decode: (wire) => coreScopeOf(wire),
      encode: (scope) => wireScopeOf(scope),
    }),
  ),
);

export const OAuthPresetScope = Schema.Literals(["kvitbit:read", "kvitbit:write"]);
export type OAuthPresetScope = typeof OAuthPresetScope.Type;

/** A Kvitbit access scope on the wire: a preset or a per-area scope. Grants map to these. */
export const OAuthAccessScope = Schema.Union([OAuthPresetScope, OAuthAreaScope]);
export type OAuthAccessScope = typeof OAuthAccessScope.Type;

/** The standard OIDC scope asking for a refresh token; it grants no Kvitbit access (6.3). */
export const OAUTH_OFFLINE_ACCESS = "offline_access";
export const OAuthOfflineAccessScope = Schema.Literal(OAUTH_OFFLINE_ACCESS);
export type OAuthOfflineAccessScope = typeof OAuthOfflineAccessScope.Type;

/** One token of the OAuth `scope` parameter that Kvitbit understands. */
export const OAuthScopeToken = Schema.Union([OAuthAccessScope, OAuthOfflineAccessScope]);
export type OAuthScopeToken = typeof OAuthScopeToken.Type;

const isOAuthAreaScope = Schema.is(OAuthAreaScope);
const coreScopeOf = (wire: OAuthAreaScope): Scope => wire.slice(OAUTH_SCOPE_PREFIX.length) as Scope;
const wireScopeOf = (scope: Scope): OAuthAreaScope => `${OAUTH_SCOPE_PREFIX}${scope}`;

/** `scopes_supported` of the protected resource metadata (section 6.2), in that order. */
export const OAUTH_SCOPES_SUPPORTED: ReadonlyArray<OAuthScopeToken> = [
  "kvitbit:read",
  "kvitbit:write",
  ...ALL_SCOPES.map(wireScopeOf),
  OAUTH_OFFLINE_ACCESS,
];

/** A parsed OAuth scope request: the access it asks for and whether it wants a refresh token. */
export interface OAuthScopeRequest {
  readonly access: GrantedAccess;
  readonly offlineAccess: boolean;
}

/**
 * Reads the tokens of an OAuth `scope` parameter, keeping the form the client asked in (6.3):
 * `kvitbit:write` wins over everything and is `read_write`; `kvitbit:read` without per-area
 * scopes is `read`; any explicit per-area scope makes the request `custom` (on top of the ten
 * reads when `kvitbit:read` is also present), even when the list equals a preset's expansion.
 * Consent may still offer the user a preset. Returns `undefined` when no Kvitbit scope is present.
 */
export const accessFromOAuthScopes = (
  tokens: ReadonlyArray<OAuthScopeToken>,
): OAuthScopeRequest | undefined => {
  const offlineAccess = tokens.includes(OAUTH_OFFLINE_ACCESS);
  if (tokens.includes("kvitbit:write")) {
    return { access: { access: "read_write", scopes: ALL_SCOPES }, offlineAccess };
  }
  const wantsReadPreset = tokens.includes("kvitbit:read");
  const areaScopes = tokens.filter(isOAuthAreaScope).map(coreScopeOf);
  if (areaScopes.length > 0) {
    const scopes = normalizeScopes(wantsReadPreset ? [...READ_SCOPES, ...areaScopes] : areaScopes);
    return { access: { access: "custom", scopes }, offlineAccess };
  }
  if (wantsReadPreset) return { access: { access: "read", scopes: READ_SCOPES }, offlineAccess };
  return undefined;
};

/**
 * The Kvitbit part of the token response `scope` for a grant: the preset name, or per-area wire
 * scopes (6.3). `offline_access` is not part of a grant; the server appends it when it issued a
 * refresh token.
 */
export const oauthScopesForGrant = (grant: GrantedAccess): ReadonlyArray<OAuthAccessScope> => {
  switch (grant.access) {
    case "read":
      return ["kvitbit:read"];
    case "read_write":
      return ["kvitbit:write"];
    case "custom":
      return normalizeScopes(grant.scopes).map(wireScopeOf);
  }
};
