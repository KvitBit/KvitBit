/**
 * Edge rate limits (http-mcp-contracts section 2.5). Counters use a trailing sliding window:
 * at most `max` admissions in any trailing `windowSeconds`. Hosted and self-hosted installs
 * keep them in Postgres (`auth.rate_limit`, keys prefixed `edge:<key>#<id>`) so every instance
 * shares them. The Better Auth limits of `/api/auth/*` are Better Auth's own.
 */

import { generateId } from "@kvitbit/adapters/auth";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectRecord from "effect/Record";
import * as SqlClient from "effect/sql/SqlClient";

export interface RateRule {
  readonly max: number;
  readonly windowSeconds: number;
}

type RateDecision =
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
  "@kvitbit/server/http/edge/RateLimiter",
) {}

/** The limits of section 2.5 the HTTP and MCP edge enforces. */
export const RATE_LIMITS = {
  apiKey: { max: 600, windowSeconds: 60 },
  session: { max: 1200, windowSeconds: 60 },
  mcpGrant: { max: 300, windowSeconds: 60 },
  botChallenge: { max: 30, windowSeconds: 60 },
  registry: { max: 20, windowSeconds: 60 },
  themeResolve: { max: 60, windowSeconds: 60 },
  previewPdf: { max: 30, windowSeconds: 60 },
  shareLink: { max: 120, windowSeconds: 60 },
  invitationPeek: { max: 30, windowSeconds: 60 },
  feedback: { max: 12, windowSeconds: 60 },
  analyticsProxy: { max: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateRule>;

const MAX_EDGE_WINDOW_MS =
  Math.max(...Arr.map(EffectRecord.values(RATE_LIMITS), (rule) => rule.windowSeconds)) * 1000;
const IDLE_PRUNE_LIMIT = 100;

const retryAfterFrom = (oldestAdmissionMs: number, windowMs: number, now: number): number =>
  Math.max(1, Math.ceil((oldestAdmissionMs + windowMs - now) / 1000));

/** Process-local trailing sliding-window counters (tests, single-node fallback). */
export const RateLimiterMemory: Layer.Layer<RateLimiter> = Layer.sync(RateLimiter, () => {
  const admissions = new Map<string, Array<number>>();
  return RateLimiter.of({
    consume: Effect.fn("RateLimiter.consume")((key, rule) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const windowMs = rule.windowSeconds * 1000;
        const cutoff = now - windowMs;
        const existing = admissions.get(key) ?? [];
        const live = Arr.filter(existing, (ts) => ts > cutoff);
        if (live.length < rule.max) {
          live.push(now);
          admissions.set(key, live);
          return { allowed: true } as const;
        }
        if (live.length === 0) {
          admissions.delete(key);
        } else {
          admissions.set(key, live);
        }
        const oldest = live[Math.max(0, live.length - rule.max)] ?? now;
        return {
          allowed: false,
          retryAfterSeconds: retryAfterFrom(oldest, windowMs, now),
        } as const;
      }),
    ),
  });
});

/**
 * Shared trailing sliding-window counters in `auth.rate_limit`: one admission row per accepted
 * request (`edge:<key>#<id>`), serialized per key with a transaction-scoped advisory lock.
 * Expired rows for the current key and a bounded batch of expired idle edge rows are pruned in
 * the same transaction; refused requests write nothing.
 */
export const RateLimiterSql: Layer.Layer<RateLimiter, never, SqlClient.SqlClient> = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RateLimiter.of({
      consume: Effect.fn("RateLimiter.consume")((key, rule) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const bucketKey = `edge:${key}`;
              const prefix = `${bucketKey}#`;
              const windowMs = rule.windowSeconds * 1000;
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${bucketKey}, 0))`;
              // Read the clock after acquiring the lock so requests that waited observe
              // admissions that expired meanwhile.
              const now = yield* Clock.currentTimeMillis;
              const cutoff = now - windowMs;
              const idleCutoff = now - Math.max(windowMs, MAX_EDGE_WINDOW_MS);
              yield* sql`
                delete from auth.rate_limit
                where starts_with(key, ${prefix}) and last_request <= ${cutoff}`;
              yield* sql`
                delete from auth.rate_limit
                where id in (
                  select id from auth.rate_limit
                  where starts_with(key, 'edge:') and last_request <= ${idleCutoff}
                  limit ${IDLE_PRUNE_LIMIT}
                )`;
              const live = yield* sql<{ last_request: string | number }>`
                select last_request from auth.rate_limit
                where starts_with(key, ${prefix})
                order by last_request asc`;
              if (live.length < rule.max) {
                yield* sql`
                  insert into auth.rate_limit (id, key, count, last_request)
                  values (${generateId()}, ${`${prefix}${generateId()}`}, 1, ${now})`;
                return { allowed: true } as const;
              }
              const oldest = Number(live[Math.max(0, live.length - rule.max)]?.last_request ?? now);
              return {
                allowed: false,
                retryAfterSeconds: retryAfterFrom(oldest, windowMs, now),
              } as const;
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning("edge rate limiter unavailable; admitting request", cause),
                { allowed: true } as const,
              ),
            ),
          ),
      ),
    });
  }),
);
