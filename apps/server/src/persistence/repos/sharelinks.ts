/** `ShareLinksRepo` over Postgres. STUB: replaced by its implementation. */
import { ShareLinksRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const ShareLinksRepoSql: Layer.Layer<ShareLinksRepo, never, SqlClient.SqlClient> =
  Layer.effect(ShareLinksRepo, Effect.die(new Error("ShareLinksRepoSql is not implemented yet")));
