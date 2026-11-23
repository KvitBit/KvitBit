import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { FixtureRates, SqlCache } from "../../src/fx";
import { counting, migratedPglite } from "./support";

const friday = FixtureRates.fixing("2026-11-20", 225, {
  EUR: [1, "24.335"],
  JPY: [100, "15.123"],
});

const fixing = (date: string) =>
  Effect.gen(function* () {
    return yield* (yield* ExchangeRates).fixing(date as IsoDate);
  });

/** Runs `body` against SqlCache over `inner` and a fresh migrated database. */
const withSqlCache = <A, E>(
  inner: Layer.Layer<ExchangeRates>,
  body: Effect.Effect<A, E, ExchangeRates | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(Layer.provideMerge(SqlCache.layer, Layer.merge(inner, migratedPglite))),
    ),
  );

/** BigDecimal memoizes its normalized form, so compare fixings as plain values. */
const plain = (f: CnbFixing) => ({
  ...f,
  rates: f.rates.map((r) => ({ ...r, rate: BigDecimal.format(r.rate) })),
});

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ fixing_date: string; sequence: number; rates: unknown }>`
    select fixing_date::text as fixing_date, sequence, rates from fx_fixings order by fixing_date
  `;
});

describe("SqlCache", () => {
  test("a miss fetches once and stores the fixing; a hit skips the inner adapter", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        const first = yield* fixing("2026-11-20");
        expect(yield* rows).toEqual([
          {
            fixing_date: "2026-11-20",
            sequence: 225,
            rates: [
              { code: "EUR", quantity: 1, rate: "24.335" },
              { code: "JPY", quantity: 100, rate: "15.123" },
            ],
          },
        ]);
        const second = yield* fixing("2026-11-20");
        expect(second.sequence).toBe(225);
        const jpy = second.rates.find((r) => r.code === "JPY");
        expect(jpy?.quantity).toBe(100);
        expect(jpy && BigDecimal.equals(jpy.rate, BigDecimal.fromStringUnsafe("15.123"))).toBe(
          true,
        );
        expect(plain(second)).toEqual(plain(first));
      }),
    );
    expect(inner.state.calls).toBe(1);
  });

  test("a carried-back fixing is stored under its own date and then serves that date", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        expect<unknown>((yield* fixing("2026-11-22")).fixingDate).toBe("2026-11-20");
        expect((yield* rows).map((r) => r.fixing_date)).toEqual(["2026-11-20"]);
        expect<unknown>((yield* fixing("2026-11-20")).fixingDate).toBe("2026-11-20");
        // Exact-date lookup only: the weekend date misses again (documented strategy).
        expect<unknown>((yield* fixing("2026-11-22")).fixingDate).toBe("2026-11-20");
        expect((yield* rows).map((r) => r.fixing_date)).toEqual(["2026-11-20"]);
      }),
    );
    expect(inner.state.calls).toBe(2);
  });

  test("an unreadable row is treated as a miss and overwritten", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into fx_fixings (fixing_date, sequence, rates)
                   values ('2026-11-20', 225, '[{"code":"EUR","rate":24.335}]'::jsonb)`;
        expect((yield* fixing("2026-11-20")).rates).toHaveLength(2);
        const [row] = yield* rows;
        expect(row?.rates).toHaveLength(2);
      }),
    );
    expect(inner.state.calls).toBe(1);
  });

  test("an inner failure fails the request and stores nothing", async () => {
    await withSqlCache(
      FixtureRates.layer([]),
      Effect.gen(function* () {
        expect(yield* Effect.flip(fixing("2026-11-20"))).toBeInstanceOf(RatesUnavailable);
        expect(yield* rows).toEqual([]);
      }),
    );
  });

  test("a database failure falls through to the inner adapter", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop table fx_fixings`;
        expect((yield* fixing("2026-11-20")).sequence).toBe(225);
        expect((yield* fixing("2026-11-20")).sequence).toBe(225);
      }),
    );
    expect(inner.state.calls).toBe(2);
  });

  test("a database failure inside a caller's transaction leaves that transaction usable", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const after = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`drop table fx_fixings`;
            expect((yield* fixing("2026-11-20")).sequence).toBe(225);
            return yield* sql<{ ok: number }>`select 1 as ok`;
          }),
        );
        expect(after).toEqual([{ ok: 1 }]);
      }),
    );
  });

  test("round-trips rates that BigDecimal formats in exponent notation", async () => {
    const tiny = FixtureRates.fixing("2026-11-20", 225, { XAU: [1, "0.00000000000000001234"] });
    const inner = counting(FixtureRates.make([tiny]));
    await withSqlCache(
      inner.layer,
      Effect.gen(function* () {
        const first = yield* fixing("2026-11-20");
        const second = yield* fixing("2026-11-20");
        expect(plain(second)).toEqual(plain(first));
      }),
    );
    expect(inner.state.calls).toBe(1);
  });
});
