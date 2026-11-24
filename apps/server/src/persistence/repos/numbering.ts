/** `NumberingSeriesRepo` over Postgres. STUB: replaced by its implementation. */
import { NumberingSeriesRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const NumberingSeriesRepoSql: Layer.Layer<NumberingSeriesRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    NumberingSeriesRepo,
    Effect.die(new Error("NumberingSeriesRepoSql is not implemented yet")),
  );
