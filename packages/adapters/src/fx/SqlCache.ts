/**
 * Read-through cache over `fx_fixings` (packages/db/src/schema/system.ts) in front of another
 * `ExchangeRates` (core-ports.md section 6: "Core caches fixings in fx_fixings").
 *
 * Strategy, kept deliberately simple:
 * - Lookup is by exact date: a row whose `fixing_date` equals the requested date. A row is a
 *   published fixing, so a hit is always the right answer for its own date.
 * - On a miss the inner adapter is asked and its fixing is upserted under its own
 *   `fixing_date`, which may be earlier than the requested date (carry-back).
 * - So a weekend or holiday request never hits and costs one inner request each time; put
 *   `MemoryCache` in front to absorb repeats within a process. Answering a later date from an
 *   older row would need proof that no fixing was published in between, which the table
 *   does not record.
 * - The cache is best effort: a failed read, an unreadable row or a failed write is logged
 *   and the request goes to, or returns from, the inner adapter. Only the inner adapter's
 *   failure fails the request.
 *
 * `rates` is stored as `[{ code, quantity, rate }]` with `rate` as a decimal string.
 */

import { CurrencyCode, type IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

const DecimalString = Schema.String.pipe(Schema.check(Schema.isPattern(/^-?\d+(?:\.\d+)?$/)));

const StoredRates = Schema.Array(
  Schema.Struct({
    code: CurrencyCode,
    quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    rate: DecimalString,
  }),
);

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

  const read = (date: IsoDate): Effect.Effect<Option.Option<CnbFixing>> =>
    sql<{ sequence: unknown; rates: unknown }>`
      select sequence, rates from fx_fixings where fixing_date = ${date}
    `.pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.succeedNone
          : decodeRow(row).pipe(
              Effect.map(({ sequence, rates }) =>
                Option.some<CnbFixing>({
                  fixingDate: date,
                  sequence,
                  rates: rates.map((r) => ({ ...r, rate: BigDecimal.fromStringUnsafe(r.rate) })),
                }),
              ),
            ),
      ),
      Effect.catch((cause) =>
        Effect.as(Effect.logWarning("fx_fixings read failed", cause), Option.none()),
      ),
    );

  const write = (fixing: CnbFixing): Effect.Effect<void> =>
    sql`
      insert into fx_fixings (fixing_date, sequence, rates, fetched_at)
      values (${fixing.fixingDate}, ${fixing.sequence}, ${JSON.stringify(toStored(fixing))}::jsonb, now())
      on conflict (fixing_date) do update
        set sequence = excluded.sequence, rates = excluded.rates, fetched_at = excluded.fetched_at
    `.pipe(
      Effect.asVoid,
      Effect.catch((cause) => Effect.logWarning("fx_fixings write failed", cause)),
    );

  return {
    fixing: (date) =>
      read(date).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => inner.fixing(date).pipe(Effect.tap(write)),
          }),
        ),
      ),
  };
});

/** Wraps the `ExchangeRates` it is provided with; needs a `SqlClient` on the migrated schema. */
export const layer: Layer.Layer<ExchangeRates, never, ExchangeRates | SqlClient.SqlClient> =
  Layer.effect(ExchangeRates, make);
