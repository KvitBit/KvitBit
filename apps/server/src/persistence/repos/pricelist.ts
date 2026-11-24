/** `PriceListRepo` over Postgres. STUB: replaced by its implementation. */
import { PriceListRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const PriceListRepoSql: Layer.Layer<PriceListRepo, never, SqlClient.SqlClient> =
  Layer.effect(PriceListRepo, Effect.die(new Error("PriceListRepoSql is not implemented yet")));
