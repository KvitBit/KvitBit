/** `RecurringRepo` over Postgres. STUB: replaced by its implementation. */
import { RecurringRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const RecurringRepoSql: Layer.Layer<RecurringRepo, never, SqlClient.SqlClient> =
  Layer.effect(RecurringRepo, Effect.die(new Error("RecurringRepoSql is not implemented yet")));
