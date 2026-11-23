/**
 * Read-through cache over `fx_fixings` (packages/db/src/schema/system.ts) in front of another
 * `ExchangeRates` (core-ports.md section 6: "Core caches fixings in fx_fixings").
 *
 * Strategy, kept deliberately simple:
 * - Lookup is by exact date: a row whose `fixing_date` equals the requested date. A row is a
 *   published fixing, so a hit is always the right answer for its own date.
 * - On a miss the inner adapter is asked and its fixing is inserted under its own
 *   `fixing_date`, which may be earlier than the requested date (carry-back). An existing row
 *   is left alone (`on conflict do nothing`, which takes no row lock, so concurrent callers in
 *   long transactions do not serialize on it). Only an unreadable row for the requested date
 *   is overwritten, when the inner adapter returns that same date.
 * - So a request that carries back (weekend, holiday, today before the 14:30 publication)
 *   never hits and costs one inner request each time. `MemoryCache` in front absorbs repeats
 *   only for finished days; carried-back answers for today are refetched on every request by
 *   design, so the new publication is never hidden. Answering a later date from an older row
 *   would need proof that no fixing was published in between, which the table does not
 *   record.
 * - The cache is best effort: a failed read, an unreadable row or a failed write is logged
 *   and the request goes to, or returns from, the inner adapter. Only the inner adapter's
 *   failure fails the request. Each statement runs in its own transaction, which becomes a
 *   savepoint inside a caller's transaction, so a swallowed SQL error rolls back only the
 *   cache statement and leaves the caller's transaction usable.
 *
 * `rates` is stored as `[{ code, quantity, rate }]` with `rate` as a decimal string.
 */

import { CurrencyCode, type IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/**
 * A positive rate as `BigDecimal.format` writes it: plain digits, or exponent notation at 16+
 * digits of scale. The pattern comes first because `BigDecimal.fromString("")` is zero.
 */
const PLAIN_OR_EXPONENT = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/;
const isPositiveDecimal = (s: string): boolean =>
  PLAIN_OR_EXPONENT.test(s) &&
  Option.exists(BigDecimal.fromString(s), (d) => BigDecimal.isPositive(d));

const DecimalString = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isPositiveDecimal, { expected: "a positive decimal string" })),
);

const StoredRates = Schema.Array(
  Schema.Struct({
    code: CurrencyCode,
    quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    rate: DecimalString,
  }),
).pipe(Schema.check(Schema.isMinLength(1)));

const Row = Schema.Struct({ sequence: Schema.Int, rates: StoredRates });
const decodeRow = Schema.decodeUnknownEffect(Row);

const toStored = (fixing: CnbFixing): typeof StoredRates.Type =>
  fixing.rates.map(({ code, quantity, rate }) => ({
    code,
    quantity,
    rate: BigDecimal.format(rate),
  }));

export const make: Effect.Effect<
  ExchangeRates["Service"],
  never,
  ExchangeRates | SqlClient.SqlClient
> = Effect.gen(function* () {
  const inner = yield* ExchangeRates;
  const sql = yield* SqlClient.SqlClient;

  /** A hit, a miss, or a row for `date` that exists but does not decode. */
  type Lookup =
    | { readonly _tag: "Hit"; readonly fixing: CnbFixing }
    | { readonly _tag: "Miss" }
    | { readonly _tag: "Unreadable" };
  const miss: Lookup = { _tag: "Miss" };

  const read = (date: IsoDate): Effect.Effect<Lookup> =>
    sql<{ sequence: unknown; rates: unknown }>`
      select sequence, rates from fx_fixings where fixing_date = ${date}
    `.pipe(
      sql.withTransaction,
      Effect.catch((cause) =>
        Effect.as(Effect.logWarning("fx_fixings read failed", cause), [] as const),
      ),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.succeed(miss)
          : decodeRow(row).pipe(
              Effect.map(
                ({ sequence, rates }): Lookup => ({
                  _tag: "Hit",
                  fixing: {
                    fixingDate: date,
                    sequence,
                    rates: rates.map((r) => ({ ...r, rate: BigDecimal.fromStringUnsafe(r.rate) })),
                  },
                }),
              ),
              Effect.catch((cause) =>
                Effect.as(Effect.logWarning("fx_fixings row unreadable", cause), {
                  _tag: "Unreadable",
                } as const),
              ),
            ),
      ),
    );

  const write = (fixing: CnbFixing, repair: boolean): Effect.Effect<void> =>
    sql`
      insert into fx_fixings (fixing_date, sequence, rates, fetched_at)
      values (${fixing.fixingDate}, ${fixing.sequence}, ${JSON.stringify(toStored(fixing))}::jsonb, now())
      on conflict (fixing_date) ${
        repair
          ? sql`do update set sequence = excluded.sequence, rates = excluded.rates,
                fetched_at = excluded.fetched_at`
          : sql`do nothing`
      }
    `.pipe(
      sql.withTransaction,
      Effect.asVoid,
      Effect.catch((cause) => Effect.logWarning("fx_fixings write failed", cause)),
    );

  return {
    fixing: (date) =>
      read(date).pipe(
        Effect.flatMap((lookup) =>
          lookup._tag === "Hit"
            ? Effect.succeed(lookup.fixing)
            : inner
                .fixing(date)
                .pipe(
                  Effect.tap((fixing) =>
                    write(fixing, lookup._tag === "Unreadable" && fixing.fixingDate === date),
                  ),
                ),
        ),
      ),
  };
});

/** Wraps the `ExchangeRates` it is provided with; needs a `SqlClient` on the migrated schema. */
export const layer: Layer.Layer<ExchangeRates, never, ExchangeRates | SqlClient.SqlClient> =
  Layer.effect(ExchangeRates, make);
