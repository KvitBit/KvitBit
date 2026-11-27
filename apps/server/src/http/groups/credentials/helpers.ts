/**
 * Shared helpers for the SQL-backed credential and account HttpApi groups
 * (`apiKeys`, `connectedApps`, `me`).
 */
import {
  type AccessMode,
  ALL_SCOPES,
  type GrantedAccess,
  normalizeScopes,
  READ_SCOPES,
} from "@kvitbit/api-contract";
import { can } from "@kvitbit/core";
import {
  type Action,
  CurrentCaller,
  Forbidden,
  type MemberCaller,
  type Role,
  type Scope,
  Unavailable,
} from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

/** Extracts the `MemberCaller` provided by `WorkspaceMember` middleware. */
export const requireMemberCaller: Effect.Effect<MemberCaller, never, CurrentCaller> =
  Effect.flatMap(CurrentCaller, (caller) =>
    caller._tag === "Member"
      ? Effect.succeed(caller)
      : Effect.die(new Error(`Expected MemberCaller, got ${caller._tag}`)),
  );

/** Authorizes a core policy `Action` on the current `MemberCaller`. */
export const authorizeMember = (
  action: Action,
): Effect.Effect<MemberCaller, Forbidden, CurrentCaller> =>
  Effect.flatMap(requireMemberCaller, (caller) =>
    can(caller, action) ? Effect.succeed(caller) : Effect.fail(new Forbidden({ action })),
  );

/**
 * Scopes a role may grant on an API Key or MCP grant (http-mcp-contracts 2.2, rule A2):
 * `accountant` is capped to `<area>:read`; other roles may grant all twenty scopes
 * (core rule R1 still enforces `role ∩ scopes` on every request).
 */
export const roleGrantableScopes = (role: Role): ReadonlySet<Scope> =>
  new Set(role === "accountant" ? READ_SCOPES : ALL_SCOPES);

/** Rejects any requested scope outside the creator's role ceiling. */
export const enforceRoleScopeCap = (
  role: Role,
  scopes: ReadonlyArray<Scope>,
  action: Action,
): Effect.Effect<void, Forbidden> => {
  const grantable = roleGrantableScopes(role);
  for (const scope of scopes) {
    if (!grantable.has(scope)) {
      return Effect.fail(new Forbidden({ action }));
    }
  }
  return Effect.void;
};

/** Maps `SqlError` to `Unavailable{dependency: "database"}` while preserving domain errors. */
export const dbUnavailable = <A, E, R>(
  effect: Effect.Effect<A, E | SqlError, R>,
): Effect.Effect<A, Exclude<E, SqlError> | Unavailable, R> =>
  Effect.mapError(effect, (error) =>
    isSqlError(error) ? new Unavailable({ dependency: "database" }) : error,
  ) as Effect.Effect<A, Exclude<E, SqlError> | Unavailable, R>;

/** Formats a Postgres/PGlite timestamp (`Date` or ISO string) as an ISO-8601 UTC string. */
export const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Formats an optional Postgres/PGlite timestamp. */
export const toNullableIsoString = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : toIsoString(value);

/** Normalizes stored `(access, scopes)` columns into a schema-consistent `GrantedAccess`. */
export const normalizeStoredAccess = (
  access: AccessMode,
  scopes: ReadonlyArray<string>,
): GrantedAccess => {
  switch (access) {
    case "read":
      return { access: "read", scopes: READ_SCOPES };
    case "read_write":
      return { access: "read_write", scopes: ALL_SCOPES };
    case "custom":
      return { access: "custom", scopes: normalizeScopes(scopes as ReadonlyArray<Scope>) };
  }
};

/** Extracts the display host from an OAuth client's registered `redirect_uris`. */
export const redirectHostOf = (redirectUris: ReadonlyArray<string> | null | undefined): string => {
  const first = redirectUris?.[0];
  if (first === undefined) return "";
  try {
    return new URL(first).host;
  } catch {
    return "";
  }
};
