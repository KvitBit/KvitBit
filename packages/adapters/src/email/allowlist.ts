import { EmailSender, type OutboundEmail } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type EmailSenderService, recipientDomain } from "./shared";

export interface AllowlistConfig {
  /** Recipient domains that may receive real mail, matched exactly and case-insensitively. */
  readonly allow: ReadonlyArray<string>;
  /** Where recipients outside the allowlist go instead, typically a capture sender. */
  readonly capture: EmailSenderService;
}

/**
 * Non-production guard: delivers through `inner` only to recipients whose domain is on the
 * allowlist and hands every other recipient to `capture`.
 * - all recipients allowed: `inner` gets the message unchanged;
 * - none allowed: only `capture` gets it;
 * - mixed: `inner` gets the message with only the allowed recipients (an allowed cc is
 *   promoted to `to` when no `to` is allowed), and `capture` gets it addressed to the rest.
 * The result is the `inner` result whenever `inner` sent, else the capture result.
 */
export const makeAllowlistEmailSender: {
  (config: AllowlistConfig): (inner: EmailSenderService) => EmailSenderService;
  (inner: EmailSenderService, config: AllowlistConfig): EmailSenderService;
} = Fn.dual(2, (inner: EmailSenderService, config: AllowlistConfig): EmailSenderService => {
  const allowed = new Set<string>(
    Arr.map(config.allow, (domain) => Str.toLowerCase(Str.trim(domain))),
  );
  const isAllowed = (recipient: string) => {
    const domain = recipientDomain(recipient);
    return domain !== undefined && allowed.has(domain);
  };
  return EmailSender.of({
    send: Effect.fn("AllowlistEmailSender.send")(
      (message: OutboundEmail, opts: Parameters<EmailSenderService["send"]>[1]) => {
        const cc = message.cc ?? [];
        const keptTo = Arr.filter(message.to, isAllowed);
        const heldTo = Arr.filter(message.to, (recipient) => !isAllowed(recipient));
        const keptCc = Arr.filter(cc, isAllowed);
        const heldCc = Arr.filter(cc, (recipient) => !isAllowed(recipient));
        const anyKept = keptTo.length + keptCc.length > 0;
        const anyHeld = heldTo.length + heldCc.length > 0;
        if (!anyKept) return config.capture.send(message, opts);
        if (!anyHeld) return inner.send(message, opts);
        const delivered: OutboundEmail =
          keptTo.length > 0
            ? { ...message, to: keptTo, cc: keptCc }
            : { ...message, to: keptCc, cc: [] };
        const held: OutboundEmail =
          heldTo.length > 0
            ? { ...message, to: heldTo, cc: heldCc }
            : { ...message, to: heldCc, cc: [] };
        return config.capture.send(held, opts).pipe(Effect.andThen(inner.send(delivered, opts)));
      },
    ),
  });
});
