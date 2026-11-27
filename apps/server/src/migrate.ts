/**
 * Explicit migration runner (`bun apps/server/src/migrate.ts`), per board #871/#913 and rule S5.
 *
 * Uses `DATABASE_URL_UNPOOLED` (owner role, direct endpoint) and applies BOTH:
 * 1. `@kvitbit/db` Drizzle SQL migrations (`packages/db/drizzle`), tracking applied hashes in
 *    `drizzle.__drizzle_migrations` (compatible with `drizzle-kit migrate` and `drizzle-orm`).
 * 2. Effect Cluster / Workflow SQL storage tables (`clusterStorageMigrationsLayer` from
 *    `@kvitbit/adapters/jobs`).
 *
 * Migrations NEVER run at server or worker boot.
 */

import { fileURLToPath } from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { PgClient } from "@effect/sql-pg";
import { clusterStorageMigrationsLayer } from "@kvitbit/adapters/jobs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";

/** Resolves `packages/db/drizzle` via the `@kvitbit/db` workspace package. */
export const defaultMigrationsFolder = (): string =>
  fileURLToPath(new URL("../drizzle", import.meta.resolve("@kvitbit/db")));

/**
 * Applies all pending Drizzle SQL migrations from `migrationsFolder` through `SqlClient`.
 * Uses the standard `drizzle.__drizzle_migrations` table and `created_at` ordering.
 */
export const applyDrizzleMigrations = Effect.fn("applyDrizzleMigrations")(function* (
  migrationsFolder = defaultMigrationsFolder(),
) {
  const sql = yield* SqlClient.SqlClient;
  const migrations = yield* Effect.try({
    try: () => readMigrationFiles({ migrationsFolder }),
    catch: (cause) => ({ cause }),
  }).pipe(Effect.catch(({ cause }) => Effect.die(cause)));

  yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

  const appliedRows = yield* sql.unsafe<{ readonly created_at: string | number | null }>(
    `SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
  );
  const lastCreatedAt =
    appliedRows[0]?.created_at !== undefined && appliedRows[0]?.created_at !== null
      ? Number(appliedRows[0].created_at)
      : -1;

  let applied = 0;
  for (const migration of migrations) {
    if (migration.folderMillis <= lastCreatedAt) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const stmt of migration.sql) {
          const trimmed = Str.trim(stmt);
          if (trimmed !== "") {
            yield* sql.unsafe(trimmed);
          }
        }
        yield* sql.unsafe(
          `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      }),
    );
    applied++;
  }

  return { total: migrations.length, applied } as const;
});

/**
 * Applies BOTH `@kvitbit/db` Drizzle migrations AND Effect Cluster/Workflow SQL tables.
 * Requires `SqlClient` connected as the schema owner over the direct (unpooled) endpoint.
 */
export const runMigrations = Effect.fn("runMigrations")(function* (
  migrationsFolder = defaultMigrationsFolder(),
) {
  const drizzleResult = yield* applyDrizzleMigrations(migrationsFolder);
  yield* Effect.logInfo("Applied Drizzle migrations", drizzleResult);

  yield* Layer.build(clusterStorageMigrationsLayer).pipe(Effect.scoped);
  yield* Effect.logInfo("Applied Effect Cluster SQL storage migrations");

  return drizzleResult;
});

/** Owner-role direct Postgres layer reading `DATABASE_URL_UNPOOLED` explicitly (never pooled). */
export const UnpooledOwnerDatabaseLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL_UNPOOLED"),
  maxConnections: Config.succeed(1),
  applicationName: Config.succeed("kvitbit-migrate"),
});

// Older Node versions lack import.meta.main.
const entryPath = process.argv[1] ?? "";
const isMain =
  import.meta.main ??
  (Str.endsWith("migrate.ts")(entryPath) || Str.endsWith("migrate.js")(entryPath));

if (isMain) {
  NodeRuntime.runMain(runMigrations().pipe(Effect.provide(UnpooledOwnerDatabaseLive)));
}
