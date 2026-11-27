/**
 * A migrated PGlite per harness, cloned from one template migrated once per test process
 * (migrating takes seconds; a clone takes milliseconds). Stands in for s3a-persistence's
 * `PgliteTestDatabase` until that stream merges.
 */
import { PgliteClient } from "@effect/sql-pglite";
import type { PGlite } from "@electric-sql/pglite";
import { makeMigratedPglite } from "@kvitbit/adapters/testing";
import * as Effect from "effect/Effect";

let template: Promise<PGlite> | undefined;

const migratedTemplate = () => {
  template ??= makeMigratedPglite();
  return template;
};

export const TestDatabase = PgliteClient.layerFrom(
  Effect.acquireRelease(
    Effect.promise(migratedTemplate).pipe(
      Effect.flatMap((database) => Effect.promise(() => database.clone())),
    ),
    (client) => Effect.promise(() => client.close()),
  ).pipe(Effect.flatMap((client) => PgliteClient.fromClient({ liveClient: client }))),
);
