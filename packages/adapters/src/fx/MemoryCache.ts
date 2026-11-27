/**
 * In-process read-through cache in front of another `ExchangeRates`, keyed by requested date.
 *
 * An answer is final, and cached, when its fixing is dated on the requested date or the
 * requested date is already over in Prague. A carried-back answer for today or a later day is
 * not cached: CNB publishes today's fixing at 14:30, after which the same request returns a
 * newer fixing. Failures are never cached.
 */

import type { IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates } from "@kvitbit/domain/ports";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const pragueDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Europe/Prague, from the Effect `Clock`. */
export const pragueToday: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) =>
  pragueDate.format(ms),
);

export const make = (inner: ExchangeRates["Service"]): Effect.Effect<ExchangeRates["Service"]> =>
  Effect.sync(() => {
    const byDate = new Map<IsoDate, CnbFixing>();

    const remember = Effect.fn("remember")(function* (date: IsoDate, fixing: CnbFixing) {
      if (fixing.fixingDate === date || date < (yield* pragueToday)) byDate.set(date, fixing);
    });

    return {
      fixing: (date) =>
        Effect.suspend(() => {
          const hit = byDate.get(date);
          return hit !== undefined
            ? Effect.succeed(hit)
            : inner.fixing(date).pipe(Effect.tap((fixing) => remember(date, fixing)));
        }),
    };
  });

/** Wraps the `ExchangeRates` it is provided with: `MemoryCache.layer.pipe(Layer.provide(inner))`. */
export const layer: Layer.Layer<ExchangeRates, never, ExchangeRates> = Layer.effect(
  ExchangeRates,
  Effect.gen(function* () {
    const ExchangeRates_1 = yield* ExchangeRates;
    return yield* make(ExchangeRates_1);
  }),
);
