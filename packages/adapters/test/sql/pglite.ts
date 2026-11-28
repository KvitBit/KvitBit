import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { generateId } from "../../src/auth";
import { layerFromPglite, makeMigratedPglite } from "../../src/testing";

export interface MigratedPglite {
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  readonly close: () => Promise<void>;
}

/** An in-memory PGlite migrated with packages/db/drizzle, wrapped as an Effect `SqlClient`. */
export const migratedPglite = (): Promise<MigratedPglite> =>
  makeMigratedPglite().then((client) => {
    const layer = layerFromPglite(client);
    return {
      run: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
      close: () => client.close(),
    };
  });

interface Seeded {
  readonly workspaceId: string;
  readonly seriesId: string;
}

let seq = 0;

/** A fresh Workspace with one invoice series, so tests never share rows. */
export const seedWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaceId = generateId();
  const seriesId = generateId();
  seq += 1;
  yield* sql`insert into workspaces (id, slug, name)
    values (${workspaceId}, ${`ws-${seq}-${Str.slice(0, 8)(workspaceId)}`}, ${`Workspace ${seq}`})`;
  yield* sql`insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
    values (${seriesId}, ${workspaceId}, 'invoice', 'Invoices', 'FV{YYYY}{NNNN}', true)`;
  return { workspaceId, seriesId } satisfies Seeded;
});
