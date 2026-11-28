import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { layerFromPglite } from "@kvitbit/adapters/testing";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../src/migrate";

describe("migrate: Drizzle + Effect Cluster SQL migrations", () => {
  test("applies both Drizzle domain tables and Effect Cluster tables and is idempotent", async () => {
    const pglite = new PGlite();
    try {
      const sqlLayer = layerFromPglite(pglite);

      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const res = yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const tables = yield* sql<{ readonly table_name: string }>`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
          `;
          return { res, names: Arr.map(tables, (t) => t.table_name) };
        }).pipe(Effect.provide(sqlLayer)),
      );

      expect(first.res.total).toBeGreaterThan(0);
      expect(first.res.applied).toBe(first.res.total);

      // Core Drizzle tables
      expect(first.names).toContain("workspaces");
      expect(first.names).toContain("documents");
      expect(first.names).toContain("deliveries");
      expect(first.names).toContain("exports");
      expect(first.names).toContain("invitations");
      expect(first.names).toContain("request_log");
      expect(first.names).toContain("altcha_replays");
      expect(first.names).toContain("fx_fixings");

      // Effect Cluster SQL tables
      expect(first.names).toContain("cluster_messages");
      expect(first.names).toContain("cluster_replies");
      expect(first.names).toContain("cluster_runners");
      expect(first.names).toContain("cluster_locks");

      // Idempotent second run
      const second = await Effect.runPromise(runMigrations().pipe(Effect.provide(sqlLayer)));
      expect(second.applied).toBe(0);
      expect(second.total).toBe(first.res.total);
    } finally {
      await pglite.close();
    }
  }, 30_000);
});
