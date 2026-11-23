import { createHash } from "node:crypto";
import type { EmailSender } from "@kvitbit/domain/ports";

/** The implementation an `EmailSender` layer provides. */
export type EmailSenderService = EmailSender["Service"];

/** The bare address of a recipient written as `addr@host` or `Name <addr@host>`. */
export const bareAddress = (recipient: string): string => {
  const angle = /<([^<>]*)>\s*$/.exec(recipient);
  return (angle?.[1] ?? recipient).trim();
};

/** The lower-cased domain of a recipient, or `undefined` when it has none. */
export const recipientDomain = (recipient: string): string | undefined => {
  const address = bareAddress(recipient);
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return undefined;
  return address.slice(at + 1).toLowerCase();
};

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/**
 * The key itself when it is at most `maxLength` characters of `allowed`, else
 * `sha256-<hex digest>`. Distinct keys stay distinct and a retry with the same
 * key yields the same token.
 */
export const boundedToken = (key: string, maxLength: number, allowed: RegExp): string =>
  key.length > 0 && key.length <= maxLength && allowed.test(key) ? key : `sha256-${sha256Hex(key)}`;
