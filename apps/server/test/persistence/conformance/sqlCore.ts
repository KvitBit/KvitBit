/**
 * The whole core (`CoreModulesLive`) on `PersistenceLive` over a fresh migrated PGlite, with the
 * fakes `TestCore` uses for every other external port. `runSqlCore` mirrors core's `runCore`
 * (packages/core/test/helpers/run.ts), so the e2e scenarios ported here run unchanged against
 * the SQL store; directory users are seeded into `auth.user` instead of the fake directory.
 */
import { CoreModulesLive } from "@kvitbit/core";
import {
  BrandingPreviewFake,
  CaptureEmailSender,
  CaptureInvitationDelivery,
  DeliveryJobsMemory,
  DocumentRendererFake,
  FakeCompanyRegistry,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  FixtureRates,
  IdGeneratorTest,
  InvitationTokensFake,
  MemoryBlobStorage,
  ShareLinkKeysTest,
  type TestCoreOptions,
} from "@kvitbit/core/testing";
import type { Caller } from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import { Effect, type Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { PersistenceLive, PgliteTestDatabase } from "../../../src/persistence";

/** 2026-11-23T09:00:00Z, as core's `TEST_NOW`. */
export const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);

const seedUsers = (users: NonNullable<TestCoreOptions["users"]>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const user of users) {
        yield* sql`insert into auth."user" (id, name, email)
          values (${user.userId}, ${user.name}, ${user.email})`;
      }
    }).pipe(Effect.orDie),
  );

/** `TestCore`, with `PersistenceLive` over PGlite in place of the memory store and repos. */
export const SqlTestCore = (options: TestCoreOptions = {}) => {
  const database = PgliteTestDatabase.pipe(Layer.orDie);
  const persistence = Layer.merge(PersistenceLive, seedUsers(options.users ?? [])).pipe(
    Layer.provideMerge(database),
  );
  const fakes = Layer.mergeAll(
    CaptureInvitationDelivery.layer,
    InvitationTokensFake,
    BrandingPreviewFake,
    DocumentRendererFake,
    FakeReportPdfRenderer.layer,
    DeliveryJobsMemory,
    FakeExportWorkflow.layer,
    ShareLinkKeysTest,
  );
  const ports = Layer.mergeAll(
    IdGeneratorTest,
    FakeCompanyRegistry.layer(options.registry),
    FixtureRates.layer(options.fixings),
    CaptureEmailSender.layer,
    MemoryBlobStorage.layer,
  );
  return CoreModulesLive.pipe(
    Layer.provideMerge(Layer.mergeAll(persistence, fakes)),
    Layer.provideMerge(ports),
  );
};

export type SqlTestCoreServices = Layer.Success<ReturnType<typeof SqlTestCore>>;

/** Core's `runCore` on `SqlTestCore`. */
export const runSqlCore = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, SqlTestCoreServices | CurrentCaller>,
  options: TestCoreOptions = {},
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(
      Effect.provideService(CurrentCaller, caller),
      Effect.provide(Layer.merge(SqlTestCore(options), TestClock.layer())),
    ),
  );

/** Runs `effect` as `caller` (switch callers inside with `asCaller`). */
export const asCaller = <A, E, R>(
  caller: Caller,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
  Effect.provideService(effect, CurrentCaller, caller);
