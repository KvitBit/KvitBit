import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
/**
 * Effect-based inbound email archival (GCS JSON API) and outbound forwarding (Resend HTTPS API).
 *
 * Invariants:
 * - Every accepted message is archived verbatim to GCS BEFORE SMTP returns `250 OK`.
 * - In `archive-only` mode (Resend bootstrap), archival alone completes delivery.
 * - In `resend` mode, messages are relayed over HTTPS (`api.resend.com`) with `Redacted` API key
 *   to bypass GCP's outbound TCP 25 block while passing SPF/DKIM/DMARC cleanly in Gmail.
 * - Uses `HttpClient`, `Ref`, `Clock`, `Duration`, `Data.TaggedError`, and `Effect.log*`.
 */

import { createHash, randomBytes } from "node:crypto";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Str from "effect/String";
import type { MailRelayMode } from "./config";
import { type ParsedEmail, parseEmail, trimAsciiWsp } from "./mime";

const zaZaZaPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const resendBasePattern = /\/+$/;

export interface InboundMessage {
  readonly remoteIp: string;
  readonly tls: boolean;
  readonly helo: string;
  readonly mailFrom: string;
  readonly rcptTo: ReadonlyArray<string>;
  readonly rawBytes: Uint8Array;
}

export interface RelayResult {
  readonly smtpCode: 250 | 451 | 550;
  readonly smtpMessage: string;
  readonly archivePath?: string;
  readonly resendId?: string;
}

export interface MailRelayConfig {
  readonly domain: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly archiveBucket: string;
  readonly relayMode: MailRelayMode;
  readonly resendApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly resendBaseUrl?: string;
  readonly gcsUploadBaseUrl?: string;
  readonly metadataTokenUrl?: string;
  readonly maxForwardedAttachmentBytes?: number;
  readonly requestTimeout?: Duration.Input;
}

export interface MailRelayService {
  readonly handleMessage: (message: InboundMessage) => Effect.Effect<RelayResult>;
}

export class MailRelay extends Context.Service<MailRelay, MailRelayService>()(
  "@kvitbit/alchemy/mail-forwarder/relay/MailRelay",
) {}

class MetadataTokenError extends Schema.TaggedError<
  MetadataTokenError,
  { readonly brand: unique symbol }
>()("MetadataTokenError", {
  reason: Schema.String,
}) {}

class ArchiveUploadError extends Schema.TaggedError<
  ArchiveUploadError,
  { readonly brand: unique symbol }
>()("ArchiveUploadError", {
  status: Schema.optionalKey(Schema.Finite),
  reason: Schema.String,
}) {}

class ResendRelayError extends Schema.TaggedError<
  ResendRelayError,
  { readonly brand: unique symbol }
>()("ResendRelayError", {
  status: Schema.Finite,
  transient: Schema.Boolean,
  reason: Schema.String,
}) {}

const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";
const DEFAULT_GCS_UPLOAD_BASE_URL = "https://storage.googleapis.com";
const DEFAULT_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_MAX_FORWARDED_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const DEFAULT_TIMEOUT = Duration.seconds(15);

const sanitizeHeaderText = (value: string, maxLen = 120): string => {
  let out = "";
  for (const ch of value) {
    const code = Option.getOrElse(Str.charCodeAt(ch, 0), () => Number.NaN);
    if (code <= 0x1f || code === 0x7f || ch === '"' || ch === "<" || ch === ">" || ch === "\\") {
      out += " ";
    } else {
      out += ch;
    }
  }
  return Str.slice(0, maxLen)(Str.trim(Str.replace(/\s+/g, " ")(out)));
};

const escapeHtml = (value: string): string =>
  Str.replaceAll(
    "'",
    "&#39;",
  )(
    Str.replaceAll(
      '"',
      "&quot;",
    )(
      Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(value))),
    ),
  );

const canonicalRecipients = (rcptTo: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    ...new Set(
      Arr.filter(
        Arr.map(rcptTo, (addr) => Str.toLowerCase(trimAsciiWsp(addr))),
        (a) => a.length > 0,
      ),
    ),
  ].sort(Order.String);

export const computeDeliveryFingerprint = (message: InboundMessage): string =>
  createHash("sha256")
    .update(Str.toLowerCase(trimAsciiWsp(message.mailFrom)))
    .update("\0")
    .update(Arr.join(canonicalRecipients(message.rcptTo), ","))
    .update("\0")
    .update(message.rawBytes)
    .digest("hex");

export const buildArchivePrefix = (deliveryFingerprint: string): string =>
  `inbound/by-hash/${Str.slice(0, 32)(deliveryFingerprint)}/`;

const buildArchiveObjectNameImpl = (
  now: Date,
  deliveryFingerprint: string,
  suffixHex: string,
): string => `${buildArchivePrefix(deliveryFingerprint)}${now.getTime()}-${suffixHex}.eml`;

export const buildArchiveObjectName: {
  (deliveryFingerprint: string, suffixHex: string): (now: Date) => string;
  (now: Date, deliveryFingerprint: string, suffixHex: string): string;
} = Fn.dual(3, buildArchiveObjectNameImpl);

export const buildAlertArchivePrefix = (deliveryFingerprint: string): string =>
  `inbound/alerts/by-hash/${Str.slice(0, 32)(deliveryFingerprint)}/`;

const buildAlertArchiveObjectNameImpl = (
  now: Date,
  deliveryFingerprint: string,
  suffixHex: string,
): string => `${buildAlertArchivePrefix(deliveryFingerprint)}${now.getTime()}-${suffixHex}.eml`;

const buildAlertArchiveObjectName: {
  (deliveryFingerprint: string, suffixHex: string): (now: Date) => string;
  (now: Date, deliveryFingerprint: string, suffixHex: string): string;
} = Fn.dual(3, buildAlertArchiveObjectNameImpl);

const aliasTagForRecipients = (recipients: ReadonlyArray<string>): string => {
  const locals = Arr.filter(
    Arr.map(recipients, (addr) => Str.trim(Str.split(addr, "@")[0])),
    (local): local is string => Boolean(local),
  );
  return locals.length === 0 ? "mail" : Arr.join(locals, ",");
};

/** Compares mailboxes per RFC 5321 §2.3.11: local-part case-sensitive, domain case-insensitive. */
const isSameMailbox = (a: string | undefined, b: string | undefined): boolean => {
  if (!(a !== undefined && a !== "" && b !== undefined && b !== "")) return false;
  const atA = Option.getOrElse(Str.lastIndexOf("@")(a), () => -1);
  const atB = Option.getOrElse(Str.lastIndexOf("@")(b), () => -1);
  if (atA <= 0 || atB <= 0) return a === b;
  return (
    Str.slice(0, atA)(a) === Str.slice(0, atB)(b) &&
    Str.toLowerCase(Str.slice(atA + 1)(a)) === Str.toLowerCase(Str.slice(atB + 1)(b))
  );
};

/** Resend `reply_to` requires an ASCII address; internationalized addresses are preserved in the body instead. */
const isAsciiResendEmail = (value: string | undefined): value is string =>
  Predicate.isString(value) && value.length <= 254 && zaZaZaPattern.test(value);

export const buildResendForwardPayload = (params: {
  readonly message: InboundMessage;
  readonly parsed: ParsedEmail;
  readonly deliveryFingerprint: string;
  readonly archiveBucket: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly maxAttachmentBytes: number;
}): Schema.JsonObject => {
  const {
    message,
    parsed,
    deliveryFingerprint,
    archiveBucket,
    forwardTo,
    forwardFrom,
    maxAttachmentBytes,
  } = params;
  const recipients = canonicalRecipients(message.rcptTo);
  const archivePrefixUri = `gs://${archiveBucket}/${buildArchivePrefix(deliveryFingerprint)}`;
  const sender = Arr.findFirst(
    [parsed.fromDisplayName, parsed.fromAddress, message.mailFrom],
    (name): name is string => Predicate.isString(name) && name !== "",
  ).pipe(Option.getOrElse(() => "External Sender"));
  const senderLabel = sanitizeHeaderText(sender, 80);
  const from = `"${senderLabel} via Kvitbit" <${forwardFrom}>`;
  const replyToCandidate = parsed.replyToAddress ?? parsed.fromAddress ?? message.mailFrom;
  const replyTo = isAsciiResendEmail(replyToCandidate) ? replyToCandidate : undefined;
  const aliasTag = sanitizeHeaderText(aliasTagForRecipients(recipients), 64);
  const cleanSubject = sanitizeHeaderText(parsed.subject || "(no subject)", 200);
  const subject = `[${aliasTag}] ${cleanSubject}`;

  const forwardedAttachments: Array<{
    filename: string;
    content: string;
    content_type: string;
  }> = [];
  const skippedAttachments: Array<string> = [];
  let accumulatedBytes = 0;

  for (const att of parsed.attachments) {
    if (accumulatedBytes + att.sizeBytes <= maxAttachmentBytes) {
      forwardedAttachments.push({
        filename: sanitizeHeaderText(att.filename, 120) || "attachment.bin",
        content: att.contentBase64,
        content_type: att.contentType,
      });
      accumulatedBytes += att.sizeBytes;
    } else {
      skippedAttachments.push(`${att.filename} (${att.sizeBytes} bytes)`);
    }
  }

  const recipientList = Arr.join(recipients, ", ");
  const originalFrom = parsed.fromHeader || message.mailFrom || "(empty reverse-path)";
  // Surface Reply-To explicitly whenever it differs from From (case-sensitive local-part per
  // RFC 5321 §2.3.11) OR was omitted from Resend's ASCII-only `reply_to` field.
  const visibleReplyTo =
    replyToCandidate !== "" &&
    trimAsciiWsp(replyToCandidate).length > 0 &&
    (replyTo === undefined ||
      (parsed.replyToAddress !== undefined &&
        !isSameMailbox(parsed.replyToAddress, parsed.fromAddress)))
      ? replyToCandidate
      : undefined;
  const skippedNotice =
    skippedAttachments.length > 0
      ? `Omitted large attachment(s): ${Arr.join(skippedAttachments, ", ")} (see ${archivePrefixUri})`
      : undefined;

  const metaLines = [
    `Forwarded for: ${recipientList}`,
    `Original From: ${originalFrom}`,
    ...(visibleReplyTo !== undefined && visibleReplyTo !== ""
      ? [`Original Reply-To: ${visibleReplyTo}`]
      : []),
    ...(parsed.date !== undefined && parsed.date !== "" ? [`Date: ${parsed.date}`] : []),
    `Archive: ${archivePrefixUri}`,
    ...(skippedNotice !== undefined && skippedNotice !== "" ? [skippedNotice] : []),
  ];

  const textBody = `${Arr.join(metaLines, "\n")}\n---\n\n${parsed.text ?? "(HTML-only or empty plain-text body)"}`;

  let htmlBody: string | undefined;
  if (parsed.html !== undefined && Str.trim(parsed.html).length > 0) {
    const banner =
      `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#475569;` +
      `background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;margin-bottom:14px;">` +
      `<strong>To:</strong> ${escapeHtml(recipientList)} &middot; ` +
      `<strong>From:</strong> ${escapeHtml(originalFrom)}` +
      (visibleReplyTo !== undefined && visibleReplyTo !== ""
        ? ` &middot; <strong>Reply-To:</strong> ${escapeHtml(visibleReplyTo)}`
        : "") +
      (skippedAttachments.length > 0
        ? ` &middot; <strong>Omitted attachments:</strong> ${escapeHtml(Arr.join(skippedAttachments, ", "))} (${escapeHtml(archivePrefixUri)})`
        : "") +
      "</div>";
    htmlBody = `${banner}${parsed.html}`;
  }

  const replyToFields = replyTo !== undefined && replyTo !== "" ? { reply_to: replyTo } : {};
  const htmlFields = htmlBody !== undefined && htmlBody !== "" ? { html: htmlBody } : {};
  const attachmentsFields =
    forwardedAttachments.length > 0 ? { attachments: forwardedAttachments } : {};
  return {
    from,
    to: [forwardTo],
    ...replyToFields,
    subject,
    text: textBody,
    ...htmlFields,
    ...attachmentsFields,
    headers: {
      "X-Kvitbit-Original-To": sanitizeHeaderText(recipientList, 250),
      "X-Kvitbit-Archive-Prefix": sanitizeHeaderText(archivePrefixUri, 250),
    },
  };
};

export const buildResendFallbackPayload = (params: {
  readonly message: InboundMessage;
  readonly parsed: ParsedEmail;
  readonly deliveryFingerprint: string;
  readonly archiveBucket: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly rejectionStatus: number;
}): Schema.JsonObject => {
  const recipients = canonicalRecipients(params.message.rcptTo);
  const aliasTag = sanitizeHeaderText(aliasTagForRecipients(recipients), 64);
  const cleanSubject = sanitizeHeaderText(params.parsed.subject || "(no subject)", 180);
  const archivePrefixUri = `gs://${params.archiveBucket}/${buildArchivePrefix(params.deliveryFingerprint)}`;
  return {
    from: `"Kvitbit Mail Forwarder" <${params.forwardFrom}>`,
    to: [params.forwardTo],
    subject: `[${aliasTag}] (Archived) ${cleanSubject}`,
    text: Arr.join(
      [
        "An inbound email was archived in GCS but Resend rejected verbatim forwarding.",
        `Status: HTTP ${params.rejectionStatus}`,
        `Original To: ${Arr.join(recipients, ", ")}`,
        `Original From: ${params.parsed.fromHeader || params.message.mailFrom || "(unknown)"}`,
        `Archive Prefix: ${archivePrefixUri}`,
      ],
      "\n",
    ),
  };
};

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

const isTransientResendStatus = (status: number): boolean =>
  status >= 500 ||
  status === 401 ||
  status === 403 ||
  status === 408 ||
  status === 409 ||
  status === 425 ||
  status === 429;

const makeMailRelay = (
  config: MailRelayConfig,
): Effect.Effect<MailRelayService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const tokenRef = yield* Ref.make<Option.Option<CachedToken>>(Option.none());
    const resendBase = Str.replace(
      resendBasePattern,
      "",
    )(config.resendBaseUrl ?? DEFAULT_RESEND_BASE_URL);
    const gcsBase = Str.replace(
      resendBasePattern,
      "",
    )(config.gcsUploadBaseUrl ?? DEFAULT_GCS_UPLOAD_BASE_URL);
    const metadataUrl = config.metadataTokenUrl ?? DEFAULT_METADATA_TOKEN_URL;
    const maxAttachmentBytes =
      config.maxForwardedAttachmentBytes ?? DEFAULT_MAX_FORWARDED_ATTACHMENT_BYTES;
    const timeout = config.requestTimeout ?? DEFAULT_TIMEOUT;

    const getAccessToken: Effect.Effect<string, MetadataTokenError> = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(tokenRef);
      if (Option.isSome(cached) && nowMs < cached.value.expiresAtMs - 60_000) {
        return cached.value.token;
      }

      const req = HttpClientRequest.get(metadataUrl).pipe(
        HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
      );
      const responseOpt = yield* client.execute(req).pipe(
        Effect.mapError((error) => MetadataTokenError.make({ reason: error.reason._tag })),
        Effect.timeoutOption(timeout),
      );
      if (Option.isNone(responseOpt)) {
        return yield* MetadataTokenError.make({ reason: "timeout" });
      }
      const response = responseOpt.value;
      if (response.status < 200 || response.status >= 300) {
        return yield* MetadataTokenError.make({
          reason: `metadata HTTP ${response.status}`,
        });
      }
      const body = yield* response.json.pipe(
        Effect.mapError(() => MetadataTokenError.make({ reason: "invalid token JSON" })),
      );
      if (
        !(
          Predicate.isObject(body) &&
          "access_token" in body &&
          Predicate.isString(body["access_token"])
        ) ||
        body["access_token"].length === 0
      ) {
        return yield* MetadataTokenError.make({ reason: "missing access_token" });
      }
      const expiresInSec =
        "expires_in" in body && Predicate.isNumber(body["expires_in"]) ? body["expires_in"] : 300;
      yield* Ref.set(
        tokenRef,
        Option.some({
          token: body["access_token"],
          expiresAtMs: nowMs + expiresInSec * 1000,
        }),
      );
      return body["access_token"];
    });

    const uploadRawToGcs = (
      rawBytes: Uint8Array,
      objectName: string,
    ): Effect.Effect<{ readonly objectName: string; readonly uri: string }, ArchiveUploadError> =>
      Effect.gen(function* () {
        const token = yield* getAccessToken.pipe(
          Effect.mapError((error) => ArchiveUploadError.make({ reason: error.reason })),
        );
        const uploadUrl =
          `${gcsBase}/upload/storage/v1/b/${encodeURIComponent(config.archiveBucket)}` +
          `/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

        const req = HttpClientRequest.post(uploadUrl).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setBody(HttpBody.uint8Array(rawBytes, "message/rfc822")),
        );
        const responseOpt = yield* client.execute(req).pipe(
          Effect.mapError((error) => ArchiveUploadError.make({ reason: error.reason._tag })),
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(responseOpt)) {
          return yield* ArchiveUploadError.make({ reason: "timeout" });
        }
        const response = responseOpt.value;
        if (response.status < 200 || response.status >= 300) {
          return yield* ArchiveUploadError.make({
            status: response.status,
            reason: `GCS upload HTTP ${response.status}`,
          });
        }
        return { objectName, uri: `gs://${config.archiveBucket}/${objectName}` };
      }).pipe(Effect.withSpan("MailRelay.archiveToGcs"));

    const archiveToGcs = (
      rawBytes: Uint8Array,
      deliveryFingerprint: string,
      includeAlertsCopy: boolean,
    ): Effect.Effect<{ readonly objectName: string; readonly uri: string }, ArchiveUploadError> =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const suffixHex = yield* Effect.sync(() => randomBytes(6).toString("hex"));
        const now = DateTime.toDateUtc(DateTime.makeUnsafe(nowMs));
        const primary = yield* uploadRawToGcs(
          rawBytes,
          buildArchiveObjectName(now, deliveryFingerprint, suffixHex),
        );
        if (includeAlertsCopy) {
          yield* uploadRawToGcs(
            rawBytes,
            buildAlertArchiveObjectName(now, deliveryFingerprint, suffixHex),
          );
        }
        return primary;
      });

    const postResend = (
      payload: Schema.JsonObject,
      idempotencySeed: string,
    ): Effect.Effect<string, ResendRelayError> =>
      Effect.gen(function* () {
        if (Option.isNone(config.resendApiKey)) {
          return yield* ResendRelayError.make({
            status: 503,
            transient: true,
            reason: "RESEND_API_KEY not configured",
          });
        }
        const idempotencyKey = `fwd-${Str.slice(0, 48)(createHash("sha256").update(idempotencySeed).digest("hex"))}`;
        const req = HttpClientRequest.post(`${resendBase}/emails`).pipe(
          HttpClientRequest.bearerToken(config.resendApiKey.value),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
          HttpClientRequest.bodyJsonUnsafe(payload),
        );
        const responseOpt = yield* client.execute(req).pipe(
          Effect.mapError((error) =>
            ResendRelayError.make({
              status: 0,
              transient: true,
              reason: error.reason._tag,
            }),
          ),
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(responseOpt)) {
          return yield* ResendRelayError.make({
            status: 408,
            transient: true,
            reason: "timeout",
          });
        }
        const response = responseOpt.value;
        if (response.status >= 200 && response.status < 300) {
          const id = yield* response.json.pipe(
            Effect.map((body) =>
              Predicate.isObject(body) &&
              "id" in body &&
              Predicate.isString(body["id"]) &&
              body["id"].length > 0
                ? body["id"]
                : "accepted",
            ),
            Effect.orElseSucceed(() => "accepted"),
          );
          return id;
        }
        return yield* ResendRelayError.make({
          status: response.status,
          transient: isTransientResendStatus(response.status),
          reason: `Resend HTTP ${response.status}`,
        });
      }).pipe(Effect.withSpan("MailRelay.postResend"));

    const alertRecipient = `alerts@${Str.toLowerCase(config.domain)}`;

    const handleMessage: MailRelayService["handleMessage"] = Effect.fn("MailRelay.handleMessage")(
      function* (message) {
        const parsed = parseEmail(message.rawBytes);
        const deliveryFingerprint = computeDeliveryFingerprint(message);
        const includeAlertsCopy = canonicalRecipients(message.rcptTo).includes(alertRecipient);
        const archiveResult = yield* Effect.result(
          archiveToGcs(message.rawBytes, deliveryFingerprint, includeAlertsCopy),
        );
        if (archiveResult._tag === "Failure") {
          yield* Effect.logError("mail_archive_failed", {
            remoteIp: message.remoteIp,
            rcptTo: message.rcptTo,
            sizeBytes: message.rawBytes.byteLength,
            reason: archiveResult.failure.reason,
          });
          return { smtpCode: 451 as const, smtpMessage: "4.3.0 Temporary storage error" };
        }
        const archive = archiveResult.success;

        if (config.relayMode === "archive-only") {
          yield* Effect.logInfo("mail_archived_only", {
            remoteIp: message.remoteIp,
            tls: message.tls,
            rcptTo: message.rcptTo,
            sizeBytes: message.rawBytes.byteLength,
            archivePath: archive.uri,
          });
          return {
            smtpCode: 250 as const,
            smtpMessage: "2.0.0 OK archived",
            archivePath: archive.uri,
          };
        }

        const payload = buildResendForwardPayload({
          message,
          parsed,
          deliveryFingerprint,
          archiveBucket: config.archiveBucket,
          forwardTo: config.forwardTo,
          forwardFrom: config.forwardFrom,
          maxAttachmentBytes,
        });
        const sendResult = yield* Effect.result(postResend(payload, deliveryFingerprint));
        if (sendResult._tag === "Success") {
          yield* Effect.logInfo("mail_forwarded", {
            remoteIp: message.remoteIp,
            tls: message.tls,
            rcptTo: message.rcptTo,
            sizeBytes: message.rawBytes.byteLength,
            archivePath: archive.uri,
            deliveryHash: Str.slice(0, 16)(deliveryFingerprint),
            resendId: sendResult.success,
          });
          return {
            smtpCode: 250 as const,
            smtpMessage: "2.0.0 OK forwarded",
            archivePath: archive.uri,
            resendId: sendResult.success,
          };
        }

        const sendError = sendResult.failure;
        if (sendError.transient) {
          yield* Effect.logError("mail_forward_transient_error", {
            remoteIp: message.remoteIp,
            rcptTo: message.rcptTo,
            archivePath: archive.uri,
            deliveryHash: Str.slice(0, 16)(deliveryFingerprint),
            resendStatus: sendError.status,
            reason: sendError.reason,
          });
          return {
            smtpCode: 451 as const,
            smtpMessage: "4.3.0 Temporary relay failure",
            archivePath: archive.uri,
          };
        }

        // Permanent 4xx payload rejection (e.g. malformed attachment or HTML): send plain notification.
        const fallback = buildResendFallbackPayload({
          message,
          parsed,
          deliveryFingerprint,
          archiveBucket: config.archiveBucket,
          forwardTo: config.forwardTo,
          forwardFrom: config.forwardFrom,
          rejectionStatus: sendError.status,
        });
        const fallbackResult = yield* Effect.result(
          postResend(fallback, `${deliveryFingerprint}:fallback`),
        );
        if (fallbackResult._tag === "Success") {
          yield* Effect.logWarning("mail_forwarded_fallback_notice", {
            remoteIp: message.remoteIp,
            rcptTo: message.rcptTo,
            archivePath: archive.uri,
            originalResendStatus: sendError.status,
            resendId: fallbackResult.success,
          });
          return {
            smtpCode: 250 as const,
            smtpMessage: "2.0.0 OK archived and notified",
            archivePath: archive.uri,
            resendId: fallbackResult.success,
          };
        }

        yield* Effect.logError("mail_forward_fallback_failed", {
          remoteIp: message.remoteIp,
          rcptTo: message.rcptTo,
          archivePath: archive.uri,
          originalResendStatus: sendError.status,
          fallbackResendStatus: fallbackResult.failure.status,
        });
        return {
          smtpCode: 451 as const,
          smtpMessage: "4.3.0 Temporary relay failure",
          archivePath: archive.uri,
        };
      },
    );

    return MailRelay.of({ handleMessage });
  });

export const layerMailRelay = (
  config: MailRelayConfig,
): Layer.Layer<MailRelay, never, HttpClient.HttpClient> =>
  Layer.effect(MailRelay, makeMailRelay(config));
