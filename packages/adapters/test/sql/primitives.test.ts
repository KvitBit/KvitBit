import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateId } from "@kvitbit/adapters/auth";
import {
  allocateNumber,
  checkRevision,
  claimRequest,
  completeRequest,
  lockCounter,
  lockRowForUpdate,
  lookupRequest,
  type NumberCandidate,
  peekCounter,
  reserveNumber,
  revisionedTableNames,
  setCounter,
  transactionWithRetry,
  tryReserveNumber,
  updateWithRevision,
} from "@kvitbit/adapters/sql";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { type MigratedPglite, migratedPglite, seedWorkspace } from "./pglite";

let db: MigratedPglite;

beforeAll(async () => {
  db = await migratedPglite();
}, 60_000);

afterAll(async () => {
  await db.close();
});

const INVALID_PATCH = /is not allowed|is undefined/;

const format = ({ period, counter }: NumberCandidate) =>
  `FV${period}${Str.padStart(4, "0")(String(counter))}`;

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.orElseSucceed(() => "succeeded" as const),
  );

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });

const counterOf = (seriesId: string, period: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ next_counter: number }>`
      select next_counter from numbering_counters where series_id = ${seriesId} and period = ${period}`;
    return rows[0]?.next_counter;
  });

const reservationsOf = (workspaceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ number: string }>`
      select number from number_reservations where workspace_id = ${workspaceId} order by number`;
    return Arr.map(rows, (row) => row.number);
  });

describe("row locking", () => {
  test("returns the row in its own Workspace inside a transaction", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* transaction(lockRowForUpdate("numbering_series", workspaceId, seriesId));
      }),
    );
    expect(row["name"]).toBe("Invoices");
    expect(row["revision"]).toBe(1);
  });

  test("a row of another Workspace is RowNotFound", async () => {
    const error = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        return yield* failure(lockRowForUpdate("numbering_series", b.workspaceId, a.seriesId));
      }),
    );
    expect(error).toMatchObject({ _tag: "RowNotFound", table: "numbering_series" });
  });

  test("workspaces are scoped by their own id", async () => {
    const [own, other] = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        const ownedRow = yield* lockRowForUpdate("workspaces", a.workspaceId, a.workspaceId);
        const foreignRow = yield* failure(
          lockRowForUpdate("workspaces", b.workspaceId, a.workspaceId),
        );
        return [ownedRow, foreignRow] as const;
      }),
    );
    expect(own["id"]).toBeDefined();
    expect(other).toMatchObject({ _tag: "RowNotFound" });
  });

  test("checkRevision compares the locked row's revision", async () => {
    const [ok, stale] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const row = yield* lockRowForUpdate("numbering_series", workspaceId, seriesId);
        const currentCheck = yield* failure(checkRevision("numbering_series", row, 1));
        const staleCheck = yield* failure(checkRevision("numbering_series", row, 2));
        return [currentCheck, staleCheck] as const;
      }),
    );
    expect(ok).toBe("succeeded");
    expect(stale).toMatchObject({
      _tag: "RevisionConflict",
      expectedRevision: 2,
      currentRevision: 1,
    });
  });

  test("a table outside the whitelist is a defect", async () => {
    const run = db.run(
      lockRowForUpdate(
        // @ts-expect-error Exercise rejection when an untyped caller supplies a table name.
        "invalid;sql",
        generateId(),
        "x",
      ),
    );
    await expect(run).rejects.toThrow("not a revisioned table");
  });
});

describe("whitelist", () => {
  test("every revisioned table has its scope, id, revision and updated_at columns", async () => {
    const errors = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const missing = generateId();
        return yield* Effect.forEach(
          revisionedTableNames,
          (table) =>
            Effect.all(
              [
                failure(lockRowForUpdate(table, workspaceId, missing)),
                failure(updateWithRevision(table, workspaceId, missing, 1, {})),
              ],
              { concurrency: 1 },
            ),
          { concurrency: 1 },
        );
      }),
    );
    for (const pair of errors) {
      for (const error of pair) expect(error).toMatchObject({ _tag: "RowNotFound" });
    }
  });
});

describe("updateWithRevision", () => {
  test("applies the patch and bumps revision", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* updateWithRevision("numbering_series", workspaceId, seriesId, 1, {
          name: "Renamed",
        });
      }),
    );
    expect(row["name"]).toBe("Renamed");
    expect(row["revision"]).toBe(2);
  });

  test("an empty patch still bumps revision", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        return yield* updateWithRevision("workspaces", workspaceId, workspaceId, 1, {});
      }),
    );
    expect(row["revision"]).toBe(2);
  });

  test("a stale revision is RevisionConflict with the current revision, and changes nothing", async () => {
    const [error, after] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "B" });
        const conflict = yield* failure(
          updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "C" }),
        );
        const storedRow = yield* lockRowForUpdate("numbering_series", workspaceId, seriesId);
        return [conflict, storedRow] as const;
      }),
    );
    expect(error).toMatchObject({
      _tag: "RevisionConflict",
      expectedRevision: 1,
      currentRevision: 2,
    });
    expect(after).toMatchObject({ name: "B", revision: 2 });
  });

  test("another Workspace's row is RowNotFound and stays untouched", async () => {
    const [error, after] = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        const conflict = yield* failure(
          updateWithRevision("numbering_series", b.workspaceId, a.seriesId, 1, { name: "X" }),
        );
        const storedRow = yield* lockRowForUpdate("numbering_series", a.workspaceId, a.seriesId);
        return [conflict, storedRow] as const;
      }),
    );
    expect(error).toMatchObject({ _tag: "RowNotFound" });
    expect(after).toMatchObject({ name: "Invoices", revision: 1 });
  });

  test("protected, malformed or undefined patch columns are a defect", async () => {
    for (const patch of [
      { revision: 9 },
      { workspace_id: "x" },
      { 'name" = 1; --': "x" },
      { name: undefined },
      { column_typo: 1 },
    ]) {
      const run = db.run(
        Effect.gen(function* () {
          const { workspaceId, seriesId } = yield* seedWorkspace;
          return yield* updateWithRevision("numbering_series", workspaceId, seriesId, 1, patch);
        }),
      );
      // biome-ignore lint/performance/noAwaitInLoops: Finish each query before reusing the client.
      await expect(run).rejects.toThrow(INVALID_PATCH);
    }
  });
});

describe("allocateNumber", () => {
  test("allocates a gapless sequence per series and period", async () => {
    const [numbers, nextIn2026, nextIn2027] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const allocate = (period: string) =>
          transaction(allocateNumber({ workspaceId, seriesId, period: () => period, format }));
        const numbersResult = [
          yield* allocate("2026"),
          yield* allocate("2026"),
          yield* allocate("2027"),
          yield* allocate("2026"),
        ];
        return [
          numbersResult,
          yield* counterOf(seriesId, "2026"),
          yield* counterOf(seriesId, "2027"),
        ];
      }),
    );
    expect(Arr.map(numbers, (number) => number.number)).toEqual([
      "FV20260001",
      "FV20260002",
      "FV20270001",
      "FV20260003",
    ]);
    expect(numbers[0]).toMatchObject({ counter: 1, kind: "invoice" });
    expect(nextIn2026).toBe(4);
    expect(nextIn2027).toBe(2);
  });

  test("passes the series pattern to the formatter", async () => {
    const seen = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const seenResult: Array<NumberCandidate> = [];
        yield* allocateNumber({
          workspaceId,
          seriesId,
          period: () => "all",
          format: (candidate) => {
            seenResult.push(candidate);
            return format(candidate);
          },
        });
        return seenResult;
      }),
    );
    expect(seen).toEqual([
      { kind: "invoice", pattern: "FV{YYYY}{NNNN}", period: "all", counter: 1 },
    ]);
  });

  test("derives the period from the series it read", async () => {
    const allocated = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* allocateNumber({
          workspaceId,
          seriesId,
          period: ({ pattern }) => (Str.includes("{MM}")(pattern) ? "2026-03" : "2026"),
          format,
        });
      }),
    );
    expect(allocated).toMatchObject({ period: "2026", number: "FV20260001" });
  });

  test("the default skip budget gets past a long run of reserved numbers", async () => {
    const allocated = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* sql`insert into number_reservations (workspace_id, kind, number)
          select ${workspaceId}, 'invoice', 'C' || n from generate_series(1, 1001) as n`;
        return yield* allocateNumber({
          workspaceId,
          seriesId,
          period: () => "all",
          format: ({ counter }) => `C${counter}`,
        });
      }),
    );
    expect(allocated).toMatchObject({ number: "C1002", counter: 1002 });
  });

  test("skips numbers reserved by an override and keeps the reservation", async () => {
    const [allocated, reserved, next] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* reserveNumber({ workspaceId, kind: "invoice", number: "FV20260001" });
        yield* reserveNumber({ workspaceId, kind: "invoice", number: "FV20260002" });
        const allocation = yield* allocateNumber({
          workspaceId,
          seriesId,
          period: () => "2026",
          format,
        });
        return [allocation, yield* reservationsOf(workspaceId), yield* counterOf(seriesId, "2026")];
      }),
    );
    expect(allocated).toMatchObject({ number: "FV20260003", counter: 3 });
    expect(reserved).toEqual(["FV20260001", "FV20260002", "FV20260003"]);
    expect(next).toBe(4);
  });

  test("a rolled back issue leaves no gap and no reservation", async () => {
    const [rolledBack, reserved, retried] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const rollbackOutcome = yield* allocateNumber({
          workspaceId,
          seriesId,
          period: () => "2026",
          format,
        }).pipe(Effect.andThen(Effect.fail("issue failed" as const)), transaction, failure);
        const reservations = yield* reservationsOf(workspaceId);
        const retryOutcome = yield* transaction(
          allocateNumber({ workspaceId, seriesId, period: () => "2026", format }),
        );
        return [rollbackOutcome, reservations, retryOutcome] as const;
      }),
    );
    expect(rolledBack).toBe("issue failed");
    expect(reserved).toEqual([]);
    expect(retried.number).toBe("FV20260001");
  });

  test("another Workspace's series is RowNotFound", async () => {
    const error = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        return yield* failure(
          allocateNumber({
            workspaceId: b.workspaceId,
            seriesId: a.seriesId,
            period: () => "2026",
            format,
          }),
        );
      }),
    );
    expect(error).toMatchObject({ _tag: "RowNotFound", table: "numbering_series" });
  });

  test("a formatter that never yields a free number is NumberingExhausted, leaving no counter", async () => {
    const [error, counter] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* reserveNumber({ workspaceId, kind: "invoice", number: "CONST" });
        const conflict = yield* failure(
          allocateNumber({
            workspaceId,
            seriesId,
            period: () => "2026",
            format: () => "CONST",
            maxSkips: 5,
          }),
        );
        return [conflict, yield* counterOf(seriesId, "2026")] as const;
      }),
    );
    // biome-ignore lint/security/noSecrets: Public SQL error tag.
    expect(error).toMatchObject({ _tag: "NumberingExhausted", firstCounter: 1, attempts: 6 });
    expect(counter).toBeUndefined();
  });
});

describe("reserveNumber", () => {
  test("is unique per Workspace and kind, not across them", async () => {
    const [taken, otherKind, otherWorkspace] = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        const number = "FV20269999";
        yield* reserveNumber({ workspaceId: a.workspaceId, kind: "invoice", number });
        const takenReservation = yield* failure(
          reserveNumber({ workspaceId: a.workspaceId, kind: "invoice", number }),
        );
        const otherKindResult = yield* failure(
          reserveNumber({ workspaceId: a.workspaceId, kind: "proforma", number }),
        );
        const otherWorkspaceResult = yield* failure(
          reserveNumber({ workspaceId: b.workspaceId, kind: "invoice", number }),
        );
        return [takenReservation, otherKindResult, otherWorkspaceResult] as const;
      }),
    );
    expect(taken).toMatchObject({ _tag: "NumberTaken", kind: "invoice", number: "FV20269999" });
    expect(otherKind).toBe("succeeded");
    expect(otherWorkspace).toBe("succeeded");
  });

  test("an allocated number cannot be reserved again", async () => {
    const error = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const { number } = yield* allocateNumber({
          workspaceId,
          seriesId,
          period: () => "2026",
          format,
        });
        return yield* failure(reserveNumber({ workspaceId, kind: "invoice", number }));
      }),
    );
    expect(error).toMatchObject({ _tag: "NumberTaken" });
  });
});

describe("counters and reservations", () => {
  test("lockCounter upserts at 1, setCounter grows it, peekCounter reads without creating", async () => {
    const [unused, locked, grown, same, created] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const key = { workspaceId, seriesId, period: "2026-05" };
        const unusedResult = yield* peekCounter(key);
        const createdResult = yield* counterOf(seriesId, "2026-05");
        const lockedResult = yield* transaction(lockCounter(key));
        yield* setCounter(key, 7);
        const grownResult = yield* peekCounter(key);
        yield* setCounter(key, 7);
        const sameResult = yield* peekCounter(key);
        return [unusedResult, lockedResult, grownResult, sameResult, createdResult] as const;
      }),
    );
    expect([unused, locked, grown, same]).toEqual([1, 1, 7, 7]);
    expect(created).toBeUndefined();
  });

  test("setCounter refuses to lower a counter or set a missing one", async () => {
    const lower = db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const key = { workspaceId, seriesId, period: "2026" };
        yield* transaction(lockCounter(key).pipe(Effect.andThen(setCounter(key, 7))));
        yield* setCounter(key, 3);
      }),
    );
    await expect(lower).rejects.toThrow("is missing or above 3");
    const missing = db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* setCounter({ workspaceId, seriesId, period: "2030" }, 2);
      }),
    );
    await expect(missing).rejects.toThrow("is missing or above 2");
  });

  test("lockCounter on another Workspace's series is RowNotFound, with or without its counter", async () => {
    const [before, after] = await db.run(
      Effect.gen(function* () {
        const a = yield* seedWorkspace;
        const b = yield* seedWorkspace;
        const foreign = { workspaceId: b.workspaceId, seriesId: a.seriesId, period: "2026" };
        const beforeResult = yield* failure(lockCounter(foreign));
        yield* lockCounter({ ...foreign, workspaceId: a.workspaceId });
        const storedRow = yield* failure(lockCounter(foreign));
        return [beforeResult, storedRow] as const;
      }),
    );
    expect(before).toMatchObject({ _tag: "RowNotFound", table: "numbering_series" });
    expect(after).toMatchObject({ _tag: "RowNotFound", table: "numbering_series" });
  });

  test("tryReserveNumber reports a taken number without aborting the transaction", async () => {
    const [first, second, afterwards] = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const reservation = { workspaceId, kind: "invoice" as const, number: "X-1" };
        return yield* transaction(
          Effect.gen(function* () {
            const firstWriter = yield* tryReserveNumber(reservation);
            const secondWriter = yield* tryReserveNumber(reservation);
            const afterwardsResult = yield* tryReserveNumber({ ...reservation, number: "X-2" });
            return [firstWriter, secondWriter, afterwardsResult] as const;
          }),
        );
      }),
    );
    expect([first, second, afterwards]).toEqual([true, false, true]);
  });
});

describe("request log", () => {
  const key = "key-1";
  const done = { requestKey: key, method: "Documents.issue", payloadHash: "h1" };
  const now = "2026-11-23T10:00:00.000Z";

  test("claims an unused key; after completion a second claim sees the entry", async () => {
    const [claimed, entry, again] = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        const claim = yield* transaction(
          claimRequest(scope, key, { now }).pipe(
            Effect.tap(() => completeRequest(scope, { ...done, result: { id: "doc-1" } })),
          ),
        );
        const storedEntry = yield* lookupRequest(scope, key);
        const replay = yield* transaction(claimRequest(scope, key, { now }));
        return [claim, storedEntry, replay] as const;
      }),
    );
    expect(claimed).toEqual({ _tag: "Claimed" });
    expect(entry.pipe(Option.getOrThrow)).toMatchObject({ ...done, result: { id: "doc-1" } });
    expect(Option.getOrThrow(entry).createdAt).toStartWith("2026-11-23T10:00:00");
    expect(again).toMatchObject({
      _tag: "Existing",
      entry: { method: "Documents.issue", payloadHash: "h1", result: { id: "doc-1" } },
    });
  });

  test("a rolled back claim leaves the key free", async () => {
    const [after, reclaimed] = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        yield* claimRequest(scope, key, { now }).pipe(
          Effect.tap(() => completeRequest(scope, { ...done, result: "x" })),
          Effect.andThen(Effect.fail("work failed" as const)),
          transaction,
          failure,
        );
        const storedRow = yield* lookupRequest(scope, key);
        const newClaim = yield* transaction(claimRequest(scope, key, { now }));
        return [storedRow, newClaim] as const;
      }),
    );
    expect(Option.isNone(after)).toBe(true);
    expect(reclaimed._tag).toBe("Claimed");
  });

  test("an expired entry or a committed placeholder is taken over", async () => {
    const [expired, pending, lookup] = await db.run(
      Effect.gen(function* () {
        const ws1 = yield* seedWorkspace;
        const ws2 = yield* seedWorkspace;
        const old = { workspaceId: ws1.workspaceId };
        yield* transaction(
          claimRequest(old, key, { now: "2026-11-22T09:00:00Z" }).pipe(
            Effect.tap(() => completeRequest(old, { ...done, result: 1 })),
          ),
        );
        const expiredResult = yield* transaction(claimRequest(old, key, { now }));
        const abandoned = { workspaceId: ws2.workspaceId };
        yield* transaction(claimRequest(abandoned, key, { now }));
        const lookupResult = yield* lookupRequest(abandoned, key);
        const pendingResult = yield* transaction(claimRequest(abandoned, key, { now }));
        return [expiredResult, pendingResult, lookupResult] as const;
      }),
    );
    expect(expired._tag).toBe("Claimed");
    expect(pending._tag).toBe("Claimed");
    expect(Option.isNone(lookup)).toBe(true);
  });

  test("an entry inside the TTL is not taken over", async () => {
    const outcome = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        yield* transaction(
          claimRequest(scope, key, { now: "2026-11-22T11:00:00Z" }).pipe(
            Effect.tap(() => completeRequest(scope, { ...done, result: 1 })),
          ),
        );
        return yield* transaction(claimRequest(scope, key, { now }));
      }),
    );
    expect(outcome._tag).toBe("Existing");
  });

  test("keys are scoped per Workspace and per user", async () => {
    const outcomes = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ws1 = yield* seedWorkspace;
        const ws2 = yield* seedWorkspace;
        const userId = `user-${generateId()}`;
        yield* sql`insert into auth.user (id, name, email, email_verified)
          values (${userId}, 'U', ${`${userId}@example.test`}, true)`;
        const claimDone = (scope: { workspaceId: string } | { userId: string }) =>
          transaction(
            claimRequest(scope, key, { now }).pipe(
              Effect.tap(() => completeRequest(scope, { ...done, result: 1 })),
            ),
          );
        return [
          yield* claimDone({ workspaceId: ws1.workspaceId }),
          yield* claimDone({ workspaceId: ws2.workspaceId }),
          yield* claimDone({ userId }),
          yield* transaction(claimRequest({ userId }, key, { now })),
        ];
      }),
    );
    expect(Arr.map(outcomes, (outcome) => outcome._tag)).toEqual([
      "Claimed",
      "Claimed",
      "Claimed",
      "Existing",
    ]);
  });

  test("a claim belongs to its outermost transaction", async () => {
    const twice = db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        return yield* transaction(
          claimRequest({ workspaceId }, key, { now }).pipe(
            Effect.andThen(claimRequest({ workspaceId }, key, { now })),
          ),
        );
      }),
    );
    await expect(twice).rejects.toThrow("already claimed by this transaction");
    const nested = db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        return yield* claimRequest({ workspaceId }, key, { now }).pipe(transaction, transaction);
      }),
    );
    await expect(nested).rejects.toThrow("outermost transaction");
    const abandoned = db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        yield* transaction(claimRequest({ workspaceId }, key, { now }));
        return yield* transaction(completeRequest({ workspaceId }, { ...done, result: 1 }));
      }),
    );
    await expect(abandoned).rejects.toThrow("not claimed by this transaction");
  });

  test("taking over a Workspace row drops a stale user, so deleting that user keeps the entry", async () => {
    const replay = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { workspaceId } = yield* seedWorkspace;
        const userId = `user-${generateId()}`;
        yield* sql`insert into auth.user (id, name, email, email_verified)
          values (${userId}, 'U', ${`${userId}@example.test`}, true)`;
        yield* sql`insert into request_log
            (workspace_id, user_id, request_key, method, payload_hash, result, created_at)
          values (${workspaceId}, ${userId}, ${key}, 'Old.op', 'old', '1'::jsonb,
            '2026-11-20T00:00:00Z')`;
        const scope = { workspaceId };
        yield* transaction(
          claimRequest(scope, key, { now }).pipe(
            Effect.tap(() => completeRequest(scope, { ...done, result: { id: "new" } })),
          ),
        );
        yield* sql`delete from auth.user where id = ${userId}`;
        return yield* transaction(claimRequest(scope, key, { now: "2026-11-23T11:00:00Z" }));
      }),
    );
    expect(replay).toMatchObject({ _tag: "Existing", entry: { result: { id: "new" } } });
  });

  test("a Workspace claim stores no user", async () => {
    const users = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { workspaceId } = yield* seedWorkspace;
        yield* transaction(
          claimRequest({ workspaceId }, key, { now }).pipe(
            Effect.tap(() => completeRequest({ workspaceId }, { ...done, result: 1 })),
          ),
        );
        return yield* sql<{ user_id: string | null }>`
          select user_id from request_log where workspace_id = ${workspaceId}`;
      }),
    );
    expect(users).toEqual([{ user_id: null }]);
  });

  test("claim and complete outside a transaction, or completing an unclaimed key, are defects", async () => {
    const scope = { workspaceId: generateId() };
    await expect(db.run(claimRequest(scope, key, { now }))).rejects.toThrow(
      "must run inside a transaction",
    );
    await expect(
      db.run(transaction(completeRequest(scope, { ...done, result: 1 }))),
    ).rejects.toThrow("is not claimed");
    const undefinedResult = db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        return yield* transaction(
          claimRequest({ workspaceId }, key, { now }).pipe(
            Effect.andThen(completeRequest({ workspaceId }, { ...done, result: undefined })),
          ),
        );
      }),
    );
    await expect(undefinedResult).rejects.toThrow("defined result");
  });
});

/** Fails the current statement with SQLSTATE `code`, as Postgres does on a lock conflict. */
const raise = (code: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`do $$ begin raise exception 'simulated' using errcode = '${code}'; end $$`);
  });

describe("transactionWithRetry", () => {
  test("commits a successful transaction", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* transactionWithRetry(
          lockRowForUpdate("numbering_series", workspaceId, seriesId).pipe(
            Effect.andThen((lockedRow) =>
              updateWithRevision(
                "numbering_series",
                workspaceId,
                seriesId,
                Number(lockedRow["revision"]),
                {
                  name: "Locked then updated",
                },
              ),
            ),
          ),
        );
      }),
    );
    expect(row).toMatchObject({ name: "Locked then updated", revision: 2 });
  });

  test("reruns the transaction after a deadlock or serialization failure", async () => {
    for (const code of ["40P01", "40001"]) {
      let attempts = 0;
      // biome-ignore lint/performance/noAwaitInLoops: The cases share one SQL connection.
      const result = await db.run(
        transactionWithRetry(
          Effect.suspend(() => {
            attempts += 1;
            return attempts < 3 ? raise(code).pipe(Effect.as("raised")) : Effect.succeed("done");
          }),
        ),
      );
      expect(result).toBe("done");
      expect(attempts).toBe(3);
    }
  });

  test("gives up after the retry budget with the SqlError", async () => {
    let attempts = 0;
    const error = await db.run(
      failure(
        transactionWithRetry(
          Effect.suspend(() => {
            attempts += 1;
            return raise("40001");
          }),
          { retries: 2 },
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "SqlError", reason: { _tag: "SerializationError" } });
    expect(attempts).toBe(3);
  });

  test("does not retry domain failures or other SQL errors", async () => {
    let attempts = 0;
    const errors = await db.run(
      Effect.all(
        [
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("nope" as const);
          }).pipe(transactionWithRetry, failure),
          Effect.suspend(() => {
            attempts += 1;
            return raise("23505");
          }).pipe(transactionWithRetry, failure),
        ],
        { concurrency: 1 },
      ),
    );
    expect(errors[0]).toBe("nope");
    expect(errors[1]).toMatchObject({ _tag: "SqlError" });
    expect(attempts).toBe(2);
  });

  test("runs READ COMMITTED even when the session default is stricter", async () => {
    const level = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`set default_transaction_isolation = 'repeatable read'`;
        const rows = yield* transactionWithRetry(
          sql<{ transaction_isolation: string }>`show transaction_isolation`,
        ).pipe(Effect.ensuring(sql`reset default_transaction_isolation`.pipe(Effect.orDie)));
        return rows[0]?.transaction_isolation;
      }),
    );
    expect(level).toBe("read committed");
  });

  test("inside another transaction it is a defect", async () => {
    await expect(db.run(Effect.void.pipe(transactionWithRetry, transaction))).rejects.toThrow(
      "outermost transaction",
    );
  });
});
