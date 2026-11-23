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
  readonly sendMail: (mail: SmtpMail) => Promise<SmtpSendInfo>;
}

/** What nodemailer resolves with; `accepted`/`rejected` list recipients by server answer. */
export interface SmtpSendInfo {
  readonly messageId: string;
  readonly accepted?: ReadonlyArray<unknown>;
  readonly rejected?: ReadonlyArray<unknown>;
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

/** Commands whose 5xx reply refuses this message rather than the session. */
const messageStageCommand = /^(MAIL FROM|RCPT TO|DATA|BDAT)\b/i;

/**
 * Classifies a nodemailer failure:
 * - a 5xx reply to MAIL FROM, RCPT TO or DATA (or an envelope/message error carrying one)
 *   refuses the message permanently (Rejected); 530 "authentication required" is the
 *   provider's configuration, not the message (NotAccepted);
 * - a 5xx reply anywhere else (greeting, EHLO, STARTTLS, AUTH) fails the session before any
 *   message was handed over (NotAccepted);
 * - an SMTP 4xx reply is transient: the server did not take the message (NotAccepted);
 * - failures while connecting, upgrading TLS or authenticating, and connect/greeting/TLS
 *   timeouts, happen before any message was sent (NotAccepted);
 * - envelope or message errors without a reply are the message's fault (Rejected);
 * - socket timeouts and dropped connections can follow DATA (OutcomeUnknown), as can any
 *   unrecognised failure. nodemailer reports every timeout with command CONN, so a socket
 *   timeout before DATA cannot be told apart and is treated as unknown too.
 */
export const classifySmtpError = (error: unknown): SendError => {
  const cause = smtpCause(error);
  const code = field(error, "code");
  const command = field(error, "command");
  const responseCode = field(error, "responseCode");
  if (typeof responseCode === "number" && responseCode >= 500 && responseCode < 600) {
    const messageStage =
      code === "EENVELOPE" ||
      code === "EMESSAGE" ||
      (typeof command === "string" && messageStageCommand.test(command));
    return messageStage && responseCode !== 530 && code !== "EAUTH"
      ? new EmailRejected({ cause })
      : new EmailNotAccepted({ cause });
  }
  if (typeof responseCode === "number" && responseCode >= 400 && responseCode < 500) {
    return new EmailNotAccepted({ cause });
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
  if ((code === "EENVELOPE" || code === "EMESSAGE") && responseCode === undefined) {
    return new EmailRejected({ cause });
  }
  return new EmailOutcomeUnknown({ cause });
};

/** The diagnostic fields of a nodemailer error, without the message or credentials. */
const smtpCause = (error: unknown) =>
  Object.fromEntries(
    ["code", "originalCode", "command", "responseCode", "response", "timeoutType"]
      .map((name) => [name, field(error, name)] as const)
      .filter(([, value]) => value !== undefined && value !== false),
  );

/**
 * nodemailer resolves when at least one recipient was accepted. Some recipients already have
 * the message, so a partial refusal is never retryable: it succeeds with a warning. A
 * resolution that lists no accepted recipient but some rejected ones is a rejection.
 */
const checkRecipients = (info: SmtpSendInfo): Effect.Effect<SmtpSendInfo, EmailRejected> => {
  const accepted = info.accepted?.length ?? 0;
  const rejected = info.rejected?.length ?? 0;
  if (rejected === 0) return Effect.succeed(info);
  if (accepted === 0) {
    return Effect.fail(new EmailRejected({ cause: { rejectedRecipients: rejected } }));
  }
  return Effect.logWarning("SMTP server refused some recipients").pipe(
    Effect.annotateLogs({ accepted, rejected, messageId: info.messageId }),
    Effect.as(info),
  );
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
        Effect.flatMap(checkRecipients),
        Effect.map((info) => ({ provider: SMTP_PROVIDER, providerMessageId: info.messageId })),
        Effect.withSpan("SmtpEmailSender.send"),
      ),
  });

/** Bounds used when the options leave them unset (nodemailer's socket default is 10 minutes). */
export const SMTP_DEFAULT_TIMEOUTS = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 60_000,
} as const;

/** nodemailer SMTP transport options (host, port, secure, auth, timeouts). */
export type SmtpTransportOptions = SMTPTransport.Options;

/**
 * `EmailSender` over a nodemailer SMTP transport; closes the transport on release. Use a plain
 * (non-pooled) transport: one connection per message keeps each failure tied to its message.
 */
export const layerSmtp = (
  options: SmtpTransportOptions,
  config: SmtpConfig,
): Layer.Layer<EmailSender> =>
  Layer.effect(
    EmailSender,
    Effect.acquireRelease(
      Effect.sync(() => nodemailer.createTransport({ ...SMTP_DEFAULT_TIMEOUTS, ...options })),
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
