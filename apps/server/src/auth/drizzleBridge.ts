/**
 * Promise-returning Drizzle PG database backed by Effect's `SqlClient.SqlClient`, so Better Auth's
 * `drizzleAdapter` runs over whichever SQL client the process provides (`PgClient` in production,
 * `PgliteClient` in tests) with full transaction support via `sql.withTransaction`.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** Builds a Drizzle PG database backed by `sql` for Better Auth's `drizzleAdapter`. */
export const makeDrizzleOverSqlClient = (
  sql: SqlClient.SqlClient,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A> = Effect.runPromise,
) => {
  const db = drizzle(async (query, params, method) => {
    const rows = await runPromise(sql.unsafe<Record<string, unknown>>(query, params));
    return {
      rows: method === "all" ? rows.map((row) => Object.values(row)) : [...rows],
    };
  });

  // Enable transactions via Effect's SqlClient.withTransaction (pg-proxy throws by default).
  const session = db._.session as unknown as {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  };
  session.transaction = <T>(fn: (tx: unknown) => Promise<T>) =>
    runPromise(sql.withTransaction(Effect.tryPromise(() => fn(db))));

  return db;
};
