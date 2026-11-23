import { EmailSender } from "@kvitbit/domain/ports";
import { Effect, Layer } from "effect";
import type { EmailSenderService } from "./shared";

export const CONSOLE_PROVIDER = "console";

/** Development sender: logs the envelope and plain-text body through Effect's logger. */
export const makeConsoleEmailSender = (): EmailSenderService =>
  EmailSender.of({
    send: (message, { idempotencyKey }) =>
      Effect.log(`Email (not sent): ${message.subject}`).pipe(
        Effect.annotateLogs({
          to: message.to.join(", "),
          cc: (message.cc ?? []).join(", "),
          replyTo: message.replyTo,
          attachments: message.attachments.map((a) => a.filename).join(", "),
          idempotencyKey,
          text: message.text,
        }),
        Effect.as({ provider: CONSOLE_PROVIDER, providerMessageId: idempotencyKey }),
      ),
  });

export const layerConsole: Layer.Layer<EmailSender> = Layer.sync(
  EmailSender,
  makeConsoleEmailSender,
);
