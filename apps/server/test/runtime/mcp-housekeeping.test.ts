import { expect, test } from "bun:test";
import { ReportsModule } from "@kvitbit/core";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PgliteTestDatabase } from "../../src/persistence";
import { DEFAULT_REQUEST_LOG_RETENTION_MS, makeCronHandlers } from "../../src/runtime/crons";

test("housekeeping retains consumed confirmations through the request-log replay window", async () => {
  const retained = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const at = (offset: number) => new Date(now + offset).toISOString();
      const workspaceId = "01950000-0000-7000-8000-000000000001";
      yield* sql`INSERT INTO workspaces (id, slug, name) VALUES (${workspaceId}, 'fixture', 'Fixture')`;
      yield* sql`INSERT INTO auth."user" (id, name, email) VALUES ('user', 'Test User', 'user@example.test')`;
      yield* sql`INSERT INTO auth.oauth_client (id, client_id, redirect_uris) VALUES ('client', 'client', '{}')`;
      yield* sql`INSERT INTO auth.oauth_consent (id, client_id, user_id, scopes) VALUES ('grant', 'client', 'user', '{documents:write}')`;

      const fixtures = [
        { name: "available", expiresAt: at(60_000), consumedAt: null },
        { name: "expired", expiresAt: at(-60_000), consumedAt: null },
        { name: "replayable", expiresAt: at(-60_000), consumedAt: at(-120_000) },
        {
          name: "past-replay",
          expiresAt: at(-60_000),
          consumedAt: at(-DEFAULT_REQUEST_LOG_RETENTION_MS - 60_000),
        },
      ];
      for (const [index, fixture] of fixtures.entries()) {
        yield* sql`INSERT INTO mcp_confirmations
          (id, token_hash, grant_id, user_id, workspace_id, tool, args_hash, expires_at, consumed_at)
          VALUES (${`01950000-0000-7000-8000-00000000000${index + 2}`}, ${fixture.name},
            'grant', 'user', ${workspaceId}, 'issue_document', 'fixture', ${fixture.expiresAt}, ${fixture.consumedAt})`;
      }

      yield* makeCronHandlers().housekeeping.pipe(
        Effect.provideService(
          ReportsModule.ExportJobs,
          ReportsModule.ExportJobs.of({
            purgeExpired: Effect.succeed(0),
            reportingTables: () => Effect.die("Unexpected reporting table lookup"),
            finish: () => Effect.die("Unexpected export completion"),
            fail: () => Effect.die("Unexpected export failure"),
          }),
        ),
      );
      const rows = yield* sql<{
        readonly token_hash: string;
      }>`SELECT token_hash FROM mcp_confirmations ORDER BY id`;
      return rows.map(({ token_hash }) => token_hash);
    }).pipe(Effect.provide(PgliteTestDatabase)),
  );
  expect(retained).toEqual(["available", "replayable"]);
}, 30_000);
