import {
  type EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailSender,
  type OutboundEmail,
} from "@kvitbit/domain/ports";
import { Effect, Exit, Semaphore } from "effect";
import type { EmailSenderService } from "./shared";

export interface FallbackOptions {
  /**
   * Delivered keys remembered so a late retry stays on the provider that sent it; the oldest
   * are forgotten first. Keys whose outcome is still unknown are never forgotten.
   */
  readonly maxDeliveredKeys?: number;
}

type Provider = "primary" | "secondary";

/**
 * Where a key's message may already be:
 * - `unknown`: a send to `provider` may have taken it (unknown outcome or interrupted);
 * - `delivered`: `provider` accepted it.
 * A key with no entry is held by no provider, so either may be tried.
 */
type Holder = { readonly provider: Provider; readonly state: "unknown" | "delivered" };

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
export const makeFallbackEmailSender = (
  primary: EmailSenderService,
  secondary: EmailSenderService,
  options: FallbackOptions = {},
): EmailSenderService => {
  const maxDeliveredKeys = options.maxDeliveredKeys ?? 10_000;
  const holders = new Map<string, Holder>();
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  const record = (key: string, holder: Holder | undefined) => {
    holders.delete(key);
    if (holder === undefined) return;
    holders.set(key, holder);
    if (holder.state !== "delivered") return;
    let delivered = 0;
    for (const entry of holders.values()) if (entry.state === "delivered") delivered++;
    for (const [oldKey, entry] of holders) {
      if (delivered <= maxDeliveredKeys) break;
      if (entry.state === "delivered") {
        holders.delete(oldKey);
        delivered--;
      }
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
        Effect.sync(() => {
          const key = opts.idempotencyKey;
          const held = holders.get(key);
          if (Exit.isSuccess(exit)) return record(key, { provider, state: "delivered" });
          const tags = exit.cause.reasons.map((reason) =>
            "error" in reason ? reason.error._tag : reason._tag,
          );
          if (tags.some((tag) => mayHaveSent.has(tag))) {
            if (held?.state !== "delivered") record(key, { provider, state: "unknown" });
          }
          // EmailNotAccepted and EmailRejected leave an earlier holder in place.
        }),
      ),
    );

  const mayHaveSent = new Set(["EmailOutcomeUnknown", "Interrupt", "Die"]);

  const stillUnknown = (cause: EmailNotAccepted) =>
    new EmailOutcomeUnknown({ cause: { retryRefused: cause, earlierAttemptMayHaveSent: true } });

  return EmailSender.of({
    send: (message, opts) =>
      serialized(
        opts.idempotencyKey,
        Effect.suspend(() => {
          const held = holders.get(opts.idempotencyKey);
          if (held !== undefined) {
            return attempt(held.provider, message, opts).pipe(
              Effect.catchTag("EmailNotAccepted", (error) => Effect.fail(stillUnknown(error))),
            );
          }
          return attempt("primary", message, opts).pipe(
            Effect.catchTag("EmailNotAccepted", () => attempt("secondary", message, opts)),
          );
        }),
      ),
  });
};
