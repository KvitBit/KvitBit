import { EmailSender } from "@kvitbit/domain/ports";
import { Effect } from "effect";
import type { EmailSenderService } from "./shared";

/**
 * Sends through `primary` and fails over to `secondary`, with the same idempotency key, only
 * when `primary` certainly did not take the message (EmailNotAccepted). EmailOutcomeUnknown
 * and EmailRejected pass through, so a message Resend may have accepted is never sent again
 * over SMTP.
 */
export const makeFallbackEmailSender = (
  primary: EmailSenderService,
  secondary: EmailSenderService,
): EmailSenderService =>
  EmailSender.of({
    send: (message, opts) =>
      primary
        .send(message, opts)
        .pipe(Effect.catchTag("EmailNotAccepted", () => secondary.send(message, opts))),
  });
