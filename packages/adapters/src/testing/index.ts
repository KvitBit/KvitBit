/**
 * Test support: an in-process Postgres (PGlite) migrated with the committed `@kvitbit/db`
 * migrations, plus an Effect `SqlClient` layer over it. Test code only; it pulls the
 * `@electric-sql/pglite` and `@effect/sql-pglite` dev dependencies.
 */
import { fileURLToPath } from "node:url";
import { PgliteClient } from "@effect/sql-pglite";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Effect, type Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/** Absolute path of `packages/db/drizzle`, resolved through the `@kvitbit/db` package. */
export const migrationsFolder: string = fileURLToPath(
  new URL("../drizzle", import.meta.resolve("@kvitbit/db")),
);

/** A fresh in-memory PGlite with every committed migration applied. The caller closes it. */
export const makeMigratedPglite = async (): Promise<PGlite> => {
  const client = new PGlite();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
};

/** `SqlClient` over a PGlite the caller owns; closing the layer leaves the client open. */
export const layerFromPglite = (
  client: PGlite,
): Layer.Layer<PgliteClient.PgliteClient | SqlClient.SqlClient, SqlError> =>
  PgliteClient.layerFrom(PgliteClient.fromClient({ liveClient: client }));

/**
 * `SqlClient` over a fresh migrated PGlite owned by the layer: it is created when the layer
 * builds and closed when its scope ends, so each `Effect.provide` gets an isolated database.
 */
export const layerMigrated: Layer.Layer<PgliteClient.PgliteClient | SqlClient.SqlClient, SqlError> =
  PgliteClient.layerFrom(
    Effect.acquireRelease(
      Effect.promise(() => makeMigratedPglite()),
      (client) => Effect.promise(() => client.close()),
    ).pipe(Effect.flatMap((client) => PgliteClient.fromClient({ liveClient: client }))),
  );
