/**
 * Per-email rate limit for the bot-protected Better Auth endpoints (http-mcp-contracts
 * section 2.5: 5 per minute per email). Better Auth's own `rateLimit` keys by IP only, so this
 * limiter shares its `auth.rate_limit` table under `email:`-prefixed keys.
 *
 * One allowance per normalized address covers all the protected routes, and it is rolling:
 * the generic cell rate algorithm (GCRA) admits at most `max` requests in any `windowSeconds`
 * span. The row's `last_request` holds the theoretical arrival time (TAT) in epoch
 * milliseconds and `count` the admitted requests; one conditional upsert decides and records
 * a request, so concurrent requests cannot both slip under the limit, and a refused request
 * changes nothing.
 */
import { Clock, Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { generateId } from "./ids";

export interface EmailRateLimitRule {
  readonly windowSeconds: number;
  readonly max: number;
}

export const EMAIL_RATE_LIMIT: EmailRateLimitRule = { windowSeconds: 60, max: 5 };

export class EmailRateLimitUnavailable extends Data.TaggedError("EmailRateLimitUnavailable")<{
  readonly cause?: unknown;
}> {}

export type EmailRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface EmailRateLimiter {
  /** Counts one request for `email` and says whether it is within the limit. */
  readonly consume: (
    email: string,
  ) => Effect.Effect<EmailRateLimitDecision, EmailRateLimitUnavailable>;
}

/** Row key: the trimmed, lowercased address. */
export const emailRateLimitKey = (email: string): string => `email:${email.trim().toLowerCase()}`;

/** Rolling per-email limiter over `auth.rate_limit` of the given `SqlClient`. */
export const makeEmailRateLimiter = (
  rule: EmailRateLimitRule = EMAIL_RATE_LIMIT,
): Effect.Effect<EmailRateLimiter, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Emission interval: one request "costs" this much time; the burst tolerance lets `max`
    // requests arrive at once, after which they are spaced by the interval.
    const intervalMs = Math.ceil((rule.windowSeconds * 1000) / rule.max);
    const toleranceMs = rule.windowSeconds * 1000 - intervalMs;
    const consume = (email: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const key = emailRateLimitKey(email);
        const admitted = yield* sql<{ tat: number | string }>`
          insert into auth.rate_limit (id, key, count, last_request)
          values (${generateId()}, ${key}, 1, ${now + intervalMs})
          on conflict (key) do update set
            last_request = greatest(auth.rate_limit.last_request, ${now}) + ${intervalMs},
            count = auth.rate_limit.count + 1
          where greatest(auth.rate_limit.last_request, ${now}) - ${now} <= ${toleranceMs}
          returning last_request as tat`;
        if (admitted.length > 0) return { allowed: true } as const;
        const rows = yield* sql<{ tat: number | string }>`
          select last_request as tat from auth.rate_limit where key = ${key}`;
        const tat = Number(rows[0]?.tat ?? now);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((tat - now - toleranceMs) / 1000)),
        } as const;
      }).pipe(Effect.mapError((cause) => new EmailRateLimitUnavailable({ cause })));
    return { consume };
  });
