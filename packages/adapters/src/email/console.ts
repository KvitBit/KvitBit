import { EmailSender, type OutboundEmail } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EmailSenderService } from "./shared";

export const CONSOLE_PROVIDER = "console";

/** Development sender: logs the envelope and plain-text body through Effect's logger. */
export const makeConsoleEmailSender = (): EmailSenderService =>
  EmailSender.of({
    send: Effect.fn("ConsoleEmailSender.send")(
      (message: OutboundEmail, { idempotencyKey }: Parameters<EmailSenderService["send"]>[1]) =>
        Effect.log(`Email (not sent): ${message.subject}`).pipe(
          Effect.annotateLogs({
            to: Arr.join(message.to, ", "),
            cc: Arr.join(message.cc ?? [], ", "),
            replyTo: message.replyTo,
            attachments: Arr.join(
              Arr.map(message.attachments, (a) => a.filename),
              ", ",
            ),
            idempotencyKey,
            text: message.text,
          }),
          Effect.as({ provider: CONSOLE_PROVIDER, providerMessageId: idempotencyKey }),
        ),
    ),
  });

export const layerConsole: Layer.Layer<EmailSender> = Layer.sync(
  EmailSender,
  makeConsoleEmailSender,
);
