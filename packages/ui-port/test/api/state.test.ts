import { describe, expect, test } from "bun:test";
import { RateLimited } from "@kvitbit/api-contract";
import { Invalid, type Page } from "@kvitbit/domain/contract";
import { Effect, Fiber, Option, Random } from "effect";
import { TestClock } from "effect/testing";
import {
  type ApiResult,
  Connectivity,
  cleanFilters,
  ensureRequestKey,
  err,
  filterHash,
  keyAfter,
  ok,
  optimisticList,
  Paged,
  pageQuery,
  Remote,
  RetryState,
  retryDelayMillis,
  retryTransient,
  UiError,
  uuidV7,
} from "../../src/api";

describe("query builders", () => {
  test("pageQuery cleans filters, adds limit 50 and the cursor", () => {
    expect(pageQuery({ text: " ", role: "customer", status: undefined })).toEqual({
      role: "customer",
      limit: 50,
    } as never);
    expect(pageQuery({ text: "a" }, "c", 500)).toEqual({ text: "a", cursor: "c", limit: 100 });
  });
  test("filterHash ignores key order and empty values", () => {
    expect(filterHash({ a: 1, b: "x", c: "" })).toBe(filterHash({ b: "x", a: 1 }));
    expect(filterHash({ a: 1 })).not.toBe(filterHash({ a: 2 }));
    expect(cleanFilters({ a: null, b: 0 })).toEqual({ b: 0 } as never);
  });
});

describe("Remote", () => {
  test("load keeps stale data; failure keeps it too", () => {
    const loaded = Remote.load(Remote.ready(1));
    expect(loaded).toEqual({ _tag: "Ready", value: 1, refreshing: true });
    const failed = Remote.fromResult(
      Remote.load(Remote.fail(Remote.ready(1), UiError.offline)),
      err(UiError.timeout),
    );
    expect(Remote.value(failed)).toEqual(Option.some(1));
    expect(Remote.fromResult(Remote.idle, ok(2))).toEqual(Remote.ready(2));
  });
});

type Q = { readonly text?: string };
const page = (items: Array<number>, nextCursor: string | null): ApiResult<Page<number>> =>
  ok({ items, nextCursor });

describe("Paged", () => {
  test("first page, load more appends, older seq ignored", () => {
    const start = Paged.init<number, Q>({ text: "a" });
    expect(start.fetch).toEqual({ seq: 1, query: { text: "a", limit: 50 } });
    const first = Paged.receive(start.paged, 1, page([1, 2], "c2")).paged;
    const more = Paged.loadMore(first);
    expect(more.fetch).toEqual({ seq: 2, query: { text: "a", cursor: "c2", limit: 50 } });
    expect(Paged.receive(more.paged, 1, page([9], null)).paged).toBe(more.paged); // stale
    const second = Paged.receive(more.paged, 2, page([3], null)).paged;
    expect(second.items).toEqual([1, 2, 3]);
    expect(Paged.loadMore(second).fetch).toBeNull();
  });

  test("filter change drops cursor and bumps seq; same filters is a no-op", () => {
    const ready = Paged.receive(Paged.init<number, Q>({}).paged, 1, page([1], "c2")).paged;
    expect(Paged.setQuery(ready, {}).fetch).toBeNull();
    const changed = Paged.setQuery(ready, { text: "b" });
    expect(changed.paged).toMatchObject({ items: [], nextCursor: null, status: "loading", seq: 2 });
    expect(changed.fetch?.query).toEqual({ text: "b", limit: 50 });
  });

  test("cursor mismatch reloads silently; other errors fail", () => {
    const ready = Paged.receive(Paged.init<number, Q>({}).paged, 1, page([1], "c2")).paged;
    const more = Paged.loadMore(ready).paged;
    const mismatch = new Invalid({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] });
    const reloaded = Paged.receive(more, more.seq, err(mismatch));
    expect(reloaded.paged).toMatchObject({ status: "loading", error: Option.none(), seq: 3 });
    expect(reloaded.fetch?.query).toEqual({ limit: 50 });
    const cancelled = Paged.receive(more, more.seq, err(UiError.cancelled));
    expect(cancelled.paged.status).toBe("ready");
    expect(Paged.loadMore(cancelled.paged).fetch).not.toBeNull();
    const failed = Paged.receive(more, more.seq, err(UiError.offline)).paged;
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual(Option.some(UiError.offline));
  });
});

describe("optimistic updates", () => {
  type Row = { readonly id: string; readonly locked: boolean };
  const ops = optimisticList<Row>((row) => row.id);
  const rows: ReadonlyArray<Row> = [
    { id: "a", locked: false },
    { id: "b", locked: false },
    { id: "c", locked: false },
  ];

  test("archive with rollback reinserts at the old index, keeping a later op", () => {
    const archived = ops.apply(ops.init(rows), "b", { _tag: "Remove", id: "b" });
    const locked = ops.apply(archived.state, "c", {
      _tag: "Replace",
      item: { id: "c", locked: true },
    });
    expect(locked.state.value.map((r) => r.id)).toEqual(["a", "c"]);
    expect(ops.isPending(locked.state, "b")).toBe(true);
    expect(locked.state.pending[0]?.before).toBe(rows);

    const rolledBack = ops.rollback(locked.state, archived.seq);
    expect(rolledBack.value).toEqual([rows[0], rows[1], { id: "c", locked: true }] as never);
    expect(ops.isPending(rolledBack, "b")).toBe(false);
  });

  test("same-row ops answered out of order keep the later op", () => {
    const lock = { _tag: "Replace", item: { id: "a", locked: true } } as const;
    const unlock = { _tag: "Replace", item: { id: "a", locked: false } } as const;
    const first = ops.apply(ops.init(rows), "a", lock);
    const second = ops.apply(first.state, "a", unlock);
    const confirmedSecond = ops.confirm(second.state, second.seq);
    expect(confirmedSecond.value[0]?.locked).toBe(false);
    expect(confirmedSecond.base).toBe(rows); // not folded until the first resolves
    const done = ops.confirm(confirmedSecond, first.seq);
    expect(done.pending).toEqual([]);
    expect(done.base[0]?.locked).toBe(false);
    expect(done.value).toEqual(done.base);
    const firstRejected = ops.rollback(confirmedSecond, first.seq);
    expect(firstRejected.pending).toEqual([]);
    expect(firstRejected.value[0]?.locked).toBe(false);
  });

  test("confirm folds the op into the base; unknown seq is ignored", () => {
    const applied = ops.apply(ops.init(rows), "a", { _tag: "Remove", id: "a" });
    const confirmed = ops.confirm(applied.state, applied.seq);
    expect(confirmed.base.map((r) => r.id)).toEqual(["b", "c"]);
    expect(confirmed.pending).toEqual([]);
    expect(ops.rollback(confirmed, applied.seq)).toBe(confirmed);
    expect(ops.confirm(confirmed, 99)).toBe(confirmed);
  });
});

describe("retry and connectivity", () => {
  test("backoff grows, caps, honours Retry-After, stops on non-retryable", () => {
    expect(retryDelayMillis(UiError.offline, 1)).toBe(1_000);
    expect(retryDelayMillis(UiError.offline, 3)).toBe(4_000);
    expect(retryDelayMillis(UiError.offline, 3, 0)).toBe(2_000);
    expect(retryDelayMillis(UiError.offline, 5)).toBe(16_000);
    expect(retryDelayMillis(UiError.offline, 6)).toBeNull();
    expect(retryDelayMillis(UiError.cancelled, 1)).toBeNull();
    expect(retryDelayMillis({ _tag: "RateLimited", retryAfterSeconds: 7 } as never, 1)).toBe(7_000);
  });

  test("RetryState disables the control until notBefore", () => {
    const state = RetryState.afterFailure(RetryState.idle, UiError.timeout, 10_000);
    expect(RetryState.canRetry(state, 10_500)).toBe(false);
    expect(RetryState.secondsLeft(state, 10_500)).toBe(1);
    expect(RetryState.canRetry(state, 11_000)).toBe(true);
    expect(RetryState.afterFailure(RetryState.idle, UiError.cancelled, 0).exhausted).toBe(true);
  });

  test("connectivity follows platform signals and observed responses", () => {
    const off = Connectivity.observe(
      Connectivity.online,
      { _tag: "Err", error: UiError.offline },
      5,
    );
    expect(off).toEqual({ _tag: "Offline", since: 5 });
    expect(Connectivity.observe(off, { _tag: "Err", error: UiError.timeout }, 9)).toBe(off);
    expect(Connectivity.observe(off, { _tag: "Err", error: UiError.unexpected(500) }, 9)).toEqual(
      Connectivity.online,
    );
    expect(Connectivity.fromPlatform(off, false, 9)).toBe(off);
    expect(Connectivity.fromPlatform(off, true, 9)).toEqual(Connectivity.online);
  });

  test("retryTransient retries retryable failures only", async () => {
    let calls = 0;
    const flaky = Effect.suspend(() => {
      calls++;
      return calls < 3 ? Effect.fail(UiError.offline) : Effect.succeed("ok");
    });
    const fast = { baseMillis: 1, factor: 1, maxMillis: 1, maxAttempts: 5 };
    expect(await Effect.runPromise(retryTransient(flaky, fast))).toBe("ok");
    expect(calls).toBe(3);
    calls = 0;
    const fatal = Effect.suspend(() => {
      calls++;
      return Effect.fail(UiError.cancelled);
    });
    await Effect.runPromise(Effect.exit(retryTransient(fatal, fast)));
    expect(calls).toBe(1);
  });

  test("retryTransient waits for Retry-After before retrying a 429", async () => {
    let calls = 0;
    const limited = Effect.suspend(() => {
      calls++;
      return calls === 1
        ? Effect.fail(new RateLimited({ retryAfterSeconds: 30 }))
        : Effect.succeed("ok");
    });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(retryTransient(limited));
      yield* TestClock.adjust("29 seconds");
      const early = calls;
      yield* TestClock.adjust("1 second");
      return [early, yield* Fiber.join(fiber)] as const;
    });
    const [early, result] = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    expect(early).toBe(1);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("request keys", () => {
  test("uuidV7 has version 7 and the RFC variant, and matches IdempotencyKey", async () => {
    const id = await Effect.runPromise(uuidV7.pipe(Random.withSeed("seed")));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("a key is reused until success, then cleared", async () => {
    const key = await Effect.runPromise(ensureRequestKey(Option.none()));
    const kept = keyAfter(Option.some(key), { _tag: "Err", error: UiError.offline });
    expect(await Effect.runPromise(ensureRequestKey(kept))).toBe(key);
    expect(keyAfter(kept, { _tag: "Ok" })).toEqual(Option.none());
  });
});
