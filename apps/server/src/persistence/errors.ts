/**
 * SqlError -> core store errors. Every repository and the CoreStore funnel database failures
 * through these, so the module above sees only `StoreUnavailable` and `UniqueViolation`
 * (packages/core/src/store/CoreStore.ts).
 */
import { StoreUnavailable, UniqueViolation } from "@kvitbit/core/ports";
import { Effect } from "effect";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

/** Any database failure as `StoreUnavailable`, keeping the SqlError as the cause. */
export const unavailable = <A, E, R>(
  self: Effect.Effect<A, E | SqlError, R>,
): Effect.Effect<A, Exclude<E, SqlError> | StoreUnavailable, R> =>
  Effect.mapError(self, (error) =>
    isSqlError(error) ? new StoreUnavailable({ cause: error }) : error,
  ) as Effect.Effect<A, Exclude<E, SqlError> | StoreUnavailable, R>;

/** The unique constraint a SqlError broke, or undefined for any other failure. */
export const uniqueConstraintOf = (error: unknown): string | undefined =>
  isSqlError(error) && error.reason._tag === "UniqueViolation"
    ? error.reason.constraint
    : undefined;

/**
 * Unique violations as `UniqueViolation{collection, constraint}`, other database failures as
 * `StoreUnavailable`. `rename` maps a database constraint name to the core constraint name the
 * module matches on (defaults to the database name; `<table>_pkey` becomes `"primary"`).
 */
export const writeErrors =
  (collection: string, rename: (constraint: string) => string = (c) => c) =>
  <A, E, R>(
    self: Effect.Effect<A, E | SqlError, R>,
  ): Effect.Effect<A, Exclude<E, SqlError> | UniqueViolation | StoreUnavailable, R> =>
    Effect.mapError(self, (error) => {
      if (!isSqlError(error)) return error;
      const constraint = uniqueConstraintOf(error);
      return constraint === undefined
        ? new StoreUnavailable({ cause: error })
        : new UniqueViolation({
            collection,
            constraint: constraint.endsWith("_pkey") ? "primary" : rename(constraint),
          });
    }) as Effect.Effect<A, Exclude<E, SqlError> | UniqueViolation | StoreUnavailable, R>;

/** Whether `error` (or the SqlError a StoreUnavailable carries) is a deadlock or serialization failure (S4). */
export const isLockConflict = (error: unknown): boolean => {
  const sqlError =
    error instanceof StoreUnavailable ? error.cause : isSqlError(error) ? error : undefined;
  return (
    isSqlError(sqlError) &&
    (sqlError.reason._tag === "DeadlockError" || sqlError.reason._tag === "SerializationError")
  );
};
