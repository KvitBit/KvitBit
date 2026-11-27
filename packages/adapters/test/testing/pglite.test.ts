import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerFromPglite, layerMigrated, makeMigratedPglite } from "../../src/testing";

const countAuthAndPublicTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ n: number }>`
    select count(*)::int as n from information_schema.tables
    where table_schema in ('public', 'auth') and table_name in ('altcha_replays', 'apikey')`;
  return rows[0]?.n;
});

describe("testing helpers", () => {
  test("layerMigrated provides a SqlClient over a migrated database", async () => {
    const n = await Effect.runPromise(countAuthAndPublicTables.pipe(Effect.provide(layerMigrated)));
    expect(n).toBe(2);
  });

  test("layerFromPglite leaves the caller's client open", async () => {
    const client = await makeMigratedPglite();
    try {
      const n = await Effect.runPromise(
        countAuthAndPublicTables.pipe(Effect.provide(layerFromPglite(client))),
      );
      expect(n).toBe(2);
      const after = await client.query<{ one: number }>("select 1 as one");
      expect(after.rows[0]?.one).toBe(1);
    } finally {
      await client.close();
    }
  });
});
