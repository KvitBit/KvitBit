/**
 * Resend HTTP API sender. Adapted from DeskoHub packages/email-resend/backend/resend-provider.ts
 * (status classification, idempotency-key bounding) onto Effect's HttpClient and the Kvitbit
 * EmailSender port. One attempt per call: callers retry by the port's error contract.
 */
import {
  EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailRejected,
  EmailSender,
  type OutboundEmail,
} from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { boundedToken, type EmailSenderService } from "./shared";

export interface ResendConfig {
  readonly apiKey: Redacted.Redacted<string>;
  /** Sender, e.g. `Kvitbit <noreply@kvitbit.cz>`; must be a domain verified in Resend. */
  readonly from: string;
  /** Defaults to `https://api.resend.com`. */
  readonly baseUrl?: string;
  /** Per-attempt limit; past it the outcome is unknown. Defaults to 15 seconds. */
  readonly timeout?: Duration.Input;
}

export const RESEND_PROVIDER = "resend";

const idempotencyKeyMaxLength = 256;
const idempotencyKeyPattern = /^[\x21-\x7e]+$/;
const trailingSlashes = /\/+$/;
const tagPattern = /[^A-Za-z0-9_-]/g;

/** Resend tag names and values allow ASCII letters, digits, `_` and `-`, at most 256 each. */
const resendTag = (raw: string): string => Str.slice(0, 256)(Str.replace(tagPattern, "_")(raw));

/** Resend's `POST /emails` body for a message. */
// @effect-diagnostics-next-line missingPipeableSignature:off Keep the published positional adapter API.
export const resendBody = (message: OutboundEmail, from: string) => ({
  from,
  to: message.to,
  ...(message.cc !== undefined && message.cc.length > 0 && { cc: message.cc }),
  reply_to: message.replyTo,
  subject: message.subject,
  html: message.html,
  text: message.text,
  ...(message.attachments.length > 0 && {
    attachments: Arr.map(message.attachments, (attachment) => ({
      filename: attachment.filename,
      content: Base64.encode(attachment.bytes),
      content_type: attachment.contentType,
    })),
  }),
  ...(Rec.keys(message.tags).length > 0 && {
    tags: Arr.map(Rec.toEntries(message.tags), ([name, value]) => ({
      name: resendTag(name),
      value: resendTag(value),
    })),
  }),
});

/** Resend's Idempotency-Key for a delivery id; over 256 characters becomes a SHA-256 digest. */
export const resendIdempotencyKey = (key: string): string =>
  boundedToken({ maxLength: idempotencyKeyMaxLength, allowed: idempotencyKeyPattern })(key);

type SendError = EmailRejected | EmailNotAccepted | EmailOutcomeUnknown;

/**
 * Classifies a Resend answer by its HTTP status:
 *
 * | Status | Error | Why |
 * |---|---|---|
 * | 409 idempotency key in use or reused | OutcomeUnknown | an earlier attempt may have sent it |
 * | 408 request timeout | OutcomeUnknown | the request body may have been read and processed |
 * | 425 too early | NotAccepted | the server declined to process it |
 * | 401, 403, 404, 405 key, scope, endpoint | NotAccepted | provider-level; another provider can take it |
 * | 429 rate or quota limit | NotAccepted | |
 * | other 4xx (400, 422 validation, 413) | Rejected | the message itself is refused |
 * | 5xx and anything else | NotAccepted | refused before acceptance |
 */
export const classifyResendStatus = (status: number): SendError => {
  const cause = { status };
  if (status === 409 || status === 408) return new EmailOutcomeUnknown({ cause });
  if ([401, 403, 404, 405, 425, 429].includes(status)) return new EmailNotAccepted({ cause });
  if (status >= 400 && status < 500) return new EmailRejected({ cause });
  return new EmailNotAccepted({ cause });
};

/**
 * Error codes (Node/undici, Bun fetch) that mean the request never reached Resend: DNS,
 * refused or unreachable connections and failed TLS handshakes.
 */
const preConnectCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  // biome-ignore lint/security/noSecrets: Bun fetch error code for a socket it could not open.
  "FailedToOpenSocket",
  "DNSError",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const transportCause = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
});
const decodeTransportCause = Schema.decodeUnknownOption(transportCause);

/** The `code` strings along a cause chain (and inside an AggregateError), outermost first. */
const causeCodes = (root: ReturnType<typeof decodeTransportCause>): ReadonlyArray<string> => {
  const codes: Array<string> = [];
  const visit = (decoded: ReturnType<typeof decodeTransportCause>, depth: number) => {
    if (depth > 5 || Option.isNone(decoded)) return;
    const { code, errors, cause } = decoded.value;
    if (Schema.is(Schema.String)(code)) codes.push(code);
    if (Arr.isArray(errors)) {
      for (const inner of errors) visit(decodeTransportCause(inner), depth + 1);
    }
    if (cause !== undefined) visit(decodeTransportCause(cause), depth + 1);
  };
  visit(root, 0);
  return codes;
};

/**
 * What a failure keeps as its cause: the reason tag, description and error codes. Never the
 * request itself, which carries the Authorization header.
 */
const safeCause = (reason: HttpClientError.HttpClientErrorReason) => ({
  reason: reason._tag,
  ...("description" in reason &&
    reason.description !== undefined && {
      description: reason.description,
    }),
  codes: causeCodes(decodeTransportCause("cause" in reason ? reason.cause : undefined)),
});

/**
 * A request that could not be built or connect never left; any other transport failure may
 * have reached Resend, so its outcome is unknown.
 */
export const classifyResendTransport = (error: HttpClientError.HttpClientError): SendError => {
  const reason = error.reason;
  const cause = safeCause(reason);
  switch (reason._tag) {
    case "EncodeError":
    case "InvalidUrlError":
      return new EmailNotAccepted({ cause });
    case "TransportError":
      return Arr.some(cause.codes, (code) => preConnectCodes.has(code))
        ? new EmailNotAccepted({ cause })
        : new EmailOutcomeUnknown({ cause });
    case "StatusCodeError":
      return classifyResendStatus(reason.response.status);
    default:
      return new EmailOutcomeUnknown({ cause });
  }
};

const decodeAcceptedBody = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.NonEmptyString }));

/** A 2xx answer must carry the message id; without one, acceptance is unknown. */
const acceptedId = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, EmailOutcomeUnknown> =>
  response.json.pipe(
    Effect.mapError((error) => new EmailOutcomeUnknown({ cause: safeCause(error.reason) })),
    Effect.flatMap((body) => {
      const decoded = decodeAcceptedBody(body);
      return Option.isSome(decoded)
        ? Effect.succeed(decoded.value.id)
        : Effect.fail(new EmailOutcomeUnknown({ cause: { body: "missing id" } }));
    }),
  );

export const makeResendEmailSender = (
  config: ResendConfig,
): Effect.Effect<EmailSenderService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `${Str.replace(trailingSlashes, "")(config.baseUrl ?? "https://api.resend.com")}/emails`;
    const timeout = config.timeout ?? Duration.seconds(15);

    const send = Effect.fn("ResendEmailSender.send")(function* (
      message: OutboundEmail,
      { idempotencyKey }: Parameters<EmailSenderService["send"]>[1],
    ) {
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(config.apiKey),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("Idempotency-Key", resendIdempotencyKey(idempotencyKey)),
        HttpClientRequest.bodyJsonUnsafe(resendBody(message, config.from)),
      );
      const answer = yield* client.execute(request).pipe(
        Effect.mapError(classifyResendTransport),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? acceptedId(response)
            : Effect.fail(classifyResendStatus(response.status)),
        ),
        Effect.timeoutOption(timeout),
      );
      if (Option.isNone(answer)) {
        return yield* new EmailOutcomeUnknown({ cause: { timedOut: true } });
      }
      return { provider: RESEND_PROVIDER, providerMessageId: answer.value };
    });

    return EmailSender.of({ send });
  });

/** `EmailSender` backed by Resend; needs an `HttpClient` (e.g. `FetchHttpClient.layer`). */
export const layerResend = (
  config: ResendConfig,
): Layer.Layer<EmailSender, never, HttpClient.HttpClient> =>
  Layer.effect(EmailSender, makeResendEmailSender(config));
