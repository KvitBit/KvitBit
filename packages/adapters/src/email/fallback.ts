import {
  type EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailSender,
  type OutboundEmail,
} from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import type { EmailSenderService } from "./shared";

export interface FallbackOptions {
  /**
   * How long a delivered key stays pinned to the provider that accepted it, so retries within
   * this window never reach the other provider, however many other messages are sent. Keys
   * whose outcome is still unknown are never forgotten. Defaults to 7 days; set it to at least
   * the caller's retry window.
   */
  readonly deliveredRetention?: Duration.Input;
}

type Provider = "primary" | "secondary";

/**
 * Where a key's message may already be:
 * - `unknown`: a send to `provider` may have taken it (unknown outcome or interrupted);
 * - `delivered`: `provider` accepted it.
 * A key with no entry is held by no provider, so either may be tried.
 */
interface Holder {
  readonly provider: Provider;
  readonly state: "unknown" | "delivered";
  readonly at: number;
}

/**
 * Sends through `primary` and fails over to `secondary`, with the same idempotency key, only
 * when `primary` certainly did not take the message (EmailNotAccepted). EmailOutcomeUnknown
 * and EmailRejected pass through.
 *
 * Once a provider may hold a key (an unknown outcome, an interrupted send, or an accepted
 * send), every later send with that key goes to that provider only, and its EmailNotAccepted
 * is reported as EmailOutcomeUnknown: the retry was refused, but the earlier attempt may still
 * have been delivered, so failing over (by this sender or its caller) is not safe. Sends with
 * the same key run one at a time, so an overlapping send sees the first one's outcome.
 *
 * Limitation: this state lives in the process's memory. A retry in another process or after a
 * restart starts again from `primary`; durable routing needs the delivery record to store the
 * provider.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off A curried secondary and its options can also satisfy the positional sender signature.
export function makeFallbackEmailSender(
  primary: EmailSenderService,
  secondary: EmailSenderService,
  options: FallbackOptions = {},
): EmailSenderService {
  const retentionMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options.deliveredRetention ?? Duration.days(7)),
  );
  const holders = new Map<string, Holder>();
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  /**
   * Sets a key's holder and forgets delivered keys older than the retention. Entries are kept
   * in the order they were recorded, so the sweep stops at the first delivered key that is
   * still fresh; unknown keys are skipped, never removed.
   */
  const record = (key: string, holder: Holder) => {
    holders.delete(key);
    holders.set(key, holder);
    for (const [oldKey, entry] of holders) {
      if (entry.state !== "delivered") continue;
      if (holder.at - entry.at < retentionMillis) break;
      holders.delete(oldKey);
    }
  };

  /** Runs `effect` holding the key's lock; the lock is dropped once no send uses it. */
  const serialized = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lock.users++;
        locks.set(key, lock);
        return lock;
      }),
      (lock) => Semaphore.withPermit(lock.semaphore, effect),
      (lock) =>
        Effect.sync(() => {
          lock.users--;
          if (lock.users === 0) locks.delete(key);
        }),
    );

  type Message = OutboundEmail;
  type Opts = Parameters<EmailSenderService["send"]>[1];

  /** One send to `provider`, recording what its outcome says about where the message is. */
  const attempt = (provider: Provider, message: Message, opts: Opts) =>
    (provider === "primary" ? primary : secondary).send(message, opts).pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            const key = opts.idempotencyKey;
            if (Exit.isSuccess(exit)) return record(key, { provider, state: "delivered", at });
            const tags = Arr.map(exit.cause.reasons, (reason) =>
              "error" in reason ? reason.error._tag : reason._tag,
            );
            if (Arr.some(tags, (tag) => mayHaveSent.has(tag))) {
              // An attempt that may have sent pins the key with no expiry, even over an
              // earlier delivery whose retention is running out.
              record(key, { provider, state: "unknown", at });
            }
            // EmailNotAccepted and EmailRejected leave an earlier holder in place.
          }),
        ),
      ),
    );

  const mayHaveSent = new Set(["EmailOutcomeUnknown", "Interrupt", "Die"]);

  const stillUnknown = (cause: EmailNotAccepted) =>
    new EmailOutcomeUnknown({ cause: { retryRefused: cause, earlierAttemptMayHaveSent: true } });

  return EmailSender.of({
    send: Effect.fn("FallbackEmailSender.send")((message: OutboundEmail, opts: Opts) =>
      serialized(
        opts.idempotencyKey,
        Effect.suspend(() => {
          const held = holders.get(opts.idempotencyKey);
          if (held !== undefined) {
            return attempt(held.provider, message, opts).pipe(
              Effect.catchTag("EmailNotAccepted", (error) => error.pipe(stillUnknown, Effect.fail)),
              // Whatever made this send unknown, the caller will retry it: keep the key on its
              // provider with no expiry, replacing an expiring `delivered` entry.
              Effect.tapErrorTag("EmailOutcomeUnknown", () =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) =>
                    Effect.sync(() =>
                      record(opts.idempotencyKey, {
                        provider: held.provider,
                        state: "unknown",
                        at,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }
          return attempt("primary", message, opts).pipe(
            Effect.catchTag("EmailNotAccepted", () => attempt("secondary", message, opts)),
          );
        }),
      ),
    ),
  });
}
