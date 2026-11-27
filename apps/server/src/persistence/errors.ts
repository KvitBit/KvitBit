/**
 * SqlError -> core store errors. Every repository and the CoreStore funnel database failures
 * through these, so the module above sees only `StoreUnavailable` and `UniqueViolation`
 * (packages/core/src/store/CoreStore.ts).
 */
import { StoreUnavailable, UniqueViolation } from "@kvitbit/core/ports";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlError from "effect/sql/SqlError";

/** Any database failure as `StoreUnavailable`, keeping the SqlError as the cause. */
export const unavailable = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError.SqlError> | StoreUnavailable, R> =>
  Effect.mapError(self, (error) => mapSqlError(error, (cause) => StoreUnavailable.make({ cause })));

function mapSqlError<E, F>(
  error: E,
  map: (error: SqlError.SqlError) => F,
): Exclude<E, SqlError.SqlError> | F;
function mapSqlError<E, F>(error: E, map: (error: SqlError.SqlError) => F): E | F {
  return SqlError.isSqlError(error) ? map(error) : error;
}

/**
 * Unique violations as `UniqueViolation{collection, constraint}`, other database failures as
 * `StoreUnavailable`. `rename` maps a database constraint name to the core constraint name the
 * module matches on (defaults to the database name; `<table>_pkey` becomes `"primary"`).
 */
export const writeErrors: {
  (
    collection: string,
    rename?: (constraint: string) => string,
  ): <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | UniqueViolation | StoreUnavailable, R>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    collection: string,
    rename?: (constraint: string) => string,
  ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | UniqueViolation | StoreUnavailable, R>;
} = Fn.dual(
  (args) => Effect.isEffect(args[0]),
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    collection: string,
    rename: (constraint: string) => string = (name) => name,
  ) =>
    Effect.mapError(self, (error) =>
      mapSqlError(error, (cause) => {
        const constraint =
          cause.reason._tag === "UniqueViolation" ? cause.reason.constraint : undefined;
        return constraint === undefined
          ? StoreUnavailable.make({ cause })
          : UniqueViolation.make({
              collection,
              constraint: Str.endsWith("_pkey")(constraint) ? "primary" : rename(constraint),
            });
      }),
    ),
);

const isStoreUnavailable = Schema.is(StoreUnavailable);

/** Whether `error` (or the SqlError a StoreUnavailable carries) is a deadlock or serialization failure (S4). */
export const isLockConflict = <E>(error: E): boolean => {
  const sqlError = isStoreUnavailable(error) ? error.cause : error;
  return (
    SqlError.isSqlError(sqlError) &&
    (sqlError.reason._tag === "DeadlockError" || sqlError.reason._tag === "SerializationError")
  );
};
