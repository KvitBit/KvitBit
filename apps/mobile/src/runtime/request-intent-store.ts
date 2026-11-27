import { RequestKey } from "@kvitbit/domain/contract";
import { type ApiResult, describeError, type UiError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";

const intent = Schema.Struct({ key: RequestKey, firstAttemptAt: Schema.Finite });
const storedIntents = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Union([intent, RequestKey])),
);
const legacyKey = /^[\da-f]{8}-[\da-f]{4}-7/i;
const replayWindowMs = 24 * 60 * 60 * 1000;

export class RequestIntentExpired extends Schema.TaggedError<
  RequestIntentExpired,
  { readonly brand: unique symbol }
>()("RequestIntentExpired", {}) {}

export const requestKeyReplayWindowOpen: {
  (now: number): (firstAttemptAt: number) => boolean;
  (firstAttemptAt: number, now: number): boolean;
} = Fn.dual(
  2,
  (firstAttemptAt: number, now: number) =>
    Number.isFinite(firstAttemptAt) &&
    now >= firstAttemptAt &&
    now - firstAttemptAt < replayWindowMs,
);

const readRecord = (record: typeof intent.Type | RequestKey): typeof intent.Type => {
  if (!Predicate.isString(record)) return record;
  // Legacy builds persisted only the UUIDv7. Its timestamp bounds the replay window.
  const time = legacyKey.test(record)
    ? Number.parseInt(Str.replace("-", "")(Str.slice(0, 13)(record)), 16)
    : Number.NaN;
  return { key: record, firstAttemptAt: time };
};

const isPayloadRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const payloadJson = Schema.fromJsonString(Schema.Unknown, {
  // Match existing fingerprints even when a restored form inserts keys in a different order.
  replacer: (_key, value) => {
    if (!isPayloadRecord(value)) return value;
    return Record.fromEntries(Arr.sortWith(Record.toEntries(value), ([key]) => key, Order.String));
  },
});
const slotJson = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));

interface IntentStorage<E> {
  readonly getItem: (slot: string) => Effect.Effect<string | null, E>;
  readonly setItem: (slot: string, value: string) => Effect.Effect<void, E>;
  readonly removeItem: (slot: string) => Effect.Effect<void, E>;
}

const slotLocks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

const withLocalLock = <A, E>(slot: string, work: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = slotLocks.get(slot) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      lock.users += 1;
      slotLocks.set(slot, lock);
      return lock;
    }),
    (lock) => lock.semaphore.withPermits(1)(work),
    (lock) =>
      Effect.sync(() => {
        lock.users -= 1;
        if (lock.users === 0) slotLocks.delete(slot);
      }),
  );

export const makeRequestIntentStore = <E, L>(options: {
  readonly storage: IntentStorage<E>;
  readonly digest: (value: string) => Effect.Effect<string, E>;
  readonly mint: Effect.Effect<RequestKey, E>;
  readonly now?: Effect.Effect<number> | undefined;
  readonly withWebLock: <A, F>(
    slot: string,
    work: Effect.Effect<A, F>,
  ) => Effect.Effect<A, F | L> | undefined;
}) => {
  const { storage, digest, mint, now = Clock.currentTimeMillis, withWebLock } = options;
  const readKeys = Effect.fn("MobileRequestIntent.readKeys")(function* (slot: string) {
    const stored = yield* storage.getItem(slot);
    return stored === null ? {} : yield* Schema.decodeEffect(storedIntents)(stored);
  });
  const writeKeys = Effect.fn("MobileRequestIntent.writeKeys")(function* (
    slot: string,
    keys: typeof storedIntents.Type,
  ) {
    const encoded = yield* Schema.encodeEffect(storedIntents)(keys);
    yield* storage.setItem(slot, encoded);
  });
  const reusableKey = Effect.fn("MobileRequestIntent.reusableKey")(function* (
    record: typeof intent.Type | RequestKey,
  ) {
    const { key, firstAttemptAt } = readRecord(record);
    const currentTime = yield* now;
    if (!requestKeyReplayWindowOpen(firstAttemptAt, currentTime)) {
      return yield* RequestIntentExpired.make({});
    }
    return key;
  });
  const inSlot = Effect.fnUntraced(function* <A, F>(
    owner: string,
    operation: string,
    work: (slot: string) => Effect.Effect<A, F>,
  ) {
    const identity = yield* Schema.encodeEffect(slotJson)([owner, operation]);
    const slot = `kvitbit.request-intent.v1.${yield* digest(identity)}`;
    const scoped = Effect.suspend(() => work(slot));
    // Web tabs share local storage. Native serializes storage access within its JS runtime.
    const locked = withWebLock(slot, scoped) ?? withLocalLock(slot, scoped);
    return yield* locked;
  });
  const fingerprint = <P>(payload: P) =>
    payload === undefined
      ? digest("")
      : Schema.encodeEffect(payloadJson)(payload).pipe(Effect.flatMap(digest));

  return {
    acquireRequestKey: Effect.fn("MobileRequestIntent.acquire")(function* <P>(
      owner: string,
      operation: string,
      payload: P,
    ) {
      const hash = yield* fingerprint(payload);
      return yield* inSlot(
        owner,
        operation,
        Effect.fnUntraced(function* (slot: string) {
          const keys = yield* readKeys(slot);
          const previous = keys[hash];
          if (previous !== undefined) return yield* reusableKey(previous);
          const key = yield* mint;
          yield* writeKeys(slot, { ...keys, [hash]: { key, firstAttemptAt: yield* now } });
          return key;
        }),
      );
    }),
    reuseRequestKey: Effect.fn("MobileRequestIntent.reuse")(function* <P>(
      owner: string,
      operation: string,
      payload: P,
      key: RequestKey,
    ) {
      const hash = yield* fingerprint(payload);
      return yield* inSlot(
        owner,
        operation,
        Effect.fnUntraced(function* (slot: string) {
          const previous = (yield* readKeys(slot))[hash];
          if (previous === undefined || readRecord(previous).key !== key) {
            return yield* RequestIntentExpired.make({});
          }
          return yield* reusableKey(previous);
        }),
      );
    }),
    completeRequestKey: Effect.fn("MobileRequestIntent.complete")(function* (
      owner: string,
      operation: string,
      key: RequestKey,
    ) {
      yield* inSlot(
        owner,
        operation,
        Effect.fnUntraced(function* (slot: string) {
          const stored = yield* readKeys(slot);
          const keys = Record.toEntries(stored);
          const remaining = Arr.filter(keys, ([, candidate]) => readRecord(candidate).key !== key);
          if (remaining.length === keys.length) return;
          if (remaining.length === 0) yield* storage.removeItem(slot);
          else yield* writeKeys(slot, Record.fromEntries(remaining));
        }),
      );
    }),
  };
};

export const settlesRequestIntent = (
  result: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
): boolean => result._tag === "Ok" || describeError(result.error).clearRequestKey;

export const executeRequestIntent = Effect.fn("MobileRequestIntent.run")(function* <A, E>(input: {
  readonly acquire: Effect.Effect<RequestKey, E>;
  readonly request: (key: RequestKey) => Effect.Effect<ApiResult<A>, E>;
  readonly checkpoint: ((value: A) => Effect.Effect<void, E>) | undefined;
  readonly complete: (key: RequestKey) => Effect.Effect<void, E>;
}) {
  const key = yield* input.acquire;
  const result = yield* input.request(key);
  if (result._tag === "Ok" && input.checkpoint !== undefined) {
    yield* input.checkpoint(result.value);
  }
  if (settlesRequestIntent(result)) {
    // Cleanup failure must leave the settled result intact.
    yield* Effect.ignore(input.complete(key));
  }
  return result;
});
