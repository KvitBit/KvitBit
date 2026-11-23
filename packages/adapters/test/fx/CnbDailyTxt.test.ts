import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import { Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { CnbDailyTxt, MalformedFeed } from "../../src/fx";
import { FRIDAY_FEED, type Reply, scriptedFetch } from "./support";

const run = (
  replies: Readonly<Record<string, Reply>>,
  date: string,
  options?: CnbDailyTxt.Options,
) => {
  const { fetch, calls } = scriptedFetch(replies);
  const exit = Effect.runPromiseExit(
    Effect.gen(function* () {
      const rates = yield* ExchangeRates;
      return yield* rates.fixing(date as IsoDate);
    }).pipe(
      Effect.provide(CnbDailyTxt.layerFetch(options)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  return { exit, calls };
};

const failureOf = <A>(exit: Exit.Exit<A, RatesUnavailable>): RatesUnavailable => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (error?._tag !== "Fail") throw new Error(`expected RatesUnavailable, got ${exit.cause}`);
  return error.error;
};

describe("CnbDailyTxt", () => {
  test("asks for the requested date in DD.MM.YYYY and returns the parsed fixing", async () => {
    const { exit, calls } = run({ "20.11.2026": { body: FRIDAY_FEED } }, "2026-11-20");
    const result = await exit;
    expect<unknown>(Exit.isSuccess(result) && result.value.fixingDate).toBe("2026-11-20");
    expect(Exit.isSuccess(result) && result.value.sequence).toBe(223);
    expect(calls).toHaveLength(1);
    expect(`${calls[0]?.origin}${calls[0]?.pathname}`).toBe(CnbDailyTxt.DEFAULT_URL);
    expect(calls[0]?.searchParams.get("date")).toBe("20.11.2026");
  });

  test("carries a weekend request back to the last published fixing", async () => {
    // CNB answers Saturday and Sunday with Friday's fixing.
    for (const [requested, param] of [
      ["2026-11-21", "21.11.2026"],
      ["2026-11-22", "22.11.2026"],
    ] as const) {
      const result = await run({ [param]: { body: FRIDAY_FEED } }, requested).exit;
      expect<unknown>(Exit.isSuccess(result) && result.value.fixingDate).toBe("2026-11-20");
    }
  });

  test("carries a holiday request back (17.11. falls on a Tuesday in 2026)", async () => {
    const monday = FRIDAY_FEED.replace("20.11.2026 #223", "16.11.2026 #220");
    const result = await run({ "17.11.2026": { body: monday } }, "2026-11-17").exit;
    expect<unknown>(Exit.isSuccess(result) && result.value.fixingDate).toBe("2026-11-16");
  });

  test("fails when the feed's fixing is dated after the requested date", async () => {
    const error = failureOf(await run({ "19.11.2026": { body: FRIDAY_FEED } }, "2026-11-19").exit);
    expect(error).toBeInstanceOf(RatesUnavailable);
    expect(error.cause).toBeInstanceOf(CnbDailyTxt.FixingAfterRequestedDate);
  });

  test("maps a non-2xx status to RatesUnavailable", async () => {
    const replies = { "20.11.2026": { status: 503, body: FRIDAY_FEED } };
    expect(failureOf(await run(replies, "2026-11-20").exit)).toBeInstanceOf(RatesUnavailable);
  });

  test("maps a network failure to RatesUnavailable", async () => {
    const replies = { "20.11.2026": new TypeError("fetch failed") };
    expect(failureOf(await run(replies, "2026-11-20").exit)).toBeInstanceOf(RatesUnavailable);
  });

  test("maps a malformed body to RatesUnavailable", async () => {
    const replies = { "20.11.2026": { body: "<html>Údržba</html>" } };
    const error = failureOf(await run(replies, "2026-11-20").exit);
    expect(error).toBeInstanceOf(RatesUnavailable);
    expect(error.cause).toBeInstanceOf(MalformedFeed);
  });

  test("times out a request that never answers", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof globalThis.fetch;
    const started = Date.now();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* ExchangeRates).fixing("2026-11-20" as IsoDate);
      }).pipe(
        Effect.provide(CnbDailyTxt.layerFetch({ timeout: "50 millis" })),
        Effect.provideService(FetchHttpClient.Fetch, hanging),
      ),
    );
    expect(failureOf(exit)).toBeInstanceOf(RatesUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("uses a configured URL", async () => {
    const { fetch, calls } = scriptedFetch({ "20.11.2026": { body: FRIDAY_FEED } });
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ExchangeRates).fixing("2026-11-20" as IsoDate);
      }).pipe(
        Effect.provide(CnbDailyTxt.layerFetch({ url: "https://mirror.example/denni_kurz.txt" })),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    expect(calls[0]?.host).toBe("mirror.example");
  });
});
