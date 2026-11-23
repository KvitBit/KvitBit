import { EmailSender } from "@kvitbit/domain/ports";
import { Effect } from "effect";
import type { EmailSenderService } from "./shared";

export interface FallbackOptions {
  /** Idempotency keys remembered for provider pinning; oldest are forgotten first. */
  readonly maxPinnedKeys?: number;
}

type Pin = "primary" | "secondary";

/**
 * Sends through `primary` and fails over to `secondary`, with the same idempotency key, only
 * when `primary` certainly did not take the message (EmailNotAccepted). EmailOutcomeUnknown
 * and EmailRejected pass through.
 *
 * A key is pinned to the provider that may have it: once a provider answers anything but
 * EmailNotAccepted, later sends with that key (the caller's retries) go to that provider only,
 * so a message Resend may have accepted is not sent again over SMTP when a later Resend
 * attempt is refused.
 *
 * Limitation: pins live in this process's memory (bounded by `maxPinnedKeys`). A retry that
 * runs in another process or after a restart starts again from `primary`; durable pinning
 * needs the delivery record to store the provider.
 */
export const makeFallbackEmailSender = (
  primary: EmailSenderService,
  secondary: EmailSenderService,
  options: FallbackOptions = {},
): EmailSenderService => {
  const maxPinnedKeys = options.maxPinnedKeys ?? 10_000;
  const pins = new Map<string, Pin>();
  const pin = (key: string, provider: Pin) => {
    pins.delete(key);
    pins.set(key, provider);
    if (pins.size > maxPinnedKeys) {
      const oldest = pins.keys().next();
      if (oldest.done !== true) pins.delete(oldest.value);
    }
  };
  const through = (
    provider: Pin,
    message: Parameters<EmailSenderService["send"]>[0],
    opts: Parameters<EmailSenderService["send"]>[1],
  ) =>
    (provider === "primary" ? primary : secondary).send(message, opts).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag !== "EmailNotAccepted") pin(opts.idempotencyKey, provider);
        }),
      ),
      Effect.tap(() => Effect.sync(() => pin(opts.idempotencyKey, provider))),
    );
  return EmailSender.of({
    send: (message, opts) =>
      Effect.suspend(() => {
        const pinned = pins.get(opts.idempotencyKey);
        if (pinned !== undefined) return through(pinned, message, opts);
        return through("primary", message, opts).pipe(
          Effect.catchTag("EmailNotAccepted", () => through("secondary", message, opts)),
        );
      }),
  });
};
