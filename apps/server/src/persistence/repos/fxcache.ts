/**
 * `FxFixingCache` over `fx_fixings` + `fx_fixing_requests`.
 *
 * `get(on)` looks up `fx_fixing_requests.requested_on = on` joined to `fx_fixings` (or falls back
 * directly to `fx_fixings.fixing_date = on` if a fixing was stored directly).
 * `put(on, fixing)` upserts `fx_fixings` and `fx_fixing_requests` idempotently.
 */
import { FxFixingCache } from "@kvitbit/core";
import type { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { formatDecimal, parseDecimal, parseJson } from "../codec";
import { unavailable } from "../errors";
import { col, type DbRow } from "../table";

interface StoredRate {
  readonly code: string;
  readonly quantity: number;
  readonly rate: string;
}

const decodeFixing = (row: DbRow): CnbFixing => ({
  fixingDate: row.fixing_date as IsoDate,
  sequence: Number(row.sequence),
  rates: parseJson<ReadonlyArray<StoredRate>>(row.rates).map((r) => ({
    code: r.code as CurrencyCode,
    quantity: Number(r.quantity),
    rate: parseDecimal(r.rate),
  })),
});

const encodeRates = (rates: CnbFixing["rates"]): string =>
  JSON.stringify(
    rates.map((r) => ({
      code: r.code,
      quantity: r.quantity,
      rate: formatDecimal(r.rate),
    })),
  );

export const FxFixingCacheSql: Layer.Layer<FxFixingCache, never, SqlClient.SqlClient> =
  Layer.effect(
    FxFixingCache,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return FxFixingCache.of({
        get: (on) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(col.date("f.fixing_date", "fixing_date"))}, f.sequence, f.rates
                from fx_fixing_requests r
                join fx_fixings f on f.fixing_date = r.fixing_date
                where r.requested_on = ${on}
                union all
                select ${sql.unsafe(col.date("f.fixing_date", "fixing_date"))}, f.sequence, f.rates
                from fx_fixings f
                where f.fixing_date = ${on}
                  and not exists (select 1 from fx_fixing_requests r where r.requested_on = ${on})
                limit 1
              `,
            ),
            (rows) => (rows[0] === undefined ? Option.none() : Option.some(decodeFixing(rows[0]))),
          ),
        put: (on, fixing) =>
          unavailable(
            Effect.gen(function* () {
              const ratesJson = encodeRates(fixing.rates);
              yield* sql`
                insert into fx_fixings (fixing_date, sequence, rates)
                values (${fixing.fixingDate}, ${fixing.sequence}, ${ratesJson}::jsonb)
                on conflict (fixing_date) do nothing
              `;
              yield* sql`
                insert into fx_fixing_requests (requested_on, fixing_date)
                values (${on}, ${fixing.fixingDate})
                on conflict (requested_on) do nothing
              `;
            }),
          ).pipe(Effect.asVoid),
      });
    }),
  );
