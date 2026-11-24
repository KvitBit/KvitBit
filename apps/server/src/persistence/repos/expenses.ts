/** `ExpensesRepo` over Postgres. STUB: replaced by its implementation. */
import { ExpensesRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const ExpensesRepoSql: Layer.Layer<ExpensesRepo, never, SqlClient.SqlClient> = Layer.effect(
  ExpensesRepo,
  Effect.die(new Error("ExpensesRepoSql is not implemented yet")),
);
