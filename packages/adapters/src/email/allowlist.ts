import { EmailSender, type OutboundEmail } from "@kvitbit/domain/ports";
import { Effect } from "effect";
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
export const makeAllowlistEmailSender = (
  inner: EmailSenderService,
  config: AllowlistConfig,
): EmailSenderService => {
  const allowed = new Set(config.allow.map((domain) => domain.trim().toLowerCase()));
  const isAllowed = (recipient: string) => {
    const domain = recipientDomain(recipient);
    return domain !== undefined && allowed.has(domain);
  };
  return EmailSender.of({
    send: (message, opts) => {
      const cc = message.cc ?? [];
      const to = {
        kept: message.to.filter(isAllowed),
        held: message.to.filter((r) => !isAllowed(r)),
      };
      const copy = { kept: cc.filter(isAllowed), held: cc.filter((r) => !isAllowed(r)) };
      const anyKept = to.kept.length + copy.kept.length > 0;
      const anyHeld = to.held.length + copy.held.length > 0;
      if (!anyKept) return config.capture.send(message, opts);
      if (!anyHeld) return inner.send(message, opts);
      const delivered: OutboundEmail =
        to.kept.length > 0
          ? { ...message, to: to.kept, cc: copy.kept }
          : { ...message, to: copy.kept, cc: [] };
      const held: OutboundEmail =
        to.held.length > 0
          ? { ...message, to: to.held, cc: copy.held }
          : { ...message, to: copy.held, cc: [] };
      return config.capture.send(held, opts).pipe(Effect.andThen(inner.send(delivered, opts)));
    },
  });
};
