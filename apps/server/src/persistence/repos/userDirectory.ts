/**
 * `UserDirectory` over Better Auth's `auth.user` table: Member names and emails. A deleted account
 * (tombstoned, http-mcp-contracts G10) is hidden at once, so it is left out like an unknown id.
 */
import { UserDirectory } from "@kvitbit/core";
import { UserId } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { unavailable } from "../errors";

export const UserDirectorySql: Layer.Layer<UserDirectory, never, SqlClient.SqlClient> =
  Layer.effect(
    UserDirectory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        lookup: Effect.fn("UserDirectory.lookup")((ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : Effect.map(
                unavailable(
                  sql<{ id: string; name: string; email: string }>`
                    select id, name, email from auth."user"
                    where id in ${sql.in([...new Set(ids)])} and deleted_at is null`,
                ),
                (rows) =>
                  Arr.map(rows, (row) => ({
                    userId: UserId.make(row.id),
                    name: row.name,
                    email: row.email,
                  })),
              ),
        ),
      };
    }),
  );
