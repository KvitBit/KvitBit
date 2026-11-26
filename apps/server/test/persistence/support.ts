/** PGlite support for the persistence tests: a migrated database per run, plus seed rows. */
import { CoreStore } from "@kvitbit/core/ports";
import type { NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { CoreStoreSql } from "../../src/persistence/CoreStoreSql";
import { PgliteTestDatabase } from "../../src/persistence/database";

/** `CoreStore` and `SqlClient` over a fresh migrated PGlite. */
export const StoreTestLayer = CoreStoreSql.pipe(Layer.provideMerge(PgliteTestDatabase));

/** Runs `effect` against a fresh database (one per call). */
export const runStore = <A, E>(
  effect: Effect.Effect<A, E, CoreStore | SqlClient.SqlClient>,
): Promise<A> => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(StoreTestLayer))));

let seq = 0;

/** A Workspace with one invoice Numbering Series, inserted directly. */
export const seedWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const seriesId = crypto.randomUUID() as NumberingSeriesId;
  seq += 1;
  yield* sql`insert into workspaces (id, slug, name)
    values (${workspaceId}, ${`ws-${seq}-${workspaceId.slice(0, 8)}`}, ${`Workspace ${seq}`})`;
  yield* sql`insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
    values (${seriesId}, ${workspaceId}, 'invoice', 'Invoices', 'YYYY-NNNN', true)`;
  return { workspaceId, seriesId };
});

export { CoreStore };
