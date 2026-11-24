/** `WorkspacesRepo` over Postgres. STUB: replaced by its implementation. */
import { WorkspacesRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const WorkspacesRepoSql: Layer.Layer<WorkspacesRepo, never, SqlClient.SqlClient> =
  Layer.effect(WorkspacesRepo, Effect.die(new Error("WorkspacesRepoSql is not implemented yet")));
