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
import { Clock, Context, Data, Duration, Effect, Layer, Option, type Redacted, Ref } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import type { MailRelayMode } from "./config";
import { type ParsedEmail, parseEmail } from "./mime";

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

export class MailRelay extends Context.Service<MailRelay, MailRelayService>()("KvitbitMailRelay") {}

export class MetadataTokenError extends Data.TaggedError("MetadataTokenError")<{
  readonly reason: string;
}> {}

export class ArchiveUploadError extends Data.TaggedError("ArchiveUploadError")<{
  readonly status?: number;
  readonly reason: string;
}> {}

export class ResendRelayError extends Data.TaggedError("ResendRelayError")<{
  readonly status: number;
  readonly transient: boolean;
  readonly reason: string;
}> {}

const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";
const DEFAULT_GCS_UPLOAD_BASE_URL = "https://storage.googleapis.com";
const DEFAULT_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_MAX_FORWARDED_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const DEFAULT_TIMEOUT = Duration.seconds(15);

const sanitizeHeaderText = (value: string, maxLen = 120): string => {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === '"' || ch === "<" || ch === ">" || ch === "\\") {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLen);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const buildArchiveObjectName = (now: Date, suffixHex: string): string => {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `inbound/${yyyy}/${mm}/${dd}/${now.getTime()}-${suffixHex}.eml`;
};

const aliasTagForRecipients = (rcptTo: ReadonlyArray<string>): string => {
  const locals = rcptTo
    .map((addr) => addr.split("@")[0]?.trim())
    .filter((local): local is string => Boolean(local));
  return locals.length === 0 ? "mail" : locals.join(",");
};

const isSimpleEmail = (value: string | undefined): value is string =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);

export const computeDeliveryFingerprint = (message: InboundMessage): string =>
  createHash("sha256")
    .update(message.mailFrom)
    .update("\0")
    .update([...message.rcptTo].sort().join(","))
    .update("\0")
    .update(message.rawBytes)
    .digest("hex");

export const buildResendForwardPayload = (params: {
  readonly message: InboundMessage;
  readonly parsed: ParsedEmail;
  readonly deliveryFingerprint: string;
  readonly archiveBucket: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly maxAttachmentBytes: number;
}): Record<string, unknown> => {
  const {
    message,
    parsed,
    deliveryFingerprint,
    archiveBucket,
    forwardTo,
    forwardFrom,
    maxAttachmentBytes,
  } = params;
  const senderLabel = sanitizeHeaderText(
    parsed.fromDisplayName || parsed.fromAddress || message.mailFrom || "External Sender",
    80,
  );
  const from = `"${senderLabel} via Kvitbit" <${forwardFrom}>`;
  const replyToCandidate = parsed.replyToAddress ?? parsed.fromAddress ?? message.mailFrom;
  const replyTo = isSimpleEmail(replyToCandidate) ? replyToCandidate : undefined;
  const aliasTag = sanitizeHeaderText(aliasTagForRecipients(message.rcptTo), 64);
  const cleanSubject = sanitizeHeaderText(parsed.subject || "(no subject)", 200);
  const subject = `[${aliasTag}] ${cleanSubject}`;
  const shortHash = deliveryFingerprint.slice(0, 16);

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

  const recipientList = message.rcptTo.join(", ");
  const originalFrom = parsed.fromHeader || message.mailFrom || "(empty reverse-path)";
  const skippedNotice =
    skippedAttachments.length > 0
      ? `Omitted large attachment(s): ${skippedAttachments.join(", ")} (see gs://${archiveBucket})`
      : undefined;

  const metaLines = [
    `Forwarded for: ${recipientList}`,
    `Original From: ${originalFrom}`,
    ...(parsed.date ? [`Date: ${parsed.date}`] : []),
    `Archive Bucket: gs://${archiveBucket} (sha256:${shortHash})`,
    ...(skippedNotice ? [skippedNotice] : []),
  ];

  const textBody = `${metaLines.join("\n")}\n---\n\n${parsed.text ?? "(HTML-only or empty plain-text body)"}`;

  let htmlBody: string | undefined;
  if (parsed.html !== undefined && parsed.html.trim().length > 0) {
    const banner =
      `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#475569;` +
      `background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;margin-bottom:14px;">` +
      `<strong>To:</strong> ${escapeHtml(recipientList)} &middot; ` +
      `<strong>From:</strong> ${escapeHtml(originalFrom)}` +
      (skippedAttachments.length > 0
        ? ` &middot; <strong>Omitted attachments:</strong> ${escapeHtml(skippedAttachments.join(", "))}`
        : "") +
      `</div>`;
    htmlBody = `${banner}${parsed.html}`;
  }

  return {
    from,
    to: [forwardTo],
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject,
    text: textBody,
    ...(htmlBody ? { html: htmlBody } : {}),
    ...(forwardedAttachments.length > 0 ? { attachments: forwardedAttachments } : {}),
    headers: {
      "X-Kvitbit-Original-To": sanitizeHeaderText(recipientList, 250),
      "X-Kvitbit-Delivery-Hash": `sha256:${shortHash}`,
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
}): Record<string, unknown> => {
  const aliasTag = sanitizeHeaderText(aliasTagForRecipients(params.message.rcptTo), 64);
  const cleanSubject = sanitizeHeaderText(params.parsed.subject || "(no subject)", 180);
  const shortHash = params.deliveryFingerprint.slice(0, 16);
  return {
    from: `"Kvitbit Mail Forwarder" <${params.forwardFrom}>`,
    to: [params.forwardTo],
    subject: `[${aliasTag}] (Archived) ${cleanSubject}`,
    text: [
      "An inbound email was archived in GCS but Resend rejected verbatim forwarding.",
      `Status: HTTP ${params.rejectionStatus}`,
      `Original To: ${params.message.rcptTo.join(", ")}`,
      `Original From: ${params.parsed.fromHeader || params.message.mailFrom || "(unknown)"}`,
      `Archive Bucket: gs://${params.archiveBucket} (sha256:${shortHash})`,
    ].join("\n"),
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

export const makeMailRelay = (
  config: MailRelayConfig,
): Effect.Effect<MailRelayService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const tokenRef = yield* Ref.make<Option.Option<CachedToken>>(Option.none());
    const resendBase = (config.resendBaseUrl ?? DEFAULT_RESEND_BASE_URL).replace(/\/+$/, "");
    const gcsBase = (config.gcsUploadBaseUrl ?? DEFAULT_GCS_UPLOAD_BASE_URL).replace(/\/+$/, "");
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
        Effect.mapError((error) => new MetadataTokenError({ reason: error.reason._tag })),
        Effect.timeoutOption(timeout),
      );
      if (Option.isNone(responseOpt)) {
        return yield* new MetadataTokenError({ reason: "timeout" });
      }
      const response = responseOpt.value;
      if (response.status < 200 || response.status >= 300) {
        return yield* new MetadataTokenError({
          reason: `metadata HTTP ${response.status}`,
        });
      }
      const body = yield* response.json.pipe(
        Effect.mapError(() => new MetadataTokenError({ reason: "invalid token JSON" })),
      );
      if (
        typeof body !== "object" ||
        body === null ||
        !("access_token" in body) ||
        typeof body.access_token !== "string" ||
        body.access_token.length === 0
      ) {
        return yield* new MetadataTokenError({ reason: "missing access_token" });
      }
      const expiresInSec =
        "expires_in" in body && typeof body.expires_in === "number" ? body.expires_in : 300;
      yield* Ref.set(
        tokenRef,
        Option.some({
          token: body.access_token,
          expiresAtMs: nowMs + expiresInSec * 1000,
        }),
      );
      return body.access_token;
    });

    const archiveToGcs = (
      rawBytes: Uint8Array,
    ): Effect.Effect<{ readonly objectName: string; readonly uri: string }, ArchiveUploadError> =>
      Effect.gen(function* () {
        const token = yield* getAccessToken.pipe(
          Effect.mapError((error) => new ArchiveUploadError({ reason: error.reason })),
        );
        const nowMs = yield* Clock.currentTimeMillis;
        const suffixHex = yield* Effect.sync(() => randomBytes(6).toString("hex"));
        const objectName = buildArchiveObjectName(new Date(nowMs), suffixHex);
        const uploadUrl =
          `${gcsBase}/upload/storage/v1/b/${encodeURIComponent(config.archiveBucket)}` +
          `/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

        const req = HttpClientRequest.post(uploadUrl).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setBody(HttpBody.uint8Array(rawBytes, "message/rfc822")),
        );
        const responseOpt = yield* client.execute(req).pipe(
          Effect.mapError((error) => new ArchiveUploadError({ reason: error.reason._tag })),
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(responseOpt)) {
          return yield* new ArchiveUploadError({ reason: "timeout" });
        }
        const response = responseOpt.value;
        if (response.status < 200 || response.status >= 300) {
          return yield* new ArchiveUploadError({
            status: response.status,
            reason: `GCS upload HTTP ${response.status}`,
          });
        }
        return { objectName, uri: `gs://${config.archiveBucket}/${objectName}` };
      }).pipe(Effect.withSpan("MailRelay.archiveToGcs"));

    const postResend = (
      payload: Record<string, unknown>,
      idempotencySeed: string,
    ): Effect.Effect<string, ResendRelayError> =>
      Effect.gen(function* () {
        if (Option.isNone(config.resendApiKey)) {
          return yield* new ResendRelayError({
            status: 503,
            transient: true,
            reason: "RESEND_API_KEY not configured",
          });
        }
        const idempotencyKey = `fwd-${createHash("sha256").update(idempotencySeed).digest("hex").slice(0, 48)}`;
        const req = HttpClientRequest.post(`${resendBase}/emails`).pipe(
          HttpClientRequest.bearerToken(config.resendApiKey.value),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
          HttpClientRequest.bodyJsonUnsafe(payload),
        );
        const responseOpt = yield* client.execute(req).pipe(
          Effect.mapError(
            (error) =>
              new ResendRelayError({
                status: 0,
                transient: true,
                reason: error.reason._tag,
              }),
          ),
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(responseOpt)) {
          return yield* new ResendRelayError({
            status: 408,
            transient: true,
            reason: "timeout",
          });
        }
        const response = responseOpt.value;
        if (response.status >= 200 && response.status < 300) {
          const id = yield* response.json.pipe(
            Effect.map((body) =>
              typeof body === "object" &&
              body !== null &&
              "id" in body &&
              typeof body.id === "string" &&
              body.id.length > 0
                ? body.id
                : "accepted",
            ),
            Effect.orElseSucceed(() => "accepted"),
          );
          return id;
        }
        return yield* new ResendRelayError({
          status: response.status,
          transient: isTransientResendStatus(response.status),
          reason: `Resend HTTP ${response.status}`,
        });
      }).pipe(Effect.withSpan("MailRelay.postResend"));

    const handleMessage: MailRelayService["handleMessage"] = (message) =>
      Effect.gen(function* () {
        const parsed = parseEmail(message.rawBytes);
        const archiveResult = yield* Effect.result(archiveToGcs(message.rawBytes));
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

        const deliveryFingerprint = computeDeliveryFingerprint(message);
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
            deliveryHash: deliveryFingerprint.slice(0, 16),
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
            deliveryHash: deliveryFingerprint.slice(0, 16),
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
      }).pipe(Effect.withSpan("MailRelay.handleMessage"));

    return MailRelay.of({ handleMessage });
  });

export const layerMailRelay = (
  config: MailRelayConfig,
): Layer.Layer<MailRelay, never, HttpClient.HttpClient> =>
  Layer.effect(MailRelay, makeMailRelay(config));
