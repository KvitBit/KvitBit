// Provider key helpers need a synchronous SHA-256 digest.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type { EmailSender } from "@kvitbit/domain/ports";

import * as Option from "effect/Option";
import * as Str from "effect/String";

/** The implementation an `EmailSender` layer provides. */
export type EmailSenderService = EmailSender["Service"];

/** One address: no whitespace, separators, quotes, brackets or second `@`. */
const addressPattern = /^[^\s<>,;:"()[\]\\@]+@[^\s<>,;:"()[\]\\@]+$/;
/** `Name <address>` with an unquoted display name free of separators and brackets. */
const namedPattern = /^[^<>,;:"()[\]\\@]*<([^<>]*)>$/;
const bareAddressPattern = /<([^<>]*)>\s*$/;

/**
 * The address of a recipient written as exactly one mailbox, `addr@host` or `Name <addr@host>`,
 * else `undefined`. Anything a mail library could read as several mailboxes (commas,
 * semicolons, groups, quoted names, comments) is refused, so guards fail closed.
 */
export const singleMailbox = (recipient: string): string | undefined => {
  const trimmed = Str.trim(recipient);
  const named = namedPattern.exec(trimmed);
  const address = Str.trim(named?.[1] ?? trimmed);
  return addressPattern.test(address) ? address : undefined;
};

/** The lower-cased domain of a single-mailbox recipient, else `undefined`. */
export const recipientDomain = (recipient: string): string | undefined => {
  const address = singleMailbox(recipient);
  return address === undefined ? undefined : Str.toLowerCase(mailboxDomain(address));
};

export const mailboxDomain = (address: string): string =>
  Str.slice(Option.getOrElse(Str.lastIndexOf("@")(address), () => -1) + 1)(address);

/** The bare address of a configured sender such as `Kvitbit <noreply@kvitbit.cz>`. */
export const bareAddress = (recipient: string): string => {
  const angle = bareAddressPattern.exec(recipient);
  return Str.trim(angle?.[1] ?? recipient);
};

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/**
 * The key itself when it is at most `maxLength` characters of `allowed`, else
 * `sha256-<hex digest>`. Distinct keys stay distinct and a retry with the same
 * key yields the same token.
 */
export const boundedToken =
  ({ maxLength, allowed }: { maxLength: number; allowed: RegExp }) =>
  (key: string): string =>
    key.length > 0 && key.length <= maxLength && allowed.test(key)
      ? key
      : `sha256-${sha256Hex(key)}`;
