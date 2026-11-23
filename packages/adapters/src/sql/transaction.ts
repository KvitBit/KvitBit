import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

const isLockConflict = (error: unknown): boolean =>
  isSqlError(error) &&
  (error.reason._tag === "DeadlockError" || error.reason._tag === "SerializationError");

/**
 * Runs `self` in one READ COMMITTED transaction and reruns the whole transaction up to
 * `retries` times (default 3) when Postgres aborts it with a deadlock (`40P01`) or serialization
 * failure (`40001`), per core-ports.md S4. Other failures, and the last lock conflict, pass
 * through. Outermost level only: retrying a savepoint cannot recover an aborted outer
 * transaction, so a call inside a transaction is a defect.
 */
export const transactionWithRetry = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  options?: { readonly retries?: number },
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* Effect.die(
        new Error("sql: transactionWithRetry must be the outermost transaction"),
      );
    }
    return yield* sql
      .withTransaction(self)
      .pipe(Effect.retry({ while: isLockConflict, times: options?.retries ?? 3 }));
  });
