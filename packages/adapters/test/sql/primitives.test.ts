import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  allocateNumber,
  checkRevision,
  claimRequest,
  lockRowForUpdate,
  lookupRequest,
  type NumberCandidate,
  reserveNumber,
  transactionWithRetry,
  updateWithRevision,
} from "@kvitbit/adapters/sql";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { type MigratedPglite, migratedPglite, seedWorkspace } from "./pglite";

let db: MigratedPglite;

beforeAll(async () => {
  db = await migratedPglite();
}, 60_000);

afterAll(async () => {
  await db.close();
});

const format = ({ period, counter }: NumberCandidate) =>
  `FV${period}${String(counter).padStart(4, "0")}`;

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
    return rows.map((r) => r.number);
  });

describe("lockRowForUpdate", () => {
  test("returns the row in its own Workspace inside a transaction", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* transaction(lockRowForUpdate("numbering_series", workspaceId, seriesId));
      }),
    );
    expect(row.name).toBe("Invoices");
    expect(row.revision).toBe(1);
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
        const own = yield* lockRowForUpdate("workspaces", a.workspaceId, a.workspaceId);
        const other = yield* failure(lockRowForUpdate("workspaces", b.workspaceId, a.workspaceId));
        return [own, other] as const;
      }),
    );
    expect(own.id).toBeDefined();
    expect(other).toMatchObject({ _tag: "RowNotFound" });
  });

  test("checkRevision compares the locked row's revision", async () => {
    const [ok, stale] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const row = yield* lockRowForUpdate("numbering_series", workspaceId, seriesId);
        const ok = yield* failure(checkRevision("numbering_series", row, 1));
        const stale = yield* failure(checkRevision("numbering_series", row, 2));
        return [ok, stale] as const;
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
      lockRowForUpdate("users; drop table workspaces" as "documents", crypto.randomUUID(), "x"),
    );
    await expect(run).rejects.toThrow("not a revisioned table");
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
    expect(row.name).toBe("Renamed");
    expect(row.revision).toBe(2);
  });

  test("an empty patch still bumps revision", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        return yield* updateWithRevision("workspaces", workspaceId, workspaceId, 1, {});
      }),
    );
    expect(row.revision).toBe(2);
  });

  test("a stale revision is RevisionConflict with the current revision, and changes nothing", async () => {
    const [error, after] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "B" });
        const error = yield* failure(
          updateWithRevision("numbering_series", workspaceId, seriesId, 1, { name: "C" }),
        );
        const after = yield* lockRowForUpdate("numbering_series", workspaceId, seriesId);
        return [error, after] as const;
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
        const error = yield* failure(
          updateWithRevision("numbering_series", b.workspaceId, a.seriesId, 1, { name: "X" }),
        );
        const after = yield* lockRowForUpdate("numbering_series", a.workspaceId, a.seriesId);
        return [error, after] as const;
      }),
    );
    expect(error).toMatchObject({ _tag: "RowNotFound" });
    expect(after).toMatchObject({ name: "Invoices", revision: 1 });
  });

  test("protected or malformed patch columns are a defect", async () => {
    for (const patch of [{ revision: 9 }, { workspace_id: "x" }, { 'name" = 1; --': "x" }]) {
      const run = db.run(
        Effect.gen(function* () {
          const { workspaceId, seriesId } = yield* seedWorkspace;
          return yield* updateWithRevision("numbering_series", workspaceId, seriesId, 1, patch);
        }),
      );
      await expect(run).rejects.toThrow("is not allowed");
    }
  });
});

describe("allocateNumber", () => {
  test("allocates a gapless sequence per series and period", async () => {
    const [numbers, nextIn2026, nextIn2027] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const allocate = (period: string) =>
          transaction(allocateNumber({ workspaceId, seriesId, period, format }));
        const numbers = [
          yield* allocate("2026"),
          yield* allocate("2026"),
          yield* allocate("2027"),
          yield* allocate("2026"),
        ];
        return [numbers, yield* counterOf(seriesId, "2026"), yield* counterOf(seriesId, "2027")];
      }),
    );
    expect(numbers.map((n) => n.number)).toEqual([
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
        const seen: Array<NumberCandidate> = [];
        yield* allocateNumber({
          workspaceId,
          seriesId,
          period: "all",
          format: (candidate) => {
            seen.push(candidate);
            return format(candidate);
          },
        });
        return seen;
      }),
    );
    expect(seen).toEqual([{ pattern: "FV{YYYY}{NNNN}", period: "all", counter: 1 }]);
  });

  test("skips numbers reserved by an override and keeps the reservation", async () => {
    const [allocated, reserved, next] = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        yield* reserveNumber({ workspaceId, kind: "invoice", number: "FV20260001" });
        yield* reserveNumber({ workspaceId, kind: "invoice", number: "FV20260002" });
        const allocated = yield* allocateNumber({ workspaceId, seriesId, period: "2026", format });
        return [allocated, yield* reservationsOf(workspaceId), yield* counterOf(seriesId, "2026")];
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
        const rolledBack = yield* failure(
          transaction(
            allocateNumber({ workspaceId, seriesId, period: "2026", format }).pipe(
              Effect.andThen(Effect.fail("issue failed" as const)),
            ),
          ),
        );
        const reserved = yield* reservationsOf(workspaceId);
        const retried = yield* transaction(
          allocateNumber({ workspaceId, seriesId, period: "2026", format }),
        );
        return [rolledBack, reserved, retried] as const;
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
            period: "2026",
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
        const error = yield* failure(
          allocateNumber({
            workspaceId,
            seriesId,
            period: "2026",
            format: () => "CONST",
            maxSkips: 5,
          }),
        );
        return [error, yield* counterOf(seriesId, "2026")] as const;
      }),
    );
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
        const taken = yield* failure(
          reserveNumber({ workspaceId: a.workspaceId, kind: "invoice", number }),
        );
        const otherKind = yield* failure(
          reserveNumber({ workspaceId: a.workspaceId, kind: "proforma", number }),
        );
        const otherWorkspace = yield* failure(
          reserveNumber({ workspaceId: b.workspaceId, kind: "invoice", number }),
        );
        return [taken, otherKind, otherWorkspace] as const;
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
        const { number } = yield* allocateNumber({ workspaceId, seriesId, period: "2026", format });
        return yield* failure(reserveNumber({ workspaceId, kind: "invoice", number }));
      }),
    );
    expect(error).toMatchObject({ _tag: "NumberTaken" });
  });
});

describe("request log", () => {
  const request = { requestKey: "key-1", method: "Documents.issue", payloadHash: "h1" };

  test("claims an unused key, then replays its result", async () => {
    const [before, claimed, after, again] = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        const before = yield* lookupRequest(scope, request);
        const claimed = yield* claimRequest(scope, { ...request, result: { id: "doc-1" } });
        const after = yield* lookupRequest(scope, request);
        const again = yield* claimRequest(scope, { ...request, result: { id: "doc-2" } });
        return [before, claimed, after, again] as const;
      }),
    );
    expect(Option.isNone(before)).toBe(true);
    expect(claimed).toEqual({ _tag: "Claimed" });
    expect(after).toEqual(Option.some({ id: "doc-1" }));
    expect(again).toEqual({ _tag: "Replayed", result: { id: "doc-1" } });
  });

  test("the same key with another payload or method is RequestKeyReused", async () => {
    const [payload, method, claim] = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        const scope = { workspaceId };
        yield* claimRequest(scope, { ...request, result: null });
        const payload = yield* failure(lookupRequest(scope, { ...request, payloadHash: "h2" }));
        const method = yield* failure(
          lookupRequest(scope, { ...request, method: "Payments.record" }),
        );
        const claim = yield* failure(
          claimRequest(scope, { ...request, payloadHash: "h2", result: null }),
        );
        return [payload, method, claim] as const;
      }),
    );
    expect(payload).toMatchObject({ _tag: "RequestKeyReused", payloadHashMatches: false });
    expect(method).toMatchObject({
      _tag: "RequestKeyReused",
      storedMethod: "Documents.issue",
      payloadHashMatches: true,
    });
    expect(claim).toMatchObject({ _tag: "RequestKeyReused" });
  });

  test("keys are scoped per Workspace and per user", async () => {
    const [a, b, user, sameUser] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ws1 = yield* seedWorkspace;
        const ws2 = yield* seedWorkspace;
        const userId = `user-${crypto.randomUUID()}`;
        yield* sql`insert into auth.user (id, name, email, email_verified)
          values (${userId}, 'U', ${`${userId}@example.test`}, true)`;
        const a = yield* claimRequest({ workspaceId: ws1.workspaceId }, { ...request, result: 1 });
        const b = yield* claimRequest({ workspaceId: ws2.workspaceId }, { ...request, result: 2 });
        const user = yield* claimRequest({ userId }, { ...request, result: 3 });
        const sameUser = yield* lookupRequest({ userId }, request);
        return [a, b, user, sameUser] as const;
      }),
    );
    expect(a._tag).toBe("Claimed");
    expect(b._tag).toBe("Claimed");
    expect(user._tag).toBe("Claimed");
    expect(sameUser).toEqual(Option.some(3));
  });

  test("a claim rolls back with the work it records", async () => {
    const after = await db.run(
      Effect.gen(function* () {
        const { workspaceId } = yield* seedWorkspace;
        yield* failure(
          transaction(
            claimRequest({ workspaceId }, { ...request, result: "x" }).pipe(
              Effect.andThen(Effect.fail("work failed" as const)),
            ),
          ),
        );
        return yield* lookupRequest({ workspaceId }, request);
      }),
    );
    expect(Option.isNone(after)).toBe(true);
  });
});

describe("transactionWithRetry", () => {
  test("commits a successful transaction", async () => {
    const row = await db.run(
      Effect.gen(function* () {
        const { workspaceId, seriesId } = yield* seedWorkspace;
        return yield* transactionWithRetry(
          lockRowForUpdate("numbering_series", workspaceId, seriesId).pipe(
            Effect.andThen((row) =>
              updateWithRevision("numbering_series", workspaceId, seriesId, Number(row.revision), {
                name: "Locked then updated",
              }),
            ),
          ),
        );
      }),
    );
    expect(row).toMatchObject({ name: "Locked then updated", revision: 2 });
  });

  test("does not retry domain failures", async () => {
    let attempts = 0;
    const error = await db.run(
      failure(
        transactionWithRetry(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("nope" as const);
          }),
        ),
      ),
    );
    expect(error).toBe("nope");
    expect(attempts).toBe(1);
  });
});
