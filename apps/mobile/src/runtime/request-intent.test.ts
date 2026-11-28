import { expect, test } from "bun:test";
import { RequestKey } from "@kvitbit/domain/contract";
import { ok } from "@kvitbit/ui-port/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import {
  acquireRequestKey,
  completeRequestKey,
  requestKeyReplayWindowOpen,
  runRequestIntent,
} from "./request-intent";
import { makeRequestIntentStore, RequestIntentExpired } from "./request-intent-store";

const digest = (text: string) =>
  Effect.sync(() => new Bun.CryptoHasher("sha256").update(text).digest("hex"));

const makeStorage = () => {
  const persisted = new Map<string, string>();
  return {
    persisted,
    getItem: (key: string) => Effect.sync(() => persisted.get(key) ?? null),
    setItem: (key: string, value: string) =>
      Effect.sync(() => {
        persisted.set(key, value);
      }),
    removeItem: (key: string) =>
      Effect.sync(() => {
        persisted.delete(key);
      }),
  };
};

test("a committed write whose response was lost reuses its key after restart", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = makeStorage();
      let minted = 0;
      const start = () =>
        makeRequestIntentStore<never, never>({
          storage,
          digest,
          mint: Effect.sync(() => RequestKey.make(`test-key-${++minted}`)),
          withWebLock: () => undefined,
        });
      const first = start();
      const owner = "origin-user-workspace";
      const operation = "recordPayment/invoice-1";
      const key = yield* first.acquireRequestKey(owner, operation, {
        amount: "321",
        currency: "CZK",
      });
      const committed = new Set([key]);
      const retry = start();
      const keys = yield* Effect.all(
        [
          retry.acquireRequestKey(owner, operation, { currency: "CZK", amount: "321" }),
          retry.acquireRequestKey(owner, operation, { amount: "321", currency: "CZK" }),
        ],
        { concurrency: "unbounded" },
      );
      for (const retryKey of keys) committed.add(retryKey);
      expect(committed.size).toBe(1);
      const otherAccountKey = yield* retry.acquireRequestKey("other-account", operation, {
        amount: "321",
        currency: "CZK",
      });
      expect(otherAccountKey).not.toBe(key);
      const edited = yield* retry.acquireRequestKey(owner, operation, {
        amount: "400",
        currency: "CZK",
      });
      expect(edited).not.toBe(key);
      const repeatedKey = yield* retry.acquireRequestKey(owner, operation, {
        amount: "321",
        currency: "CZK",
      });
      expect(repeatedKey).toBe(key);
      yield* retry.completeRequestKey(owner, operation, key);
      const keptEditedKey = yield* retry.acquireRequestKey(owner, operation, {
        amount: "400",
        currency: "CZK",
      });
      expect(keptEditedKey).toBe(edited);
      yield* retry.completeRequestKey(owner, operation, edited);
      const newEditedKey = yield* retry.acquireRequestKey(owner, operation, {
        amount: "400",
        currency: "CZK",
      });
      expect(newEditedKey).not.toBe(edited);
    }),
  ));

test("a restarted worker refuses an unresolved key when its server claim may have expired", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = makeStorage();
      const firstAttempt = 1795651200000;
      const retention = 24 * 60 * 60 * 1000;
      let now = firstAttempt;
      let minted = 0;
      const start = () =>
        makeRequestIntentStore<never, never>({
          storage,
          digest,
          mint: Effect.sync(() => RequestKey.make(`test-key-${++minted}`)),
          now: Effect.sync(() => now),
          withWebLock: () => undefined,
        });
      const owner = "user-1";
      const operation = "documents.issue";
      const payload = { draft: "first" };
      const key = yield* start().acquireRequestKey(owner, operation, payload);
      const retry = start();

      now = firstAttempt + retention - 1;
      const reused = yield* retry.reuseRequestKey(owner, operation, payload, key);
      expect(reused).toBe(key);
      const acquired = yield* retry.acquireRequestKey(owner, operation, payload);
      expect(acquired).toBe(key);

      now += 1;
      for (const acquire of [
        () => retry.acquireRequestKey(owner, operation, payload),
        () => retry.reuseRequestKey(owner, operation, payload, key),
      ]) {
        const error = yield* Effect.flip(acquire());
        expect(error).toBeInstanceOf(RequestIntentExpired);
      }
      expect(minted).toBe(1);
      const another = yield* retry.acquireRequestKey(owner, operation, { draft: "another" });
      expect(another).not.toBe(key);
    }),
  ));

test("a failed success checkpoint preserves the key for recovery", async () => {
  const keys: RequestKey[] = [];
  const operation = "templates.use";
  const payload = { template: "test" };
  const call = (key: RequestKey) => {
    keys.push(key);
    return Promise.resolve(ok({ value: "saved" }));
  };
  const first = await runRequestIntent("checkpoint-user", operation, payload, call, () =>
    Promise.reject(new Error("Interrupted while storing the acknowledgement")),
  );
  expect(first._tag).toBe("Err");
  expect(await runRequestIntent("checkpoint-user", operation, payload, call)).toEqual(
    ok({ value: "saved" }),
  );
  expect(keys[0]).toBe(keys[1]);
});

test("reuses a legacy UUID-only intent with the original payload fingerprint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = makeStorage();
      const oldKey = RequestKey.make("00000000-0001-7000-8000-000000000001");
      const slot = yield* digest('["legacy-owner","documents.issue"]');
      const fingerprint = yield* digest('{"amount":"321","currency":"CZK"}');
      yield* storage.setItem(`kvitbit.request-intent.v1.${slot}`, `{"${fingerprint}":"${oldKey}"}`);

      const store = makeRequestIntentStore<never, never>({
        storage,
        digest,
        mint: Effect.die("The legacy intent should already have a key"),
        now: Effect.succeed(2),
        withWebLock: () => undefined,
      });
      const reused = yield* store.acquireRequestKey("legacy-owner", "documents.issue", {
        currency: "CZK",
        amount: "321",
      });
      expect(reused).toBe(oldKey);
    }),
  ));

test("checks the replay window against the current time when called with one timestamp", () => {
  expect(requestKeyReplayWindowOpen(0)).toBe(false);
});

test("holds the slot until its pending native storage write finishes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = makeStorage();
      const writeStarted = yield* Deferred.make<void>();
      const finishWrite = yield* Deferred.make<void>();
      let minted = 0;
      const store = makeRequestIntentStore<never, never>({
        storage: {
          ...storage,
          setItem: (slot, value) =>
            Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishWrite)),
              Effect.andThen(storage.setItem(slot, value)),
            ),
        },
        digest,
        mint: Effect.sync(() => RequestKey.make(`slow-write-key-${++minted}`)),
        withWebLock: () => undefined,
      });
      const acquire = store.acquireRequestKey("owner", "documents.issue", { amount: "321" });
      const first = yield* Effect.forkScoped(acquire);
      yield* Deferred.await(writeStarted);
      const second = yield* Effect.forkScoped(acquire);
      yield* Effect.yieldNow;
      expect(minted).toBe(1);

      yield* Deferred.succeed(finishWrite, undefined);
      const firstKey = yield* Fiber.join(first);
      const secondKey = yield* Fiber.join(second);
      expect(secondKey).toBe(firstKey);
    }).pipe(Effect.scoped),
  ));

test("concurrent page requests use one shared Web Locks slot and key", async () => {
  const testNavigator = globalThis.navigator;
  const previous = Object.getOwnPropertyDescriptor(testNavigator, "locks");
  const slots: string[] = [];
  const exclusive = Semaphore.makeUnsafe(1);
  Object.defineProperty(testNavigator, "locks", {
    configurable: true,
    value: {
      request: <A>(slot: string, _options: LockOptions, work: () => Promise<A>) => {
        slots.push(slot);
        return Effect.promise(work).pipe(exclusive.withPermits(1), Effect.runPromise);
      },
    },
  });
  try {
    const owner = "web-lock-fixture";
    const operation = "documents.issue";
    const [first, second] = await Promise.all([
      acquireRequestKey(owner, operation, { amount: "321" }),
      acquireRequestKey(owner, operation, { amount: "321" }),
    ]);
    expect(first).toBe(second);
    expect(slots).toHaveLength(2);
    expect(new Set(slots).size).toBe(1);
    expect(slots[0]).toStartWith("kvitbit.request-intent.v1.");
    await completeRequestKey(owner, operation, first);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(testNavigator, "locks");
    else Object.defineProperty(testNavigator, "locks", previous);
  }
});
