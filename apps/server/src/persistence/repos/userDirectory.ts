/**
 * `UserDirectory` over Better Auth's `auth.user` table: Member names and emails. A deleted account
 * (tombstoned, http-mcp-contracts G10) is hidden at once, so it is left out like an unknown id.
 */
import { UserDirectory } from "@kvitbit/core";
import type { UserId } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { unavailable } from "../errors";

export const UserDirectorySql: Layer.Layer<UserDirectory, never, SqlClient.SqlClient> =
  Layer.effect(
    UserDirectory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        lookup: (ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : Effect.map(
                unavailable(
                  sql<{ id: string; name: string; email: string }>`
                    select id, name, email from auth."user"
                    where id in ${sql.in([...new Set(ids)])} and deleted_at is null`,
                ),
                (rows) =>
                  rows.map((row) => ({
                    userId: row.id as UserId,
                    name: row.name,
                    email: row.email,
                  })),
              ),
      };
    }),
  );
