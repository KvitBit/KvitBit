/** `DeliveriesRepo` over Postgres. STUB: replaced by its implementation. */
import { DeliveriesRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const DeliveriesRepoSql: Layer.Layer<DeliveriesRepo, never, SqlClient.SqlClient> =
  Layer.effect(DeliveriesRepo, Effect.die(new Error("DeliveriesRepoSql is not implemented yet")));
