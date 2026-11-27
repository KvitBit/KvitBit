import { expect, test } from "bun:test";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { GcsAccessToken, LocalDiskBlobStorage, MemoryBlobStorage } from "@kvitbit/adapters/blob";
import { ReportsModule } from "@kvitbit/core";
import { BlobKey } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { PgliteTestDatabase } from "../../src/persistence";
import { DEFAULT_REQUEST_LOG_RETENTION_MS, makeCronHandlers } from "../../src/runtime/crons";
import {
  AttachmentInventory,
  gcsAttachmentInventory,
  localAttachmentInventory,
} from "../../src/wiring/attachmentInventory";

const ExportJobs = Layer.succeed(ReportsModule.ExportJobs, {
  purgeExpired: Effect.succeed(0),
  reportingTables: () => Effect.die("Unexpected reporting table lookup"),
  finish: () => Effect.die("Unexpected export completion"),
  fail: () => Effect.die("Unexpected export failure"),
});

test("GCS inventory follows page tokens and selects only older attachment objects", async () => {
  const prefix =
    "workspaces/01950000-0000-7000-8000-000000000001/expenses/01950000-0000-7000-8000-000000000002/attachments/";
  const old = `${prefix}01950000-0000-7000-8000-000000000003`;
  const fresh = `${prefix}01950000-0000-7000-8000-000000000004`;
  const pageTokens: (string | null)[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const token = Option.getOrNull(UrlParams.getFirst(request.urlParams, "pageToken"));
      pageTokens.push(token);
      expect(new URL(request.url).pathname).toBe("/storage/v1/b/fixture/o");
      expect(UrlParams.getFirst(request.urlParams, "matchGlob")).toEqual(
        Option.some("workspaces/*/expenses/*/attachments/*"),
      );
      const body =
        token === null
          ? { items: [{ name: fresh, timeCreated: "2020-02-01T00:00:00Z" }], nextPageToken: "p2" }
          : {
              items: [
                { name: old, timeCreated: "2020-01-01T00:00:00Z" },
                { name: "workspaces/other/document", timeCreated: "2020-01-01T00:00:00Z" },
              ],
            };
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  const inventory = gcsAttachmentInventory("fixture").pipe(
    Layer.provide([
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(GcsAccessToken, {
        get: Effect.succeed("fixture"),
        invalidate: () => Effect.void,
      }),
    ]),
  );
  const keys = await Effect.runPromise(
    Effect.flatMap(AttachmentInventory, (storage) =>
      Stream.runCollect(storage.olderThan(Date.parse("2020-01-15T00:00:00Z"))),
    ).pipe(Effect.provide(inventory)),
  );
  expect(pageTokens).toEqual([null, "p2"]);
  expect(keys).toEqual([BlobKey.make(old)]);
});

test("housekeeping retains consumed confirmations through the request-log replay window", async () => {
  const retained = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const at = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offset));
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

      yield* makeCronHandlers().housekeeping;
      const rows = yield* sql<{
        readonly token_hash: string;
      }>`SELECT token_hash FROM mcp_confirmations ORDER BY id`;
      return Arr.map(rows, ({ token_hash }) => token_hash);
    }).pipe(
      Effect.provide([
        PgliteTestDatabase,
        ExportJobs,
        MemoryBlobStorage.layer,
        Layer.succeed(AttachmentInventory, { olderThan: () => Stream.empty }),
      ]),
    ),
  );
  expect(retained).toEqual(["available", "replayable"]);
}, 30_000);

test("housekeeping collects only old uncommitted attachments and rolls up closed UTC days", async () => {
  const workspace = "01950000-0000-7000-8000-000000000001";
  const expense = "01950000-0000-7000-8000-000000000002";
  const committed = "01950000-0000-7000-8000-000000000003";
  const orphan = "01950000-0000-7000-8000-000000000004";
  const recent = "01950000-0000-7000-8000-000000000005";
  const share = "01950000-0000-7000-8000-000000000006";
  const contact = "01950000-0000-7000-8000-000000000007";
  const document = "01950000-0000-7000-8000-000000000008";
  const prefix = `workspaces/${workspace}/expenses/${expense}/attachments`;
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-staged-attachments-" });
    yield* fs.makeDirectory(path.join(root, prefix), { recursive: true });
    for (const id of [committed, orphan, recent]) {
      const file = path.join(root, prefix, id);
      yield* fs.writeFileString(file, "fixture");
      if (id !== recent) yield* fs.utimes(file, 0, 0);
    }

    const rollups = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO workspaces (id, slug, name) VALUES (${workspace}, 'fixture', 'Fixture')`;
      yield* sql`INSERT INTO expenses (id, workspace_id, status)
          VALUES (${expense}, ${workspace}, 'incomplete')`;
      yield* sql`INSERT INTO attachments (id, workspace_id, expense_id, blob_key, content_type, bytes, sha256)
          VALUES (${committed}, ${workspace}, ${expense}, ${`${prefix}/${committed}`}, 'image/png', 7, 'fixture')`;
      yield* sql`INSERT INTO contacts (id, workspace_id, name) VALUES (${contact}, ${workspace}, 'Fixture')`;
      yield* sql`INSERT INTO documents (id, workspace_id, kind, contact_id, currency, language, payment_method)
          VALUES (${document}, ${workspace}, 'invoice', ${contact}, 'CZK', 'cs', 'bank_transfer')`;
      yield* sql`INSERT INTO share_links (id, workspace_id, document_id, token_hash, key_version)
          VALUES (${share}, ${workspace}, ${document}, 'fixture', 1)`;
      yield* sql`INSERT INTO share_view_events (id, workspace_id, share_link_id, kind, device, visitor_hash, at)
          VALUES (gen_random_uuid(), ${workspace}, ${share}, 'view', 'desktop', 'day-1', '2020-01-01T14:00:00Z'),
                 (gen_random_uuid(), ${workspace}, ${share}, 'view', 'mobile', 'day-2', '2020-01-01T15:00:00Z'),
                 (gen_random_uuid(), ${workspace}, ${share}, 'download', 'desktop', 'day-1', '2020-01-01T16:00:00Z'),
                 (gen_random_uuid(), ${workspace}, ${share}, 'view', 'desktop', 'today', ${DateTime.toDateUtc(DateTime.makeUnsafe(now))})`;
      yield* makeCronHandlers().housekeeping;
      yield* makeCronHandlers().housekeeping;
      return yield* sql`SELECT day::text, views::text, downloads::text FROM share_view_rollups`;
    }).pipe(
      Effect.provide([
        PgliteTestDatabase,
        ExportJobs,
        LocalDiskBlobStorage.layer({ root }),
        localAttachmentInventory(root),
      ]),
    );
    const orphanExists = yield* fs.exists(path.join(root, prefix, orphan));
    const committedFile = yield* fs.stat(path.join(root, prefix, committed));
    const recentFile = yield* fs.stat(path.join(root, prefix, recent));
    return { rollups, orphanExists, committedFile, recentFile };
  });

  const result = await Effect.runPromise(
    fixture.pipe(Effect.scoped, Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
  expect(result.rollups).toEqual([{ day: "2020-01-01", views: "2", downloads: "1" }]);
  expect(result.orphanExists).toBe(false);
  expect(result.committedFile.type).toBe("File");
  expect(result.recentFile.type).toBe("File");
}, 30_000);
