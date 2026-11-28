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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { bareAddress, boundedToken, type EmailSenderService, mailboxDomain } from "./shared";

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

const headerNamePattern = /[^A-Za-z0-9-]/g;
const headerNewlines = /[\r\n]+/g;
const messageIdTokenPattern = /^[A-Za-z0-9._-]+$/;

/** `<key@domain>`, the key hashed when it has characters a Message-ID cannot carry or is long. */
export const smtpMessageId: {
  (domain: string): (idempotencyKey: string) => string;
  (idempotencyKey: string, domain: string): string;
} = Fn.dual(
  2,
  (idempotencyKey: string, domain: string): string =>
    `<${boundedToken({ maxLength: 128, allowed: messageIdTokenPattern })(idempotencyKey)}@${domain}>`,
);

const domainOf = (from: string): string => mailboxDomain(bareAddress(from)) || "localhost";

export const smtpMail: {
  (config: SmtpConfig, idempotencyKey: string): (message: OutboundEmail) => SmtpMail;
  (message: OutboundEmail, config: SmtpConfig, idempotencyKey: string): SmtpMail;
} = Fn.dual(
  3,
  (message: OutboundEmail, config: SmtpConfig, idempotencyKey: string): SmtpMail => ({
    from: config.from,
    to: message.to,
    ...(message.cc !== undefined && message.cc.length > 0 && { cc: message.cc }),
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
    messageId: smtpMessageId(idempotencyKey, config.messageIdDomain ?? domainOf(config.from)),
    attachments: Arr.map(message.attachments, (attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.bytes),
    })),
    headers: Rec.fromEntries(
      Arr.map(Rec.toEntries(message.tags), ([name, value]) => [
        `X-Kvitbit-Tag-${Str.replace(headerNamePattern, "-")(name)}`,
        Str.replace(headerNewlines, " ")(value),
      ]),
    ),
  }),
);

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

/** System codes nodemailer keeps as `originalCode` that mean no SMTP session was established. */
const unconnectedCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // TLS certificate verification (OpenSSL X509 verify results) fails during the handshake,
  // before any SMTP command.
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

// Keep the diagnostic values as supplied by nodemailer. The classifier checks each value it uses.
const smtpErrorFields = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  originalCode: Schema.optional(Schema.Unknown),
  command: Schema.optional(Schema.Unknown),
  responseCode: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.Unknown),
  timeoutType: Schema.optional(Schema.Unknown),
});
const decodeSmtpError = Schema.decodeUnknownOption(smtpErrorFields);
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Finite);

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
export const classifySmtpError = Fn.flow(decodeSmtpError, (decoded): SendError => {
  const fields = Option.getOrElse(decoded, () => smtpErrorFields.make({}));
  const { code, originalCode, command, responseCode, response, timeoutType } = fields;
  const cause = Rec.filter(
    { code, originalCode, command, responseCode, response, timeoutType },
    (value) => value !== undefined && value !== false,
  );
  if (isNumber(responseCode) && responseCode >= 500 && responseCode < 600) {
    const messageStage =
      code === "EENVELOPE" ||
      code === "EMESSAGE" ||
      (isString(command) && messageStageCommand.test(command));
    return messageStage && responseCode !== 530 && code !== "EAUTH"
      ? EmailRejected.make({ cause })
      : EmailNotAccepted.make({ cause });
  }
  if (isNumber(responseCode) && responseCode >= 400 && responseCode < 500) {
    return EmailNotAccepted.make({ cause });
  }
  if (code === "ETIMEDOUT") {
    return isString(timeoutType) && setupTimeouts.has(timeoutType)
      ? EmailNotAccepted.make({ cause })
      : EmailOutcomeUnknown.make({ cause });
  }
  if (isString(code) && setupCodes.has(code)) return EmailNotAccepted.make({ cause });
  const transportCode = originalCode ?? code;
  if (isString(transportCode) && unconnectedCodes.has(transportCode)) {
    return EmailNotAccepted.make({ cause });
  }
  if ((code === "EENVELOPE" || code === "EMESSAGE") && responseCode === undefined) {
    return EmailRejected.make({ cause });
  }
  return EmailOutcomeUnknown.make({ cause });
});

/**
 * nodemailer resolves when at least one recipient was accepted. Some recipients already have
 * the message, so a partial refusal is never retryable: it succeeds with a warning. A
 * resolution that lists no accepted recipient but some rejected ones is a rejection.
 */
const checkRecipients = Effect.fnUntraced(function* (info: SmtpSendInfo) {
  const accepted = info.accepted?.length ?? 0;
  const rejected = info.rejected?.length ?? 0;
  if (rejected === 0) return info;
  if (accepted === 0) {
    return yield* EmailRejected.make({ cause: { rejectedRecipients: rejected } });
  }
  yield* Effect.logWarning("SMTP server refused some recipients").pipe(
    Effect.annotateLogs({ accepted, rejected, messageId: info.messageId }),
  );
  return info;
});

export const makeSmtpEmailSender: {
  (config: SmtpConfig): (transport: SmtpTransport) => EmailSenderService;
  (transport: SmtpTransport, config: SmtpConfig): EmailSenderService;
} = Fn.dual(
  2,
  (transport: SmtpTransport, config: SmtpConfig): EmailSenderService =>
    EmailSender.of({
      send: Effect.fn("SmtpEmailSender.send")(
        (message: OutboundEmail, { idempotencyKey }: Parameters<EmailSenderService["send"]>[1]) =>
          Effect.tryPromise({
            try: () => transport.sendMail(smtpMail(message, config, idempotencyKey)),
            catch: classifySmtpError,
          }).pipe(
            Effect.flatMap(checkRecipients),
            Effect.map((info) => ({ provider: SMTP_PROVIDER, providerMessageId: info.messageId })),
          ),
      ),
    }),
);

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
export const layerSmtp: {
  (config: SmtpConfig): (options: SmtpTransportOptions) => Layer.Layer<EmailSender>;
  (options: SmtpTransportOptions, config: SmtpConfig): Layer.Layer<EmailSender>;
} = Fn.dual(
  2,
  (options: SmtpTransportOptions, config: SmtpConfig): Layer.Layer<EmailSender> =>
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
                  attachments: Arr.map(attachments, (attachment) => ({ ...attachment })),
                  headers: { ...headers },
                }),
            },
            config,
          ),
        ),
      ),
    ),
);
