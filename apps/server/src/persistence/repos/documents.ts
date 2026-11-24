/** `DocumentsRepo` over Postgres. STUB: replaced by its implementation. */
import { DocumentsRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const DocumentsRepoSql: Layer.Layer<DocumentsRepo, never, SqlClient.SqlClient> =
  Layer.effect(DocumentsRepo, Effect.die(new Error("DocumentsRepoSql is not implemented yet")));
