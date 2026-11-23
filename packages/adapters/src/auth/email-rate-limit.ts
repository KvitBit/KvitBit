/**
 * Per-email rate limit for the bot-protected Better Auth endpoints (http-mcp-contracts
 * section 2.5: 5 per minute per email). Better Auth's own `rateLimit` keys by IP only, so this
 * counter shares its `auth.rate_limit` table under `email:`-prefixed keys and consumes with one
 * atomic upsert, so concurrent requests cannot both slip under the limit.
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
  /** Counts one request for `email` on `path` and says whether it is within the limit. */
  readonly consume: (
    path: string,
    email: string,
  ) => Effect.Effect<EmailRateLimitDecision, EmailRateLimitUnavailable>;
}

/** Row key: path plus the trimmed, lowercased address. */
export const emailRateLimitKey = (path: string, email: string): string =>
  `email:${path}:${email.trim().toLowerCase()}`;

/** Fixed-window counter over `auth.rate_limit` of the given `SqlClient`. */
export const makeEmailRateLimiter = (
  rule: EmailRateLimitRule = EMAIL_RATE_LIMIT,
): Effect.Effect<EmailRateLimiter, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const windowMs = rule.windowSeconds * 1000;
    const consume = (path: string, email: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const key = emailRateLimitKey(path, email);
        // A row whose window has passed restarts at 1; otherwise the count goes up by one.
        const rows = yield* sql<{ count: number; last_request: number | string }>`
          insert into auth.rate_limit (id, key, count, last_request)
          values (${generateId()}, ${key}, 1, ${now})
          on conflict (key) do update set
            count = case when auth.rate_limit.last_request <= ${now - windowMs}
              then 1 else auth.rate_limit.count + 1 end,
            last_request = case when auth.rate_limit.last_request <= ${now - windowMs}
              then ${now} else auth.rate_limit.last_request end
          returning count, last_request`;
        const row = rows[0];
        if (row === undefined || row.count <= rule.max) return { allowed: true } as const;
        const retryAfterMs = Number(row.last_request) + windowMs - now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        } as const;
      }).pipe(Effect.mapError((cause) => new EmailRateLimitUnavailable({ cause })));
    return { consume };
  });
