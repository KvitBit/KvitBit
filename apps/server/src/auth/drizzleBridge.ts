/**
 * Promise-returning Drizzle PG database backed by Effect's `SqlClient.SqlClient`, so Better Auth's
 * `drizzleAdapter` runs over whichever SQL client the process provides (`PgClient` in production,
 * `PgliteClient` in tests) with full transaction support via `sql.withTransaction`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/pg-proxy";
import { type Context, Effect } from "effect";
import type { SqlClient } from "effect/sql";

const sqlContext = new AsyncLocalStorage<Context.Context<never>>();

/** Keep the current Effect SQL transaction when Better Auth crosses into promises. */
export const withDrizzleSqlContext = <A>(callback: () => Promise<A>) =>
  Effect.flatMap(Effect.context(), (context) =>
    Effect.tryPromise(() => sqlContext.run(context, callback)),
  );

export const runDrizzleEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const context = sqlContext.getStore();
  return context === undefined ? Effect.runPromise(effect) : Effect.runPromiseWith(context)(effect);
};

/** Builds a Drizzle PG database backed by `sql` for Better Auth's `drizzleAdapter`. */
export const makeDrizzleOverSqlClient = (
  sql: SqlClient.SqlClient,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A> = runDrizzleEffect,
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
    runPromise(sql.withTransaction(withDrizzleSqlContext(() => fn(db))));

  return db;
};
