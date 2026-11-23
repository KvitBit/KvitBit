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
import { Duration, Effect, Layer, Option, type Redacted } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
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
const tagPattern = /[^A-Za-z0-9_-]/g;

/** Resend tag names and values allow ASCII letters, digits, `_` and `-`, at most 256 each. */
const resendTag = (raw: string): string => raw.replace(tagPattern, "_").slice(0, 256);

/** Resend's `POST /emails` body for a message. */
export const resendBody = (message: OutboundEmail, from: string) => ({
  from,
  to: message.to,
  ...(message.cc !== undefined && message.cc.length > 0 && { cc: message.cc }),
  reply_to: message.replyTo,
  subject: message.subject,
  html: message.html,
  text: message.text,
  ...(message.attachments.length > 0 && {
    attachments: message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.bytes).toString("base64"),
      content_type: attachment.contentType,
    })),
  }),
  ...(Object.keys(message.tags).length > 0 && {
    tags: Object.entries(message.tags).map(([name, value]) => ({
      name: resendTag(name),
      value: resendTag(value),
    })),
  }),
});

/** Resend's Idempotency-Key for a delivery id; over 256 characters becomes a SHA-256 digest. */
export const resendIdempotencyKey = (key: string): string =>
  boundedToken(key, idempotencyKeyMaxLength, /^[\x21-\x7e]+$/);

type SendError = EmailRejected | EmailNotAccepted | EmailOutcomeUnknown;

/**
 * Classifies a Resend answer by its HTTP status:
 *
 * | Status | Error | Why |
 * |---|---|---|
 * | 409 idempotency key in use or reused | OutcomeUnknown | an earlier attempt may have sent it |
 * | 401, 403, 404, 405 key, scope, endpoint | NotAccepted | provider-level; another provider can take it |
 * | 429 rate or quota limit | NotAccepted | |
 * | other 4xx (400, 422 validation, 413) | Rejected | the message itself is refused |
 * | 5xx and anything else | NotAccepted | refused before acceptance |
 */
export const classifyResendStatus = (status: number): SendError => {
  const cause = { status };
  if (status === 409) return new EmailOutcomeUnknown({ cause });
  if ([401, 403, 404, 405, 429].includes(status)) return new EmailNotAccepted({ cause });
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
  "FailedToOpenSocket",
  "DNSError",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const failedBeforeConnect = (cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && preConnectCodes.has(code)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

/**
 * A request that could not be built or connect never left; any other transport failure may
 * have reached Resend, so its outcome is unknown.
 */
export const classifyResendTransport = (error: HttpClientError.HttpClientError): SendError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "EncodeError":
    case "InvalidUrlError":
      return new EmailNotAccepted({ cause: reason });
    case "TransportError":
      return failedBeforeConnect(reason.cause)
        ? new EmailNotAccepted({ cause: reason })
        : new EmailOutcomeUnknown({ cause: reason });
    case "StatusCodeError":
      return classifyResendStatus(reason.response.status);
    default:
      return new EmailOutcomeUnknown({ cause: reason });
  }
};

/** A 2xx answer must carry the message id; without one, acceptance is unknown. */
const acceptedId = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, EmailOutcomeUnknown> =>
  response.json.pipe(
    Effect.mapError((cause) => new EmailOutcomeUnknown({ cause })),
    Effect.flatMap((body) =>
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      typeof body.id === "string" &&
      body.id.length > 0
        ? Effect.succeed(body.id)
        : Effect.fail(new EmailOutcomeUnknown({ cause: { body: "missing id" } })),
    ),
  );

export const makeResendEmailSender = (
  config: ResendConfig,
): Effect.Effect<EmailSenderService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `${(config.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`;
    const timeout = config.timeout ?? Duration.seconds(15);

    const send: EmailSenderService["send"] = (message, { idempotencyKey }) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.withSpan("ResendEmailSender.send"));

    return EmailSender.of({ send });
  });

/** `EmailSender` backed by Resend; needs an `HttpClient` (e.g. `FetchHttpClient.layer`). */
export const layerResend = (
  config: ResendConfig,
): Layer.Layer<EmailSender, never, HttpClient.HttpClient> =>
  Layer.effect(EmailSender, makeResendEmailSender(config));
