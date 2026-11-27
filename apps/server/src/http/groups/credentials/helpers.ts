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
  Scope,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

/** Extracts the `MemberCaller` provided by `WorkspaceMember` middleware. */
export const requireMemberCaller: Effect.Effect<MemberCaller, never, CurrentCaller> =
  Effect.filterOrElse(
    CurrentCaller,
    (caller): caller is MemberCaller => caller._tag === "Member",
    (caller) => Effect.die(new Error(`Expected MemberCaller, got ${caller._tag}`)),
  );

/** Authorizes a core policy `Action` on the current `MemberCaller`. */
export const authorizeMember = (
  action: Action,
): Effect.Effect<MemberCaller, Forbidden, CurrentCaller> =>
  Effect.filterOrFail(
    requireMemberCaller,
    (caller) => can(caller, action),
    () => Forbidden.make({ action }),
  );

/**
 * Scopes a role may grant on an API Key or MCP grant (http-mcp-contracts 2.2, rule A2):
 * `accountant` is capped to `<area>:read`; other roles may grant all twenty scopes
 * (core rule R1 still enforces `role ∩ scopes` on every request).
 */
const roleGrantableScopes = (role: Role): ReadonlySet<Scope> =>
  new Set(role === "accountant" ? READ_SCOPES : ALL_SCOPES);

/** Rejects any requested scope outside the creator's role ceiling. */
export const enforceRoleScopeCap = Effect.fnUntraced(function* (
  role: Role,
  scopes: ReadonlyArray<Scope>,
  action: Action,
) {
  const grantable = roleGrantableScopes(role);
  for (const scope of scopes) {
    if (!grantable.has(scope)) {
      return yield* Forbidden.make({ action });
    }
  }
});

/** Maps `SqlError` to `Unavailable{dependency: "database"}` while preserving domain errors. */
export const dbUnavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is Extract<E, SqlError.SqlError> => SqlError.isSqlError(error),
    () => Effect.fail(Unavailable.make({ dependency: "database" })),
  );

/** Formats a Postgres/PGlite timestamp (`Date` or ISO string) as an ISO-8601 UTC string. */
export const toIsoString = (value: Date | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

/** Formats an optional Postgres/PGlite timestamp. */
export const toNullableIsoString = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : toIsoString(value);

/** Normalizes stored `(access, scopes)` columns into a schema-consistent `GrantedAccess`. */
const isScope = Schema.is(Scope);

export const normalizeStoredAccess = (stored: {
  readonly access: AccessMode;
  readonly scopes: ReadonlyArray<string>;
}): GrantedAccess => {
  const { access, scopes } = stored;
  switch (access) {
    case "read":
      return { access: "read", scopes: READ_SCOPES };
    case "read_write":
      return { access: "read_write", scopes: ALL_SCOPES };
    case "custom":
      return { access: "custom", scopes: normalizeScopes(Arr.filter(scopes, isScope)) };
  }
};

/** Extracts the display host from an OAuth client's registered `redirect_uris`. */
const readHost = Option.liftThrowable((uri: string) => new URL(uri).host);
export const redirectHostOf = (redirectUris: ReadonlyArray<string> | null | undefined): string => {
  const first = redirectUris?.[0];
  if (first === undefined) return "";
  return Option.getOrElse(readHost(first), () => "");
};
