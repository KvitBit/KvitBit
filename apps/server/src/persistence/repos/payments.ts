/** `PaymentsRepo` over Postgres. STUB: replaced by its implementation. */
import { PaymentsRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const PaymentsRepoSql: Layer.Layer<PaymentsRepo, never, SqlClient.SqlClient> = Layer.effect(
  PaymentsRepo,
  Effect.die(new Error("PaymentsRepoSql is not implemented yet")),
);
