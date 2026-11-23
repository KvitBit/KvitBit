import { PgClient } from "@effect/sql-pg";
import { Config, Effect, type Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/**
 * Postgres access for the core modules (core-ports.md §8, §10). Modules run SQL through Effect's
 * `SqlClient` directly; Drizzle only owns the schema and migrations.
 */

/** Runtime URL: the pooled, transaction-mode endpoint on Neon (core-ports.md S5). */
export const databaseUrl = Config.Redacted("DATABASE_URL");

/**
 * Direct (unpooled) URL for migrations and session advisory locks, falling back to
 * `DATABASE_URL` on a single-pool self-host (core-ports.md S5).
 */
export const unpooledDatabaseUrl = Config.Redacted("DATABASE_URL_UNPOOLED").pipe(
  Config.orElse(() => databaseUrl),
);

export type PgLayer = Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Config.ConfigError | SqlError
>;

/**
 * `PgClient` + `SqlClient` from `DATABASE_URL`. Named prepared statements are off because the
 * hosted URL is a transaction-mode pooler (core-ports.md S5).
 */
export const layer: PgLayer = PgClient.layerConfig({
  url: databaseUrl,
  prepare: Config.succeed(false),
});

/** `PgClient` + `SqlClient` from `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`. */
export const layerUnpooled: PgLayer = PgClient.layerConfig({ url: unpooledDatabaseUrl });

/**
 * Runs `self` in one READ COMMITTED transaction (core-ports.md S2). Nested calls become
 * savepoints, so a module can wrap its own work without knowing whether a caller already did.
 */
export const transaction = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(self);
  });
