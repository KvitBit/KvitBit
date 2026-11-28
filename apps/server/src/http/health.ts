/**
 * Operational probes (board agreement #871/#878/#913, http-mcp-contracts section 1):
 * - `GET /healthz`: liveness (200 `{ status: "ok" }` whenever the process can answer).
 * - `GET /readyz`: readiness (`SELECT 1` within 1s -> 200 `{ status: "ok" }`, else 503).
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";

const READY_TIMEOUT = Duration.seconds(1);

export const HealthRoutesLive = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const sql = yield* SqlClient.SqlClient;

    yield* router.add(
      "GET",
      "/healthz",
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { status: "ok" },
          { status: 200, headers: { "cache-control": "no-store" } },
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/readyz",
      sql`select 1 as ok`.pipe(
        Effect.timeout(READY_TIMEOUT),
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { status: "ok" },
            { status: 200, headers: { "cache-control": "no-store" } },
          ),
        ),
        Effect.catchCause(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { status: "unavailable" },
              { status: 503, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      ),
    );
  }),
);
