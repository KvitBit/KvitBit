/** `ExportsRepo` over Postgres. STUB: replaced by its implementation. */
import { ExportsRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const ExportsRepoSql: Layer.Layer<ExportsRepo, never, SqlClient.SqlClient> = Layer.effect(
  ExportsRepo,
  Effect.die(new Error("ExportsRepoSql is not implemented yet")),
);
