/**
 * Row-lock contention against a real Postgres (PGlite is one connection and cannot show it,
 * core-ports.md section 10). Runs only when DATABASE_URL points at a scratch server whose role may
 * create databases; it creates a throwaway database, applies packages/db/drizzle, and drops it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import {
  allocateNumber,
  claimRequest,
  lockRowForUpdate,
  type NumberCandidate,
  updateWithRevision,
} from "@kvitbit/adapters/sql";
import { Deferred, Effect, Fiber, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { seedWorkspace } from "./pglite";

const databaseUrl = process.env.DATABASE_URL;
const drizzleDir = fileURLToPath(new URL("../../../db/drizzle", import.meta.url));
const dbName = `kvitbit_sql_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const adminRuntime = (url: string) =>
  ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }));

let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

const withDatabase = (name: string): string => {
  const url = new URL(databaseUrl ?? "");
  url.pathname = `/${name}`;
  return url.toString();
};

const migrationStatements = (): Array<string> =>
  readdirSync(drizzleDir)
    .sort()
    .flatMap((dir) =>
      readFileSync(`${drizzleDir}/${dir}/migration.sql`, "utf8").split("--> statement-breakpoint"),
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const format = ({ counter }: NumberCandidate) => `C${String(counter).padStart(4, "0")}`;

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });

describe.skipIf(databaseUrl === undefined)("contention on Postgres", () => {
  beforeAll(async () => {
    const admin = adminRuntime(databaseUrl ?? "");
    await admin.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`create database "${dbName}"`);
      }),
    );
    await admin.dispose();
    runtime = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(withDatabase(dbName)), maxConnections: 4 }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of migrationStatements()) yield* sql.unsafe(statement);
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    const admin = adminRuntime(databaseUrl ?? "");
    await admin.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`drop database if exists "${dbName}"`);
      }),
    );
    await admin.dispose();
  });

  test("a second issuer waits on the counter lock and gets the next number", async () => {
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const locked = yield* Deferred.make<void>();
        const allocate = allocateNumber({ workspaceId, seriesId, period: "2026", format });
        const first = yield* transaction(
          allocate.pipe(
            Effect.tap(() => Deferred.succeed(locked, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const second = yield* transaction(allocate);
        return [yield* Fiber.join(first), second] as const;
      }).pipe(Effect.scoped),
    );
    expect([first.number, second.number]).toEqual(["C0001", "C0002"]);
  }, 30_000);

  test("of two writers holding the same revision, the second gets RevisionConflict", async () => {
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const locked = yield* Deferred.make<void>();
        const first = yield* transaction(
          lockRowForUpdate("numbering_series", workspaceId, seriesId).pipe(
            Effect.tap(() => Deferred.succeed(locked, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
            Effect.andThen(
              updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "A" }),
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const second = yield* transaction(
          updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "B" }),
        ).pipe(Effect.flip);
        return [yield* Fiber.join(first), second] as const;
      }).pipe(Effect.scoped),
    );
    expect(first).toMatchObject({ name: "A", revision: 2 });
    expect(second).toMatchObject({ _tag: "RevisionConflict", currentRevision: 2 });
  }, 30_000);

  test("a concurrent claim of the same request key waits and replays", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const request = { requestKey: "k", method: "Documents.issue", payloadHash: "h" };
        const claimed = yield* Deferred.make<void>();
        const first = yield* transaction(
          claimRequest({ workspaceId }, { ...request, result: { id: "first" } }).pipe(
            Effect.tap(() => Deferred.succeed(claimed, undefined)),
            Effect.tap(() => Effect.sleep("200 millis")),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(claimed);
        const second = yield* transaction(
          claimRequest({ workspaceId }, { ...request, result: { id: "second" } }),
        );
        yield* Fiber.join(first);
        return second;
      }).pipe(Effect.scoped),
    );
    expect(outcome).toEqual({ _tag: "Replayed", result: { id: "first" } });
  }, 30_000);
});
