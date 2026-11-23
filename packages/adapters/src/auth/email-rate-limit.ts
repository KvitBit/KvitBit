/**
 * Per-email rate limit for the bot-protected Better Auth endpoints (http-mcp-contracts
 * section 2.5: 5 per minute per email). Better Auth's own `rateLimit` keys by IP only, so this
 * limiter shares its `auth.rate_limit` table under `email:`-prefixed keys.
 *
 * One allowance per normalized address covers all the protected routes, over a sliding
 * window: at most `max` admissions in any trailing `windowSeconds`. Each admission is its own
 * row (`key` = `email:<address>#<id>`, `last_request` = admission time in epoch ms). A
 * transaction-scoped advisory lock on the address serializes concurrent requests for it, so
 * counting and inserting are atomic; the address's expired rows are deleted in the same
 * transaction, and a refused request writes nothing.
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

/** Address key: the trimmed, lowercased address; admission rows extend it with `#<id>`. */
export const emailRateLimitKey = (email: string): string => `email:${email.trim().toLowerCase()}`;

/** Rolling per-email limiter over `auth.rate_limit` of the given `SqlClient`. */
export const makeEmailRateLimiter = (
  rule: EmailRateLimitRule = EMAIL_RATE_LIMIT,
): Effect.Effect<EmailRateLimiter, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const windowMs = rule.windowSeconds * 1000;
    const consume = (email: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const address = emailRateLimitKey(email);
            const prefix = `${address}#`;
            yield* sql`select pg_advisory_xact_lock(hashtextextended(${address}, 0))`;
            yield* sql`
              delete from auth.rate_limit
              where starts_with(key, ${prefix}) and last_request <= ${now - windowMs}`;
            const live = yield* sql<{ last_request: number | string }>`
              select last_request from auth.rate_limit
              where starts_with(key, ${prefix})
              order by last_request asc`;
            if (live.length < rule.max) {
              yield* sql`
                insert into auth.rate_limit (id, key, count, last_request)
                values (${generateId()}, ${`${prefix}${generateId()}`}, 1, ${now})`;
              return { allowed: true } as const;
            }
            // Free again when the oldest admission still in the window leaves it.
            const oldest = Number(live[live.length - rule.max]?.last_request ?? now);
            return {
              allowed: false,
              retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
            } as const;
          }),
        )
        .pipe(Effect.mapError((cause) => new EmailRateLimitUnavailable({ cause })));
    return { consume };
  });
