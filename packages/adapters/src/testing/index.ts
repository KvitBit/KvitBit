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
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/** Absolute path of `packages/db/drizzle`, resolved through the `@kvitbit/db` package. */
export const migrationsFolder: string = fileURLToPath(
  new URL("../drizzle", import.meta.resolve("@kvitbit/db")),
);

const closeClient = (client: PGlite) => Effect.promise(() => client.close());

const openMigratedPglite = Effect.gen(function* () {
  const client = yield* Effect.sync(() => new PGlite());
  const migrateClient = Effect.tryPromise({
    try: () => migrate(drizzle({ client }), { migrationsFolder }),
    catch: (cause) => ({ cause }),
  });
  return yield* migrateClient.pipe(
    Effect.onError(() => closeClient(client)),
    Effect.catch(({ cause }) => Effect.die(cause)),
    Effect.as(client),
  );
});

/** A fresh in-memory PGlite with every committed migration applied. The caller closes it. */
export const makeMigratedPglite = (): Promise<PGlite> => Effect.runPromise(openMigratedPglite);

/** `SqlClient` over a PGlite the caller owns; closing the layer leaves the client open. */
export const layerFromPglite = (
  client: PGlite,
): Layer.Layer<PgliteClient.PgliteClient | SqlClient.SqlClient, SqlError.SqlError> =>
  PgliteClient.layerFrom(PgliteClient.fromClient({ liveClient: client }));

/**
 * `SqlClient` over a fresh migrated PGlite owned by the layer: it is created when the layer
 * builds and closed when its scope ends, so each `Effect.provide` gets an isolated database.
 */
export const layerMigrated: Layer.Layer<
  PgliteClient.PgliteClient | SqlClient.SqlClient,
  SqlError.SqlError
> = PgliteClient.layerFrom(
  Effect.acquireRelease(openMigratedPglite, closeClient).pipe(
    Effect.flatMap((client) => PgliteClient.fromClient({ liveClient: client })),
  ),
);
