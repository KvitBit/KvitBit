/**
 * Edge rate limits (http-mcp-contracts section 2.5). Counters are fixed windows that open on a
 * key's first request; hosted installs keep them in Postgres (`auth.rate_limit`, keys prefixed
 * `edge:`) so every instance shares them. The Better Auth limits of `/api/auth/*` are Better
 * Auth's own.
 */

import { generateId } from "@kvitbit/adapters/auth";
import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

export interface RateRule {
  readonly max: number;
  readonly windowSeconds: number;
}

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiterShape {
  /**
   * Counts one request for `key` under `rule`. A store failure admits the request (logged):
   * the limits protect capacity, and a database outage fails the request in core anyway.
   */
  readonly consume: (key: string, rule: RateRule) => Effect.Effect<RateDecision>;
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()(
  "kvitbit/server/http/RateLimiter",
) {}

/** The limits of section 2.5 the HttpApi edge enforces. */
export const RATE_LIMITS = {
  apiKey: { max: 600, windowSeconds: 60 },
  session: { max: 1200, windowSeconds: 60 },
  botChallenge: { max: 30, windowSeconds: 60 },
  registry: { max: 20, windowSeconds: 60 },
  themeResolve: { max: 60, windowSeconds: 60 },
  previewPdf: { max: 30, windowSeconds: 60 },
  shareLink: { max: 120, windowSeconds: 60 },
  invitationPeek: { max: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateRule>;

const decide = (count: number, windowStart: number, now: number, rule: RateRule): RateDecision =>
  count <= rule.max
    ? { allowed: true }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart + rule.windowSeconds * 1000 - now) / 1000),
        ),
      };

/** Process-local counters (tests, single-node self-host without shared state). */
export const RateLimiterMemory: Layer.Layer<RateLimiter> = Layer.sync(RateLimiter, () => {
  const windows = new Map<string, { start: number; count: number }>();
  return RateLimiter.of({
    consume: (key, rule) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const current = windows.get(key);
        const open = current !== undefined && now < current.start + rule.windowSeconds * 1000;
        const next = open
          ? { start: current.start, count: current.count + 1 }
          : { start: now, count: 1 };
        windows.set(key, next);
        return decide(next.count, next.start, now, rule);
      }),
  });
});

/** Shared counters in `auth.rate_limit`: one atomic upsert per request. */
export const RateLimiterSql: Layer.Layer<RateLimiter, never, SqlClient.SqlClient> = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RateLimiter.of({
      consume: (key, rule) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const windowOpenedAfter = now - rule.windowSeconds * 1000;
          const rows = yield* sql<{ count: number; last_request: string | number }>`
            insert into auth.rate_limit (id, key, count, last_request)
            values (${generateId()}, ${`edge:${key}`}, 1, ${now})
            on conflict (key) do update set
              count = case when auth.rate_limit.last_request <= ${windowOpenedAfter}
                then 1 else auth.rate_limit.count + 1 end,
              last_request = case when auth.rate_limit.last_request <= ${windowOpenedAfter}
                then ${now} else auth.rate_limit.last_request end
            returning count, last_request`;
          const row = rows[0];
          if (row === undefined) return { allowed: true } as const;
          return decide(Number(row.count), Number(row.last_request), now, rule);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("edge rate limiter unavailable; admitting request", cause),
              { allowed: true } as const,
            ),
          ),
        ),
    });
  }),
);
