/**
 * Row-lock contention against a real Postgres (PGlite is one connection and cannot show it,
 * core-ports.md section 10). Runs only when DATABASE_URL points at a scratch server whose role may
 * create databases; it creates a throwaway database, applies packages/db/drizzle, and drops it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import { generateId } from "@kvitbit/adapters/auth";
import {
  allocateNumber,
  claimRequest,
  completeRequest,
  lockRowForUpdate,
  type NumberCandidate,
  transactionWithRetry,
  updateWithRevision,
} from "@kvitbit/adapters/sql";
import { migrationsFolder } from "@kvitbit/adapters/testing";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { seedWorkspace } from "./pglite";

const databaseUrl = Config.Redacted("DATABASE_URL").pipe(
  Config.option,
  Effect.runSync,
  Option.getOrUndefined,
);

const format = ({ counter }: NumberCandidate) => `C${Str.padStart(4, "0")(String(counter))}`;

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });

describe.skipIf(databaseUrl === undefined)("contention on Postgres", () => {
  const dbName = `kvitbit_sql_test_${generateId()}`;
  const adminUrl = databaseUrl ?? Redacted.make("postgres://localhost");
  const testUrl = new URL(Redacted.value(adminUrl));
  testUrl.pathname = `/${dbName}`;
  const admin = ManagedRuntime.make(PgClient.layer({ url: adminUrl, maxConnections: 1 }));
  const runtime = ManagedRuntime.make(
    PgClient.layer({ url: Redacted.make(testUrl.toString()), maxConnections: 4 }),
  );

  beforeAll(async () => {
    await admin.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`create database "${dbName}"`);
      }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const migration of readMigrationFiles({ migrationsFolder })) {
          for (const statement of migration.sql) yield* sql.unsafe(statement);
        }
      }),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await runtime.dispose();
      await admin.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`drop database if exists "${dbName}"`);
        }),
      );
    } finally {
      await admin.dispose();
    }
  });

  test("a second issuer waits on the counter lock and gets the next number", async () => {
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const locked = yield* Deferred.make<void>();
        const allocate = allocateNumber({ workspaceId, seriesId, period: () => "2026", format });
        const firstWriter = yield* transaction(
          allocate.pipe(
            Effect.tap(() => Deferred.succeed(locked, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const secondWriter = yield* transaction(allocate);
        return [yield* Fiber.join(firstWriter), secondWriter] as const;
      }).pipe(Effect.scoped),
    );
    expect([first.number, second.number]).toEqual(["C0001", "C0002"]);
  }, 30_000);

  test("of two writers holding the same revision, the second gets RevisionConflict", async () => {
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const locked = yield* Deferred.make<void>();
        const firstWriter = yield* transaction(
          lockRowForUpdate("numbering_series", workspaceId, seriesId).pipe(
            Effect.tap(() => Deferred.succeed(locked, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
            Effect.andThen(
              updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "A" }),
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const secondWriter = yield* transaction(
          updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "B" }),
        ).pipe(Effect.flip);
        return [yield* Fiber.join(firstWriter), secondWriter] as const;
      }).pipe(Effect.scoped),
    );
    expect(first).toMatchObject({ name: "A", revision: 2 });
    expect(second).toMatchObject({ _tag: "RevisionConflict", currentRevision: 2 });
  }, 30_000);

  test("a second issuer waiting on a counter lock that rolls back gets the same number", async () => {
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const locked = yield* Deferred.make<void>();
        const allocate = allocateNumber({ workspaceId, seriesId, period: () => "2026", format });
        const first = yield* transaction(
          allocate.pipe(
            Effect.tap(() => Deferred.succeed(locked, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
            Effect.andThen(Effect.fail("issue failed" as const)),
          ),
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(locked);
        const secondWriter = yield* transaction(allocate);
        const failure = yield* Fiber.join(first);
        expect(failure).toBe("issue failed");
        return secondWriter;
      }).pipe(Effect.scoped),
    );
    expect(second).toMatchObject({ number: "C0001", counter: 1 });
  }, 30_000);

  test("a series pattern change waits for an open allocation", async () => {
    const order = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const events: Array<string> = [];
        const allocated = yield* Deferred.make<void>();
        const first = yield* transaction(
          allocateNumber({ workspaceId, seriesId, period: () => "2026", format }).pipe(
            Effect.tap(() => Deferred.succeed(allocated, undefined)),
            Effect.tap(() => Effect.sleep("300 millis")),
            Effect.tap(() => Effect.sync(() => events.push("allocation commits"))),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(allocated);
        yield* transaction(
          updateWithRevision("numbering_series", workspaceId, seriesId, 1, { pattern: "X{NNNN}" }),
        );
        events.push("pattern updated");
        yield* Fiber.join(first);
        return events;
      }).pipe(Effect.scoped),
    );
    expect(order).toEqual(["allocation commits", "pattern updated"]);
  }, 30_000);

  const request = { requestKey: "k", method: "Documents.issue", payloadHash: "h" };
  const now = "2026-11-23T10:00:00Z";

  const concurrentClaim = (ownerCommits: boolean) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        const claimed = yield* Deferred.make<void>();
        const first = yield* transaction(
          claimRequest(scope, "k", { now }).pipe(
            Effect.tap(() => Deferred.succeed(claimed, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
            Effect.tap(() => completeRequest(scope, { ...request, result: { id: "first" } })),
            Effect.andThen(ownerCommits ? Effect.void : Effect.fail("owner failed" as const)),
          ),
        ).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(claimed);
        const second = yield* transaction(claimRequest(scope, "k", { now }));
        yield* Fiber.join(first);
        return second;
      }).pipe(Effect.scoped),
    );

  test("a concurrent claim of the same key waits for the owner and sees its entry", async () => {
    expect(await concurrentClaim(true)).toMatchObject({
      _tag: "Existing",
      entry: { ...request, result: { id: "first" } },
    });
  }, 30_000);

  test("a concurrent claim takes the key when the owner rolls back", async () => {
    expect(await concurrentClaim(false)).toEqual({ _tag: "Claimed" });
  }, 30_000);

  test("transactionWithRetry recovers both sides of a deadlock", async () => {
    const names = await runtime.runPromise(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        const bothLocked = yield* Deferred.make<void>();
        let locks = 0;
        const lockThen = (first: typeof a, second: typeof a, name: string) =>
          transactionWithRetry(
            Effect.gen(function* () {
              yield* lockRowForUpdate("workspaces", first.workspaceId, first.workspaceId);
              locks += 1;
              if (locks === 2) yield* Deferred.succeed(bothLocked, undefined);
              yield* Deferred.await(bothLocked).pipe(Effect.timeout("2 seconds"), Effect.ignore);
              const row = yield* lockRowForUpdate(
                "workspaces",
                second.workspaceId,
                second.workspaceId,
              );
              return yield* updateWithRevision(
                "workspaces",
                second.workspaceId,
                second.workspaceId,
                Number(row.revision),
                { name },
              );
            }),
          );
        const rows = yield* Effect.all([lockThen(a, b, "from-a"), lockThen(b, a, "from-b")], {
          concurrency: 2,
        });
        return { rows, locks };
      }),
    );
    expect(Arr.map(names.rows, (row) => row.name).sort()).toEqual(["from-a", "from-b"]);
    // Two first attempts plus at least one rerun of the deadlock victim's body.
    expect(names.locks).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
