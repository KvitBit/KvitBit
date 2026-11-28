/** Shared test support: a real-shaped CNB feed, a scripted `fetch` and a migrated PGlite. */
import { fileURLToPath } from "node:url";
import { PgliteClient } from "@effect/sql-pglite";
import { PGlite } from "@electric-sql/pglite";
import { ExchangeRates } from "@kvitbit/domain/ports";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";

/** Friday 2026-11-20 in the shape CNB serves it (a few currencies, illustrative rates). */
export const FRIDAY_FEED = `20.11.2026 #223
země|měna|množství|kód|kurz
Austrálie|dolar|1|AUD|13,797
EMU|euro|1|EUR|24,335
Indonésie|rupie|1000|IDR|1,248
Japonsko|jen|100|JPY|15,123
Maďarsko|forint|100|HUF|6,304
USA|dolar|1|USD|20,912
`;

export type Reply = { readonly status?: number; readonly body: string } | Error;

/**
 * A `fetch` that answers by the `date` query parameter (`DD.MM.YYYY`) and records each
 * request URL. Unknown dates get a 404.
 */
export const scriptedFetch = (replies: Readonly<Record<string, Reply>>) => {
  const calls: Array<URL> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(url);
      const reply = replies[url.searchParams.get("date") ?? ""];
      if (reply instanceof Error) return Promise.reject(reply);
      if (reply === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(new Response(reply.body, { status: reply.status ?? 200 }));
    },
    { preconnect: () => undefined },
  );
  return { fetch, calls };
};

const migrationsFolder = fileURLToPath(new URL("../../../db/drizzle", import.meta.url));

/** A fresh in-memory PGlite with the committed migrations applied, as an Effect `SqlClient`. */
export const migratedPglite: Layer.Layer<SqlClient.SqlClient | PgliteClient.PgliteClient> =
  PgliteClient.layerFrom(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new PGlite()),
        (pglite) => Effect.promise(() => pglite.close()),
      );
      yield* Effect.promise(() => migrate(drizzle({ client }), { migrationsFolder }));
      return yield* PgliteClient.fromClient({ liveClient: client });
    }),
  ).pipe(Layer.orDie);

/** Wraps an `ExchangeRates` service and counts the calls that reach it. */
export const counting = (inner: ExchangeRates["Service"]) => {
  const state = { calls: 0 };
  const service: ExchangeRates["Service"] = {
    fixing: (date) =>
      Effect.suspend(() => {
        state.calls++;
        return inner.fixing(date);
      }),
  };
  return { service, layer: Layer.succeed(ExchangeRates, service), state };
};
