/**
 * Edge rate limits (http-mcp-contracts section 2.5). Counters use a trailing sliding window:
 * at most `max` admissions in any trailing `windowSeconds`. Hosted and self-hosted installs
 * keep them in Postgres (`auth.rate_limit`, keys prefixed `edge:<key>#<id>`) so every instance
 * shares them. The Better Auth limits of `/api/auth/*` are Better Auth's own.
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
} as const satisfies Record<string, RateRule>;

const MAX_EDGE_WINDOW_MS =
  Math.max(...Object.values(RATE_LIMITS).map((rule) => rule.windowSeconds)) * 1000;
const IDLE_PRUNE_LIMIT = 100;

const retryAfterFrom = (oldestAdmissionMs: number, windowMs: number, now: number): number =>
  Math.max(1, Math.ceil((oldestAdmissionMs + windowMs - now) / 1000));

/** Process-local trailing sliding-window counters (tests, single-node fallback). */
export const RateLimiterMemory: Layer.Layer<RateLimiter> = Layer.sync(RateLimiter, () => {
  const admissions = new Map<string, Array<number>>();
  return RateLimiter.of({
    consume: (key, rule) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const windowMs = rule.windowSeconds * 1000;
        const cutoff = now - windowMs;
        const existing = admissions.get(key) ?? [];
        const live = existing.filter((ts) => ts > cutoff);
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
  });
});

/**
 * Shared trailing sliding-window counters in `auth.rate_limit`: one admission row per accepted
 * request (`edge:<key>#<id>`), serialized per key with a transaction-scoped advisory lock.
 * Active legacy fixed-window aggregate rows (`edge:<key>`) are counted alongside admission rows
 * until they age out, preserving active allowances across upgrades. Expired rows for the current
 * key and a bounded batch of expired idle edge rows are pruned in the same transaction; refused
 * requests write nothing.
 */
export const RateLimiterSql: Layer.Layer<RateLimiter, never, SqlClient.SqlClient> = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RateLimiter.of({
      consume: (key, rule) =>
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
                where (key = ${bucketKey} or starts_with(key, ${prefix}))
                  and last_request <= ${cutoff}`;
              yield* sql`
                delete from auth.rate_limit
                where id in (
                  select id from auth.rate_limit
                  where starts_with(key, 'edge:') and last_request <= ${idleCutoff}
                  limit ${IDLE_PRUNE_LIMIT}
                )`;
              const admissions = yield* sql<{
                count: number | string;
                last_request: string | number;
              }>`
                select count, last_request from auth.rate_limit
                where starts_with(key, ${prefix})
                order by last_request asc`;
              const [aggregate] = yield* sql<{
                count: number | string;
                last_request: string | number;
              }>`
                select count, last_request from auth.rate_limit
                where key = ${bucketKey}`;
              const aggregateCount =
                aggregate === undefined ? 0 : Math.max(0, Number(aggregate.count));
              const aggregateStart = aggregate === undefined ? now : Number(aggregate.last_request);
              let admissionsTotal = 0;
              let admissionsFromStart = 0;
              for (const row of admissions) {
                const weight = Math.max(0, Number(row.count));
                const ts = Number(row.last_request);
                admissionsTotal += weight;
                if (ts >= aggregateStart) {
                  admissionsFromStart += weight;
                }
              }
              // Only admissions at or after `aggregateStart` are reflected in `aggregate.count`.
              // When a legacy instance resets `edge:<key>` on rollover while newer `#<id>` rows
              // remain live, `admissionsFromStart` excludes those older retained rows so the fresh
              // legacy admission is counted alongside them rather than absorbed.
              const legacyOnlyCount = Math.max(0, aggregateCount - admissionsFromStart);
              const totalLive = admissionsTotal + legacyOnlyCount;
              const oldestAdmission =
                admissions.length > 0 ? Number(admissions[0]?.last_request ?? now) : now;
              const legacyResetAfterRetained =
                legacyOnlyCount > 0 && admissions.length > 0 && aggregateStart > oldestAdmission;

              if (legacyResetAfterRetained) {
                yield* sql`
                  insert into auth.rate_limit (id, key, count, last_request)
                  values (${generateId()}, ${`${prefix}${generateId()}`}, ${legacyOnlyCount}, ${aggregateStart})`;
              }

              if (totalLive < rule.max) {
                yield* sql`
                  insert into auth.rate_limit (id, key, count, last_request)
                  values (${generateId()}, ${`${prefix}${generateId()}`}, 1, ${now})`;
                const nextCount = totalLive + 1;
                const nextWindowStart =
                  legacyOnlyCount > 0 && !legacyResetAfterRetained
                    ? Math.min(aggregateStart, oldestAdmission)
                    : oldestAdmission;
                yield* sql`
                  insert into auth.rate_limit (id, key, count, last_request)
                  values (${generateId()}, ${bucketKey}, ${nextCount}, ${nextWindowStart})
                  on conflict (key) do update set
                    count = ${nextCount},
                    last_request = ${nextWindowStart}`;
                return { allowed: true } as const;
              }
              if (legacyResetAfterRetained) {
                yield* sql`
                  insert into auth.rate_limit (id, key, count, last_request)
                  values (${generateId()}, ${bucketKey}, ${totalLive}, ${oldestAdmission})
                  on conflict (key) do update set
                    count = ${totalLive},
                    last_request = ${oldestAdmission}`;
              }
              const slots: Array<{ readonly ts: number; readonly weight: number }> = admissions.map(
                (row) => ({ ts: Number(row.last_request), weight: Math.max(0, Number(row.count)) }),
              );
              if (legacyOnlyCount > 0) {
                slots.push({ ts: aggregateStart, weight: legacyOnlyCount });
                slots.sort((a, b) => a.ts - b.ts);
              }
              const excess = totalLive - rule.max;
              let seen = 0;
              let oldest = now;
              for (const slot of slots) {
                seen += slot.weight;
                if (seen > excess) {
                  oldest = slot.ts;
                  break;
                }
              }
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
    });
  }),
);
