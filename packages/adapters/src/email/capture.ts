import { EmailSender, type OutboundEmail } from "@kvitbit/domain/ports";
import { Effect, Layer, Ref } from "effect";
import type { EmailSenderService } from "./shared";

export interface CapturedEmail {
  readonly message: OutboundEmail;
  readonly idempotencyKey: string;
  readonly providerMessageId: string;
}

/** A sender that records messages instead of delivering them, plus access to the record. */
export interface CaptureEmailSender extends EmailSenderService {
  /** Captured messages in send order; a repeated idempotency key is recorded once. */
  readonly captured: Effect.Effect<ReadonlyArray<CapturedEmail>>;
  readonly clear: Effect.Effect<void>;
}

export const CAPTURE_PROVIDER = "capture";

/**
 * Records every message and succeeds. Like Resend, a repeated idempotency key returns the
 * first send's id without recording the message again.
 */
export const makeCaptureEmailSender: Effect.Effect<CaptureEmailSender> = Effect.gen(function* () {
  const store = yield* Ref.make<ReadonlyArray<CapturedEmail>>([]);
  const send: EmailSenderService["send"] = (message, { idempotencyKey }) =>
    Ref.modify(store, (entries) => {
      const previous = entries.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (previous !== undefined) return [previous.providerMessageId, entries];
      const providerMessageId = `${CAPTURE_PROVIDER}-${entries.length + 1}`;
      return [providerMessageId, [...entries, { message, idempotencyKey, providerMessageId }]];
    }).pipe(Effect.map((providerMessageId) => ({ provider: CAPTURE_PROVIDER, providerMessageId })));
  return { send, captured: Ref.get(store), clear: Ref.set(store, []) };
});

/** `EmailSender` that captures; tests read the record through `capture`. */
export const layerCapture = (capture: CaptureEmailSender): Layer.Layer<EmailSender> =>
  Layer.succeed(EmailSender, EmailSender.of({ send: capture.send }));
