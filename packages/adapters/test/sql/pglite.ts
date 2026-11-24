import { fileURLToPath } from "node:url";
import { PgliteClient } from "@effect/sql-pglite";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Effect, type Layer } from "effect";
import { SqlClient } from "effect/sql";

const migrationsFolder = fileURLToPath(new URL("../../../db/drizzle", import.meta.url));

export interface MigratedPglite {
  readonly layer: Layer.Layer<SqlClient.SqlClient, unknown>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  readonly close: () => Promise<void>;
}

/** An in-memory PGlite migrated with packages/db/drizzle, wrapped as an Effect `SqlClient`. */
export const migratedPglite = async (): Promise<MigratedPglite> => {
  const client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder });
  const layer = PgliteClient.layer({ liveClient: client });
  return {
    layer,
    run: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    close: () => client.close(),
  };
};

export interface Seeded {
  readonly workspaceId: string;
  readonly seriesId: string;
}

let seq = 0;

/** A fresh Workspace with one invoice series, so tests never share rows. */
export const seedWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaceId = crypto.randomUUID();
  const seriesId = crypto.randomUUID();
  seq += 1;
  yield* sql`insert into workspaces (id, slug, name)
    values (${workspaceId}, ${`ws-${seq}-${workspaceId.slice(0, 8)}`}, ${`Workspace ${seq}`})`;
  yield* sql`insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
    values (${seriesId}, ${workspaceId}, 'invoice', 'Invoices', 'FV{YYYY}{NNNN}', true)`;
  return { workspaceId, seriesId } satisfies Seeded;
});
