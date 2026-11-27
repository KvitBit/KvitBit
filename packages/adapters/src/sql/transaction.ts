import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

const isLockConflict = <E>(error: E): boolean =>
  SqlError.isSqlError(error) &&
  (error.reason._tag === "DeadlockError" || error.reason._tag === "SerializationError");

interface RetryOptions {
  readonly retries?: number;
}

/**
 * Runs `self` in one transaction, explicitly READ COMMITTED whatever the session default, and reruns the whole transaction up to
 * `retries` times (default 3) when Postgres aborts it with a deadlock (`40P01`) or serialization
 * failure (`40001`), per core-ports.md S4. Other failures, and the last lock conflict, pass
 * through. Outermost level only: retrying a savepoint cannot recover an aborted outer
 * transaction, so a call inside a transaction is a defect.
 */
export const transactionWithRetry = Effect.fn("Sql.transactionWithRetry")(function* <A, E, R>(
  self: Effect.Effect<A, E, R>,
  options?: RetryOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const transaction = yield* Effect.serviceOption(sql.transactionService);
  if (Option.isSome(transaction)) {
    return yield* Effect.die(
      new Error("sql: transactionWithRetry must be the outermost transaction"),
    );
  }
  return yield* sql
    .withTransaction(self)
    .pipe(
      Effect.provideService(SqlClient.BeginTransaction, "BEGIN ISOLATION LEVEL READ COMMITTED"),
      Effect.retry({ while: isLockConflict, times: options?.retries ?? 3 }),
    );
});
