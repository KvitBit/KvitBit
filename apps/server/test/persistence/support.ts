/** PGlite support for the persistence tests: a migrated database per run, plus seed rows. */

import type { CoreStore } from "@kvitbit/core/ports";
import { NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { CoreStoreSql } from "../../src/persistence/CoreStoreSql";
import { PgliteTestDatabase } from "../../src/persistence/database";

/** `CoreStore` and `SqlClient` over a fresh migrated PGlite. */
const StoreTestLayer = CoreStoreSql.pipe(Layer.provideMerge(PgliteTestDatabase));

/** Runs `effect` against a fresh database (one per call). */
export const runStore = <A, E>(
  effect: Effect.Effect<A, E, CoreStore | SqlClient.SqlClient>,
): Promise<A> => effect.pipe(Effect.provide(StoreTestLayer), Effect.scoped, Effect.runPromise);

let seq = 0;

/** A Workspace with one invoice Numbering Series, inserted directly. */
export const seedWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaceId = WorkspaceId.make(SecureRandom.uuidV7Unsafe());
  const seriesId = NumberingSeriesId.make(SecureRandom.uuidV7Unsafe());
  seq += 1;
  yield* sql`insert into workspaces (id, slug, name)
    values (${workspaceId}, ${`ws-${seq}-${Str.slice(0, 8)(workspaceId)}`}, ${`Workspace ${seq}`})`;
  yield* sql`insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
    values (${seriesId}, ${workspaceId}, 'invoice', 'Invoices', 'YYYY-NNNN', true)`;
  return { workspaceId, seriesId };
});

export { CoreStore } from "@kvitbit/core/ports";
