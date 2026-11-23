/**
 * SMTP sender over nodemailer. One attempt per call; nodemailer's own connection, greeting and
 * socket timeouts bound it. The idempotency key becomes the Message-ID, so a retry after an
 * unknown outcome carries the same Message-ID and receivers can drop the duplicate.
 */
import {
  EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailRejected,
  EmailSender,
  type OutboundEmail,
} from "@kvitbit/domain/ports";
import { Effect, Layer } from "effect";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { bareAddress, boundedToken, type EmailSenderService } from "./shared";

/** The nodemailer mail fields this sender sets. */
export interface SmtpMail {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly replyTo: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly messageId: string;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly contentType: string;
    readonly content: Buffer;
  }>;
  readonly headers: Readonly<Record<string, string>>;
}

/** The slice of a nodemailer `Transporter` the sender uses; tests pass a fake. */
export interface SmtpTransport {
  readonly sendMail: (mail: SmtpMail) => Promise<{ readonly messageId: string }>;
}

export interface SmtpConfig {
  /** Sender, e.g. `Kvitbit <noreply@kvitbit.cz>`. */
  readonly from: string;
  /** Right-hand side of generated Message-IDs; defaults to the domain of `from`. */
  readonly messageIdDomain?: string;
}

export const SMTP_PROVIDER = "smtp";

const messageIdTokenPattern = /^[A-Za-z0-9._-]+$/;

/** `<key@domain>`, the key hashed when it has characters a Message-ID cannot carry or is long. */
export const smtpMessageId = (idempotencyKey: string, domain: string): string =>
  `<${boundedToken(idempotencyKey, 128, messageIdTokenPattern)}@${domain}>`;

const domainOf = (from: string): string => {
  const address = bareAddress(from);
  return address.slice(address.lastIndexOf("@") + 1) || "localhost";
};

export const smtpMail = (
  message: OutboundEmail,
  config: SmtpConfig,
  idempotencyKey: string,
): SmtpMail => ({
  from: config.from,
  to: message.to,
  ...(message.cc !== undefined && message.cc.length > 0 && { cc: message.cc }),
  replyTo: message.replyTo,
  subject: message.subject,
  html: message.html,
  text: message.text,
  messageId: smtpMessageId(idempotencyKey, config.messageIdDomain ?? domainOf(config.from)),
  attachments: message.attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: Buffer.from(attachment.bytes),
  })),
  headers: Object.fromEntries(
    Object.entries(message.tags).map(([name, value]) => [
      `X-Kvitbit-Tag-${name.replace(/[^A-Za-z0-9-]/g, "-")}`,
      value.replace(/[\r\n]+/g, " "),
    ]),
  ),
});

type SendError = EmailRejected | EmailNotAccepted | EmailOutcomeUnknown;

/** Timeouts that fire before the server could have taken the message. */
const setupTimeouts = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

/** Codes for failures during connection setup, authentication or configuration. */
const setupCodes = new Set([
  "EDNS",
  "ETLS",
  "EAUTH",
  "ENOAUTH",
  "EOAUTH2",
  "EPROXY",
  "ECONFIG",
  "EREQUIRETLS",
  "EMAXLIMIT",
]);

/** System codes nodemailer keeps as `originalCode` that mean no connection was made. */
const unconnectedCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const field = (error: unknown, name: string): unknown =>
  typeof error === "object" && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;

/**
 * Classifies a nodemailer failure:
 * - an SMTP 5xx reply is permanent (Rejected), except a 5xx to AUTH, which is a provider
 *   configuration failure another provider can recover from (NotAccepted);
 * - an SMTP 4xx reply is transient: the server did not take the message (NotAccepted);
 * - failures while connecting, upgrading TLS or authenticating, and connect/greeting/TLS
 *   timeouts, happen before any message was sent (NotAccepted);
 * - envelope or message errors without a reply are the message's fault (Rejected);
 * - socket timeouts and dropped connections can follow DATA (OutcomeUnknown), as can any
 *   unrecognised failure.
 */
export const classifySmtpError = (error: unknown): SendError => {
  const cause = error;
  const code = field(error, "code");
  const responseCode = field(error, "responseCode");
  if (typeof responseCode === "number") {
    if (responseCode >= 500) {
      return code === "EAUTH" ? new EmailNotAccepted({ cause }) : new EmailRejected({ cause });
    }
    if (responseCode >= 400) return new EmailNotAccepted({ cause });
  }
  if (code === "ETIMEDOUT") {
    const timeoutType = field(error, "timeoutType");
    return typeof timeoutType === "string" && setupTimeouts.has(timeoutType)
      ? new EmailNotAccepted({ cause })
      : new EmailOutcomeUnknown({ cause });
  }
  if (typeof code === "string" && setupCodes.has(code)) return new EmailNotAccepted({ cause });
  const originalCode = field(error, "originalCode") ?? code;
  if (typeof originalCode === "string" && unconnectedCodes.has(originalCode)) {
    return new EmailNotAccepted({ cause });
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") return new EmailRejected({ cause });
  return new EmailOutcomeUnknown({ cause });
};

export const makeSmtpEmailSender = (
  transport: SmtpTransport,
  config: SmtpConfig,
): EmailSenderService =>
  EmailSender.of({
    send: (message, { idempotencyKey }) =>
      Effect.tryPromise({
        try: () => transport.sendMail(smtpMail(message, config, idempotencyKey)),
        catch: classifySmtpError,
      }).pipe(
        Effect.map((info) => ({ provider: SMTP_PROVIDER, providerMessageId: info.messageId })),
        Effect.withSpan("SmtpEmailSender.send"),
      ),
  });

/** nodemailer SMTP transport options (host, port, secure, auth, timeouts). */
export type SmtpTransportOptions = SMTPTransport.Options;

/** `EmailSender` over a nodemailer SMTP transport; closes the transport on release. */
export const layerSmtp = (
  options: SmtpTransportOptions,
  config: SmtpConfig,
): Layer.Layer<EmailSender> =>
  Layer.effect(
    EmailSender,
    Effect.acquireRelease(
      Effect.sync(() => nodemailer.createTransport(options)),
      (transporter) => Effect.sync(() => transporter.close()),
    ).pipe(
      Effect.map((transporter) =>
        makeSmtpEmailSender(
          {
            sendMail: ({ to, cc, attachments, headers, ...rest }) =>
              transporter.sendMail({
                ...rest,
                to: [...to],
                ...(cc !== undefined && { cc: [...cc] }),
                attachments: attachments.map((attachment) => ({ ...attachment })),
                headers: { ...headers },
              }),
          },
          config,
        ),
      ),
    ),
  );
