/** `ContactsRepo` over Postgres. STUB: replaced by its implementation. */
import { ContactsRepo } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const ContactsRepoSql: Layer.Layer<ContactsRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContactsRepo,
  Effect.die(new Error("ContactsRepoSql is not implemented yet")),
);
