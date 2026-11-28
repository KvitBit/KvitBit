/**
 * Better Auth's Drizzle adapter uses either production PostgreSQL or test PGlite
 * through the Effect SQL client.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PgAsyncTransaction, PgDialect } from "drizzle-orm/pg-core";
import {
  PgRemoteDatabase,
  type PgRemoteQueryResultHKT,
  PgRemoteSession,
  type RemoteCallback,
} from "drizzle-orm/pg-proxy";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const DrizzleRow = Schema.Record(Schema.String, Schema.Unknown);

import { currentAuthLogContext, pickAuthLogContext } from "./logging";

const sqlContext = new AsyncLocalStorage<Context.Context<never>>();

export class AuthCallbackError extends Schema.TaggedError<
  AuthCallbackError,
  { readonly brand: unique symbol }
>()("AuthCallbackError", {
  cause: Schema.Unknown,
}) {}

const isAuthCallbackError = Schema.is(AuthCallbackError);

export const fromAuthPromise = <A>(callback: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: callback,
    catch: (cause) => AuthCallbackError.make({ cause }),
  });

/** Keep the current Effect SQL transaction when Better Auth calls its Promise API. */
export const withDrizzleSqlContext = <A>(callback: () => PromiseLike<A>) =>
  Effect.flatMap(Effect.context<never>(), (context) =>
    fromAuthPromise(() => sqlContext.run(context, callback)),
  );

const authEffectRunner =
  (fallback: Context.Context<never>) =>
  <A, E>(effect: Effect.Effect<A, E>) => {
    const context = sqlContext.getStore() ?? currentAuthLogContext() ?? fallback;
    // Better Auth and Drizzle require promises and recognize their original rejection values.
    return Effect.runPromiseWith(context)(
      effect.pipe(Effect.catchIf(isAuthCallbackError, (error) => Effect.die(error.cause))),
    );
  };

export const runAuthEffect = authEffectRunner(Context.empty());

export const makeAuthEffectRunner = Effect.withFiberSucceed((fiber) =>
  authEffectRunner(pickAuthLogContext(fiber.context)),
);

export const makeDrizzleOverSqlClient = (sql: SqlClient.SqlClient) => {
  const execute: RemoteCallback = (query, params, method) =>
    runAuthEffect(
      sql.unsafe<typeof DrizzleRow.Type>(query, params).pipe(
        Effect.map((rows) => ({
          rows: method === "all" ? Arr.map(rows, Rec.values) : [...rows],
        })),
      ),
    );
  const dialect = new PgDialect();
  const relations = {};

  class SqlTransaction extends PgAsyncTransaction<PgRemoteQueryResultHKT> {
    override transaction<A>(callback: (transaction: SqlTransaction) => Promise<A>) {
      return runAuthEffect(sql.withTransaction(withDrizzleSqlContext(() => callback(this))));
    }
  }

  class SqlSession extends PgRemoteSession<typeof relations> {
    override transaction<A>(callback: (transaction: SqlTransaction) => Promise<A>) {
      const transaction = new SqlTransaction(dialect, this, relations, undefined, undefined);
      return runAuthEffect(sql.withTransaction(withDrizzleSqlContext(() => callback(transaction))));
    }
  }

  const session = new SqlSession(execute, dialect, relations);
  return new PgRemoteDatabase(dialect, session, relations);
};
