/**
 * Id generation as an Effect service, so tests are deterministic. Live ids are UUIDv7 built from
 * Effect's `Clock` and `Random`, so `TestClock` and a seeded `Random` also make them repeatable.
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";

export class IdGenerator extends Context.Service<
  IdGenerator,
  { readonly next: Effect.Effect<string> }
>()("@kvitbit/core/shared/ids/IdGenerator") {}

const hex = (value: number, width: number) => EffectString.padStart(width, "0")(value.toString(16));

/** Formats a UUIDv7 from a millisecond timestamp and 74 bits of entropy given as 5 numbers. */
const formatUuidV7 = (
  millis: number,
  randA: number, // 12 bits
  randB1: number, // 14 bits
  randB2: number, // 30 bits
  randB3: number, // 16 bits
): string => {
  const ts = hex(Math.max(0, Math.floor(millis)) % 2 ** 48, 12);
  const variant = (0b10 << 14) | (randB1 & 0x3fff);
  const tail = EffectString.slice(-8)(hex(randB2 & 0x3fffffff, 8)) + hex(randB3 & 0xffff, 4);
  return `${EffectString.slice(0, 8)(ts)}-${EffectString.slice(8, 12)(ts)}-7${hex(randA & 0xfff, 3)}-${hex(variant, 4)}-${tail}`;
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

const generateId = Effect.flatMap(IdGenerator, (ids) => ids.next);

/** A fresh UUIDv7, validated by the supplied brand constructor when one is needed. */
export function newId(): Effect.Effect<string, never, IdGenerator>;
export function newId<Id extends string>(
  make: (value: string) => Id,
): Effect.Effect<Id, never, IdGenerator>;
export function newId<Id extends string>(make?: (value: string) => Id) {
  return make === undefined ? generateId : Effect.map(generateId, make);
}
