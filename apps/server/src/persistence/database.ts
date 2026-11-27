/**
 * The `SqlClient` the server runs on: Postgres from `DATABASE_URL` in production, and an
 * in-process PGlite with every packages/db migration applied for tests.
 */
import { PgClient } from "@effect/sql-pg";
import type { PgliteClient } from "@effect/sql-pglite";
import { layerMigrated } from "@kvitbit/adapters/testing";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/** Pool size per process unless `KVITBIT_DB_POOL_MAX` says otherwise. */
const DEFAULT_POOL_MAX = 10;

/**
 * Postgres over the pooled runtime-role URL. Reads `DATABASE_URL` the way `ServerConfig` does,
 * without the rest of the server config, so `migrate` and tests need only the URL.
 */
export const PgDatabaseLive: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Config.ConfigError | SqlError.SqlError
> = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL"),
  maxConnections: Config.Int("KVITBIT_DB_POOL_MAX").pipe(Config.withDefault(DEFAULT_POOL_MAX)),
  applicationName: Config.succeed("kvitbit-server"),
  prepare: Config.succeed(false),
});

/**
 * Postgres for the standalone cluster worker (`worker.ts`, rule S5): honors
 * `DATABASE_URL_UNPOOLED` (direct DML connection for session advisory locks used by
 * `SqlRunnerStorage`) when set, falling back to `DATABASE_URL` only when absent.
 */
export const PgWorkerDatabaseLive: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Config.ConfigError | SqlError.SqlError
> = Layer.unwrap(
  Effect.gen(function* () {
    const unpooled = yield* Config.option(Config.Redacted("DATABASE_URL_UNPOOLED"));
    const url = Option.isSome(unpooled) ? unpooled.value : yield* Config.Redacted("DATABASE_URL");
    const maxConnections = yield* Config.Int("KVITBIT_DB_POOL_MAX").pipe(
      Config.withDefault(DEFAULT_POOL_MAX),
    );
    return PgClient.layer({
      url,
      maxConnections,
      applicationName: "kvitbit-worker",
      prepare: Option.isSome(unpooled),
    });
  }),
);

/**
 * A fresh in-memory PGlite with every committed `@kvitbit/db` migration applied, created when the
 * layer builds and closed with its scope: each `Effect.provide` gets an isolated database. Tests
 * only (PGlite is one connection; contention tests use Postgres).
 */
export const PgliteTestDatabase: Layer.Layer<
  PgliteClient.PgliteClient | SqlClient.SqlClient,
  SqlError.SqlError
> = layerMigrated;
