/** `FxFixingCache` over Postgres. STUB: replaced by its implementation. */
import { FxFixingCache } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const FxFixingCacheSql: Layer.Layer<FxFixingCache, never, SqlClient.SqlClient> =
  Layer.effect(FxFixingCache, Effect.die(new Error("FxFixingCacheSql is not implemented yet")));
