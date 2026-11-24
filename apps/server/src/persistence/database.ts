/**
 * The `SqlClient` the server runs on: Postgres from `DATABASE_URL` in production, and an
 * in-process PGlite with every packages/db migration applied for tests.
 */
import { PgClient } from "@effect/sql-pg";
import type { PgliteClient } from "@effect/sql-pglite";
import { layerMigrated } from "@kvitbit/adapters/testing";
import { Config, type Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/** Pool size per process unless `KVITBIT_DB_POOL_MAX` says otherwise. */
const DEFAULT_POOL_MAX = 10;

/**
 * Postgres over the pooled runtime-role URL. Reads `DATABASE_URL` the way `ServerConfig` does,
 * without the rest of the server config, so `migrate` and tests need only the URL.
 */
export const PgDatabaseLive: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Config.ConfigError | SqlError
> = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL"),
  maxConnections: Config.Int("KVITBIT_DB_POOL_MAX").pipe(Config.withDefault(DEFAULT_POOL_MAX)),
  applicationName: Config.succeed("kvitbit-server"),
});

/**
 * A fresh in-memory PGlite with every committed `@kvitbit/db` migration applied, created when the
 * layer builds and closed with its scope: each `Effect.provide` gets an isolated database. Tests
 * only (PGlite is one connection; contention tests use Postgres).
 */
export const PgliteTestDatabase: Layer.Layer<
  PgliteClient.PgliteClient | SqlClient.SqlClient,
  SqlError
> = layerMigrated;
