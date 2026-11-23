import { describe, expect, test } from "bun:test";
import type { AuditEntryId, RequestKey } from "@kvitbit/domain/contract";
import { Conflict, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { RatesUnavailable, RequestOutcome } from "@kvitbit/domain/ports";
import { BigDecimal, Cause, Effect, Exit, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { appendAudit } from "../src/shared/audit";
import { canonicalJson } from "../src/shared/canonicalJson";
import { orUnavailable } from "../src/shared/errors";
import { REQUEST_KEY_TTL_MILLIS, withIdempotency } from "../src/shared/idempotency";
import { IdGenerator, IdGeneratorLive } from "../src/shared/ids";
import { makeRequestOutcome } from "../src/shared/requestOutcome";
import { checkRevision } from "../src/shared/revision";
import { CoreStore, StoreUnavailable } from "../src/store/CoreStore";
import { account, member, runTest, system, TEST_NOW, WORKSPACE_A } from "./helpers";

const Payload = Schema.Struct({ amount: Schema.BigDecimal, note: Schema.optional(Schema.String) });
const Result = Schema.Struct({ id: Schema.String, total: Schema.BigDecimal });
const scope = { _tag: "Workspace", workspaceId: WORKSPACE_A } as const;
const key = "key-1" as RequestKey;

/** A body that counts its runs and returns a fresh id. */
const counted = (runs: Ref.Ref<number>) =>
  Effect.map(
    Ref.updateAndGet(runs, (n) => n + 1),
    (n) => ({
      id: `result-${n}`,
      total: BigDecimal.fromStringUnsafe("10.50"),
    }),
  );

const call = (
  runs: Ref.Ref<number>,
  payload: typeof Payload.Type,
  options: { readonly method?: string; readonly key?: RequestKey | undefined } = {},
) =>
  withIdempotency(
    {
      scope,
      key: "key" in options ? options.key : key,
      method: options.method ?? "Test.create",
      payload: { schema: Payload, value: payload },
      result: Result,
    },
    counted(runs),
  );

const amount = (s: string) => BigDecimal.fromStringUnsafe(s);

describe("withIdempotency (rule C3)", () => {
  test("same key and payload replays the stored result without rerunning, and marks replayed", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const first = yield* call(runs, { amount: amount("1.0"), note: "a" });
        const fresh = yield* makeRequestOutcome;
        // Key order and an equal decimal re-encoding hash the same.
        const second = yield* call(runs, { note: "a", amount: amount("1.0") }).pipe(
          Effect.provideService(RequestOutcome, fresh),
        );
        return {
          same: first.id === second.id,
          total: BigDecimal.format(second.total),
          runs: yield* Ref.get(runs),
          replayed: yield* fresh.replayed,
        };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ same: true, total: "10.5", runs: 1, replayed: true }));
  });

  test("the first call is not marked replayed", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const outcome = yield* makeRequestOutcome;
        yield* call(runs, { amount: amount("1") }).pipe(
          Effect.provideService(RequestOutcome, outcome),
        );
        return yield* outcome.replayed;
      }),
    );
    expect(exit).toEqual(Exit.succeed(false));
  });

  test("same key with a different payload or method fails with idempotency_mismatch", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        yield* call(runs, { amount: amount("1") });
        const payload = yield* Effect.flip(call(runs, { amount: amount("2") }));
        const method = yield* Effect.flip(
          call(runs, { amount: amount("1") }, { method: "Test.other" }),
        );
        return { payload, method, runs: yield* Ref.get(runs) };
      }),
    );
    const mismatch = new Conflict({ reason: "idempotency_mismatch" });
    expect(exit).toEqual(Exit.succeed({ payload: mismatch, method: mismatch, runs: 1 }));
  });

  test("keys are scoped: another Workspace or a user scope does not replay", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        yield* call(runs, { amount: amount("1") });
        const base = {
          key,
          method: "Test.create",
          payload: { schema: Payload, value: { amount: amount("1") } },
          result: Result,
        };
        yield* withIdempotency(
          { ...base, scope: { _tag: "Workspace", workspaceId: "other" as never } },
          counted(runs),
        );
        yield* withIdempotency(
          { ...base, scope: { _tag: "User", userId: "u" as never } },
          counted(runs),
        );
        return yield* Ref.get(runs);
      }),
    );
    expect(exit).toEqual(Exit.succeed(3));
  });

  test("a key expires after 24 hours", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        yield* call(runs, { amount: amount("1") });
        yield* TestClock.adjust(REQUEST_KEY_TTL_MILLIS);
        yield* call(runs, { amount: amount("2") });
        return yield* Ref.get(runs);
      }),
    );
    expect(exit).toEqual(Exit.succeed(2));
  });

  test("a failed body stores nothing and rolls back, so a retry runs again", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const failing = withIdempotency(
          {
            scope,
            key,
            method: "Test.create",
            payload: { schema: Payload, value: { amount: amount("1") } },
            result: Result,
          },
          Effect.andThen(
            Ref.update(runs, (n) => n + 1),
            Effect.fail("nope" as const),
          ),
        );
        const error = yield* Effect.flip(failing);
        yield* call(runs, { amount: amount("1") });
        return { error, runs: yield* Ref.get(runs) };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ error: "nope", runs: 2 }));
  });

  test("no key: runs every time, in a transaction", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        yield* call(runs, { amount: amount("1") }, { key: undefined });
        yield* call(runs, { amount: amount("1") }, { key: undefined });
        return yield* Ref.get(runs);
      }),
    );
    expect(exit).toEqual(Exit.succeed(2));
  });

  test("a keyed call inside another transaction is a defect (claim must come first)", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const store = yield* CoreStore;
        return yield* store.transaction(call(runs, { amount: amount("1") }));
      }),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });

  test("concurrent first uses of a key run the body once", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const results = yield* Effect.all(
          Array.from({ length: 4 }, () => call(runs, { amount: amount("1") })),
          { concurrency: "unbounded" },
        );
        return { ids: new Set(results.map((r) => r.id)).size, runs: yield* Ref.get(runs) };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ ids: 1, runs: 1 }));
  });
});

describe("appendAudit (rule C5)", () => {
  const subject = { entity: "Document", id: "doc-1" } as const;

  test("a Member's entry carries channel, client, time and a fresh id; history is in order", async () => {
    const caller = member("member", { scopes: ["documents:write"] });
    const exit = await runTest(
      caller,
      Effect.gen(function* () {
        const store = yield* CoreStore;
        yield* store.transaction(
          appendAudit({ workspaceId: WORKSPACE_A, subject, action: "document.draft", revision: 1 }),
        );
        yield* TestClock.adjust(1000);
        yield* store.transaction(
          appendAudit({
            workspaceId: WORKSPACE_A,
            subject,
            action: "document.edit",
            revision: 2,
            changes: [{ path: "note", before: null, after: "x" }],
          }),
        );
        return yield* store.audit.history(WORKSPACE_A, subject);
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        {
          id: "01900000-0000-7000-8000-000000000001" as AuditEntryId,
          at: new Date(TEST_NOW).toISOString(),
          actor: { _tag: "Member", userId: caller.userId, channel: "api", client: caller.client },
          subject,
          action: "document.draft",
          revision: 1,
          changes: [],
          reason: null,
        },
        {
          id: "01900000-0000-7000-8000-000000000002" as AuditEntryId,
          at: new Date(TEST_NOW + 1000).toISOString(),
          actor: { _tag: "Member", userId: caller.userId, channel: "api", client: caller.client },
          subject,
          action: "document.edit",
          revision: 2,
          changes: [{ path: "note", before: null, after: "x" }],
          reason: null,
        },
      ]),
    );
  });

  test("a System entry names the job; an Account caller writes nothing", async () => {
    const job = { _tag: "DocumentDelivery", deliveryId: "d" as never } as const;
    const systemExit = await runTest(
      system(job),
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const entry = yield* store.transaction(
          appendAudit({ workspaceId: WORKSPACE_A, subject, action: "document.send", revision: 3 }),
        );
        return entry?.actor;
      }),
    );
    expect(systemExit).toEqual(Exit.succeed({ _tag: "System", job }));
    const accountExit = await runTest(
      account(),
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const entry = yield* store.transaction(
          appendAudit({
            workspaceId: WORKSPACE_A,
            subject,
            action: "workspace.create",
            revision: 1,
          }),
        );
        return [entry, (yield* store.audit.history(WORKSPACE_A, subject)).length];
      }),
    );
    expect(accountExit).toEqual(Exit.succeed([null, 0]));
  });
});

describe("small helpers", () => {
  test("checkRevision", () => {
    expect(Effect.runSyncExit(checkRevision({ revision: 3 }, 3))).toEqual(
      Exit.succeed({ revision: 3 }),
    );
    expect(Effect.runSyncExit(checkRevision({ revision: 3 }, 2))).toEqual(
      Exit.fail(new Conflict({ reason: "revision_changed", currentRevision: 3 })),
    );
  });

  test("orUnavailable maps port failures and keeps domain errors", () => {
    expect(Effect.runSyncExit(orUnavailable(Effect.fail(new StoreUnavailable({}))))).toEqual(
      Exit.fail(new Unavailable({ dependency: "database" })),
    );
    expect(Effect.runSyncExit(orUnavailable(Effect.fail(new RatesUnavailable({}))))).toEqual(
      Exit.fail(new Unavailable({ dependency: "exchange_rates" })),
    );
    const notFound = new NotFound({ entity: "Document", id: "x" });
    expect(Effect.runSyncExit(orUnavailable(Effect.fail(notFound)))).toEqual(Exit.fail(notFound));
  });

  test("canonicalJson sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: "x" }] })).toBe('{"a":[{"c":"x"}],"b":1}');
  });

  test("live ids are UUIDv7 and time-ordered", async () => {
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const gen = yield* IdGenerator;
        const a = yield* gen.next;
        yield* TestClock.adjust(5);
        const b = yield* gen.next;
        return [a, b];
      }).pipe(Effect.provide(Layer.merge(IdGeneratorLive, TestClock.layer()))),
    );
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const [a, b] = ids;
    expect(a !== undefined && b !== undefined && a < b).toBe(true);
  });
});
