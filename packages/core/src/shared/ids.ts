/**
 * Id generation as an Effect service, so tests are deterministic. Live ids are UUIDv7 built from
 * Effect's `Clock` and `Random`, so `TestClock` and a seeded `Random` also make them repeatable.
 */
import { Clock, Context, Effect, Layer, Random, Ref } from "effect";

export class IdGenerator extends Context.Service<
  IdGenerator,
  { readonly next: Effect.Effect<string> }
>()("kvitbit/core/IdGenerator") {}

const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");

/** Formats a UUIDv7 from a millisecond timestamp and 74 bits of entropy given as 5 numbers. */
export const formatUuidV7 = (
  millis: number,
  randA: number, // 12 bits
  randB1: number, // 14 bits
  randB2: number, // 30 bits
  randB3: number, // 16 bits
): string => {
  const ts = hex(Math.max(0, Math.floor(millis)) % 2 ** 48, 12);
  const variant = (0b10 << 14) | (randB1 & 0x3fff);
  const tail = hex(randB2 & 0x3fffffff, 8).slice(-8) + hex(randB3 & 0xffff, 4);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(randA & 0xfff, 3)}-${hex(variant, 4)}-${tail}`;
};

export const IdGeneratorLive: Layer.Layer<IdGenerator> = Layer.succeed(IdGenerator, {
  next: Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const a = yield* Random.nextIntBetween(0, 0xfff);
    const b1 = yield* Random.nextIntBetween(0, 0x3fff);
    const b2 = yield* Random.nextIntBetween(0, 0x3fffffff);
    const b3 = yield* Random.nextIntBetween(0, 0xffff);
    return formatUuidV7(millis, a, b1, b2, b3);
  }),
});

/**
 * Deterministic ids for tests: valid UUIDv7 strings `01900000-0000-7000-8000-<n as 12 hex>`,
 * numbered from 1 per layer instance and sorting in creation order.
 */
export const IdGeneratorTest: Layer.Layer<IdGenerator> = Layer.effect(
  IdGenerator,
  Effect.map(Ref.make(0), (counter) => ({
    next: Effect.map(
      Ref.updateAndGet(counter, (n) => n + 1),
      (n) => `01900000-0000-7000-8000-${hex(n, 12)}`,
    ),
  })),
);

/** A fresh id typed as `Id`, e.g. `newId<DocumentId>()`. */
export const newId = <Id extends string>(): Effect.Effect<Id, never, IdGenerator> =>
  Effect.flatMap(IdGenerator, (ids) => ids.next as Effect.Effect<Id>);
