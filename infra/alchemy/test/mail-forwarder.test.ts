import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { gunzipSync } from "node:zlib";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { loadMailForwarderConfig } from "../src/mail-forwarder/config";
import {
  decodeQuotedPrintable,
  decodeRfc2047,
  extractAddress,
  parseEmail,
} from "../src/mail-forwarder/mime";
import {
  buildArchiveObjectName,
  buildArchivePrefix,
  buildResendFallbackPayload,
  buildResendForwardPayload,
  computeDeliveryFingerprint,
  type InboundMessage,
  layerMailRelay,
  MailRelay,
} from "../src/mail-forwarder/relay";
import { parseEnvelopePath, startSmtpServer } from "../src/mail-forwarder/smtp";
import { formatCloudDnsTxt, normalizeMxRrdata } from "../src/resources/dns";
import {
  buildMailForwarderStartupScript,
  bundleMailForwarderScript,
  MAIL_FORWARDER_BUN_IMAGE_DIGEST,
  MAIL_FORWARDER_BUN_IMAGE_REF,
  serializeMailForwarderConfig,
  sha256Prefixed,
} from "../src/resources/mail";

const mockHttpClientLayer = (
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

describe("Effect MailForwarderConfig", () => {
  test("loads normalized aliases, Redacted Resend key, and validates resend requirements", async () => {
    const ok = await Effect.runPromise(
      loadMailForwarderConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                KVITBIT_MAIL_DOMAIN: "Kvitbit.com.",
                KVITBIT_MAIL_FORWARD_TO: "Filkalny@Gmail.com",
                KVITBIT_MAIL_ALIASES: "founder, ops, OPS",
                KVITBIT_MAIL_ARCHIVE_BUCKET: "kvitbit-prod-mail-archive-prod",
                KVITBIT_MAIL_RELAY_MODE: "resend",
                RESEND_API_KEY: "re_secret_value",
              },
            }),
          ),
        ),
      ),
    );
    expect(ok.domain).toBe("kvitbit.com");
    expect(ok.mxHost).toBe("mx.kvitbit.com");
    expect(ok.forwardTo).toBe("filkalny@gmail.com");
    expect(ok.forwardFrom).toBe("forwarder@kvitbit.com");
    expect(ok.aliases).toEqual(["founder", "ops"]);
    expect([...ok.allowedRecipients].sort()).toEqual(["founder@kvitbit.com", "ops@kvitbit.com"]);
    expect(Option.isSome(ok.resendApiKey)).toBe(true);
    if (Option.isSome(ok.resendApiKey)) {
      expect(Redacted.value(ok.resendApiKey.value)).toBe("re_secret_value");
    }

    const missingKey = await Effect.runPromise(
      Effect.flip(
        loadMailForwarderConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
                  KVITBIT_MAIL_ALIASES: "ops",
                  KVITBIT_MAIL_ARCHIVE_BUCKET: "kvitbit-prod-mail-archive-prod",
                  KVITBIT_MAIL_RELAY_MODE: "resend",
                },
              }),
            ),
          ),
        ),
      ),
    );
    expect(missingKey).toMatchObject({
      _tag: "InvalidMailForwarderConfig",
      field: "RESEND_API_KEY",
    });
  });
});

describe("MIME parser", () => {
  test("decodes RFC 2047 and raw RFC 6532 UTF-8 headers without corruption", () => {
    const encodedCzech = `=?UTF-8?B?${Buffer.from("Ověření áúčtu", "utf8").toString("base64")}?=`;
    expect(decodeRfc2047(encodedCzech)).toBe("Ověření áúčtu");
    expect(decodeRfc2047("=?UTF-8?Q?Verify_your_=E2=9C=85_account?=")).toBe(
      "Verify your ✅ account",
    );
    expect(extractAddress('"Resend Team" <no-reply@resend.com>')).toEqual({
      address: "no-reply@resend.com",
      displayName: "Resend Team",
    });
    expect(extractAddress("plain@example.org")).toEqual({
      address: "plain@example.org",
      displayName: undefined,
    });

    const utf8Raw = [
      "From: Jan Novák <jan@example.cz>",
      "To: ops@kvitbit.com",
      "Subject: Příliš žlutý kůň",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Úpěl ďábelské ódy.",
    ].join("\r\n");
    const parsedUtf8 = parseEmail(Buffer.from(utf8Raw, "utf8"));
    expect(parsedUtf8.subject).toBe("Příliš žlutý kůň");
    expect(parsedUtf8.fromDisplayName).toBe("Jan Novák");
    expect(parsedUtf8.fromAddress).toBe("jan@example.cz");
  });

  test("preserves independent interleaved plain and HTML sibling parts in multipart/mixed per RFC 2046 §5.1.3", () => {
    const raw = [
      "From: notes@example.com",
      "To: ops@kvitbit.com",
      "Subject: Multi-part notes",
      'Content-Type: multipart/mixed; boundary="mix-b"',
      "",
      "--mix-b",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "FIRST",
      "--mix-b",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p><b>SECOND</b></p>",
      "--mix-b",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "THIRD",
      "--mix-b--",
      "",
    ].join("\r\n");

    const parsed = parseEmail(Buffer.from(raw, "utf8"));
    expect(parsed.text).toBe("FIRST\n\nSECOND\n\nTHIRD");
    expect(parsed.html).toBeDefined();
    const html = parsed.html ?? "";
    expect(html.indexOf("FIRST")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("<b>SECOND</b>")).toBeGreaterThan(html.indexOf("FIRST"));
    expect(html.indexOf("THIRD")).toBeGreaterThan(html.indexOf("<b>SECOND</b>"));
  });

  test("preserves all children of multipart/mixed nested inside multipart/alternative per RFC 2046 §5.1.4", () => {
    const raw = [
      "From: notes@example.com",
      "To: ops@kvitbit.com",
      "Subject: Nested mixed in alternative",
      'Content-Type: multipart/alternative; boundary="alt-b"',
      "",
      "--alt-b",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Plain summary",
      "--alt-b",
      'Content-Type: multipart/mixed; boundary="mix-inner"',
      "",
      "--mix-inner",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>FIRST</p>",
      "--mix-inner",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>SECOND</p>",
      "--mix-inner--",
      "--alt-b--",
      "",
    ].join("\r\n");

    const parsed = parseEmail(Buffer.from(raw, "utf8"));
    expect(parsed.text).toBe("Plain summary");
    expect(parsed.html).toBe("<p>FIRST</p><hr><p>SECOND</p>");

    // Nested multipart/alternative inside multipart/alternative: later HTML sibling must
    // replace HTML without discarding the explicit plain-text body from the inner alternative.
    const nestedAltRaw = [
      "From: notes@example.com",
      "To: ops@kvitbit.com",
      "Subject: Nested alternative",
      'Content-Type: multipart/alternative; boundary="outer-alt"',
      "",
      "--outer-alt",
      'Content-Type: multipart/alternative; boundary="inner-alt"',
      "",
      "--inner-alt",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Plain version with reference 123",
      "--inner-alt",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Inner HTML</p>",
      "--inner-alt--",
      "--outer-alt",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Rich version</p>",
      "--outer-alt--",
      "",
    ].join("\r\n");
    const nestedAltParsed = parseEmail(Buffer.from(nestedAltRaw, "utf8"));
    expect(nestedAltParsed.text).toBe("Plain version with reference 123");
    expect(nestedAltParsed.html).toBe("<p>Rich version</p>");

    // Reverse nesting: outer plain text followed by nested HTML-only multipart/alternative
    // must keep the outer authored plain text instead of overwriting with stripped HTML.
    const reverseNestedAltRaw = [
      "From: notes@example.com",
      "To: ops@kvitbit.com",
      "Subject: Outer plain + inner HTML-only alternative",
      'Content-Type: multipart/alternative; boundary="outer-rev"',
      "",
      "--outer-rev",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Authored 123",
      "--outer-rev",
      'Content-Type: multipart/alternative; boundary="inner-html-only"',
      "",
      "--inner-html-only",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Latest HTML</p>",
      "--inner-html-only--",
      "--outer-rev--",
      "",
    ].join("\r\n");
    const reverseNestedAltParsed = parseEmail(Buffer.from(reverseNestedAltRaw, "utf8"));
    expect(reverseNestedAltParsed.text).toBe("Authored 123");
    expect(reverseNestedAltParsed.html).toBe("<p>Latest HTML</p>");

    // Mixed child with HTML + plain footer must NOT overwrite an outer authored plain sibling.
    const mixedHtmlPlainChildRaw = [
      "From: orders@example.com",
      "To: ops@kvitbit.com",
      "Subject: Order ref",
      'Content-Type: multipart/alternative; boundary="outer-mix"',
      "",
      "--outer-mix",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order reference 123",
      "--outer-mix",
      'Content-Type: multipart/mixed; boundary="inner-mix"',
      "",
      "--inner-mix",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Order details</p>",
      "--inner-mix",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Footer",
      "--inner-mix--",
      "--outer-mix--",
      "",
    ].join("\r\n");
    const mixedHtmlPlainParsed = parseEmail(Buffer.from(mixedHtmlPlainChildRaw, "utf8"));
    expect(mixedHtmlPlainParsed.text).toBe("Order reference 123");
    expect(mixedHtmlPlainParsed.html).toContain("<p>Order details</p>");
    expect(mixedHtmlPlainParsed.html).toContain("Footer");

    // Alternative containing only a mixed child of two HTML parts must keep `\n\n` part boundary in text.
    const htmlOnlyMixedChildRaw = [
      "From: orders@example.com",
      "To: ops@kvitbit.com",
      "Subject: Two HTML parts",
      'Content-Type: multipart/alternative; boundary="outer-two"',
      "",
      "--outer-two",
      'Content-Type: multipart/mixed; boundary="inner-two"',
      "",
      "--inner-two",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Order</p>",
      "--inner-two",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>123</p>",
      "--inner-two--",
      "--outer-two--",
      "",
    ].join("\r\n");
    const htmlOnlyMixedParsed = parseEmail(Buffer.from(htmlOnlyMixedChildRaw, "utf8"));
    expect(htmlOnlyMixedParsed.text).toBe("Order\n\n123");
    expect(htmlOnlyMixedParsed.html).toBe("<p>Order</p><hr><p>123</p>");
  });

  test("parses RFC 5322 trailing/inline comments, case-distinct local-part Reply-To, and UTF-8 Reply-To", () => {
    expect(extractAddress("Ana <ana@example.org> (Support)")).toEqual({
      address: "ana@example.org",
      displayName: "Ana",
    });
    expect(extractAddress("Ana <ana@example.org> (Support (EU))")).toEqual({
      address: "ana@example.org",
      displayName: "Ana",
    });
    expect(extractAddress("accounts(team)@example.org")).toEqual({
      address: "accounts@example.org",
      displayName: undefined,
    });

    const commentedRaw = Buffer.from(
      [
        "From: billing@example.org (Billing)",
        "Reply-To: accounts(team)@example.org",
        "To: ops@kvitbit.com",
        "Subject: Invoice question",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Hello",
      ].join("\r\n"),
      "utf8",
    );
    const commentedMsg: InboundMessage = {
      remoteIp: "203.0.113.10",
      tls: true,
      helo: "mail.example.org",
      mailFrom: "bounces@example.org",
      rcptTo: ["ops@kvitbit.com"],
      rawBytes: commentedRaw,
    };
    const commentedPayload = buildResendForwardPayload({
      message: commentedMsg,
      parsed: parseEmail(commentedRaw),
      deliveryFingerprint: computeDeliveryFingerprint(commentedMsg),
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(commentedPayload.reply_to).toBe("accounts@example.org");

    const caseDistinctRaw = Buffer.from(
      [
        "From: billing@example.org",
        "Reply-To: Billing@example.org",
        "To: ops@kvitbit.com",
        "Subject: Case sensitive local-part",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>Hi</p>",
      ].join("\r\n"),
      "utf8",
    );
    const caseDistinctMsg: InboundMessage = {
      ...commentedMsg,
      rawBytes: caseDistinctRaw,
    };
    const caseDistinctPayload = buildResendForwardPayload({
      message: caseDistinctMsg,
      parsed: parseEmail(caseDistinctRaw),
      deliveryFingerprint: computeDeliveryFingerprint(caseDistinctMsg),
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(caseDistinctPayload.reply_to).toBe("Billing@example.org");
    expect(String(caseDistinctPayload.text)).toContain("Original Reply-To: Billing@example.org");
    expect(String(caseDistinctPayload.html)).toContain(
      "<strong>Reply-To:</strong> Billing@example.org",
    );

    const utf8ReplyRaw = Buffer.from(
      [
        "From: billing@example.org",
        "Reply-To: žan@example.net",
        "To: ops@kvitbit.com",
        "Subject: Dotaz",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>Dobrý den</p>",
      ].join("\r\n"),
      "utf8",
    );
    const utf8ReplyMsg: InboundMessage = {
      remoteIp: "203.0.113.10",
      tls: true,
      helo: "mail.example.org",
      mailFrom: "billing@example.org",
      rcptTo: ["ops@kvitbit.com"],
      rawBytes: utf8ReplyRaw,
    };
    const utf8ReplyPayload = buildResendForwardPayload({
      message: utf8ReplyMsg,
      parsed: parseEmail(utf8ReplyRaw),
      deliveryFingerprint: computeDeliveryFingerprint(utf8ReplyMsg),
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(utf8ReplyPayload.reply_to).toBeUndefined();
    expect(String(utf8ReplyPayload.text)).toContain("Original Reply-To: žan@example.net");
    expect(String(utf8ReplyPayload.html)).toContain("<strong>Reply-To:</strong> žan@example.net");

    // Non-ASCII U+00A0 in local-part must not be stripped by ASCII WSP normalization:
    // keep verbatim UTF-8 address in body and omit ASCII-only reply_to.
    const nbspAddr = "billing\u00a0@example.org";
    expect(extractAddress(nbspAddr)).toEqual({
      address: nbspAddr,
      displayName: undefined,
    });
    const nbspRaw = Buffer.from(
      [
        `From: ${nbspAddr}`,
        "To: ops@kvitbit.com",
        "Subject: NBSP local part",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Body",
      ].join("\r\n"),
      "utf8",
    );
    const nbspMsg: InboundMessage = {
      ...commentedMsg,
      mailFrom: nbspAddr,
      rawBytes: nbspRaw,
    };
    const nbspPayload = buildResendForwardPayload({
      message: nbspMsg,
      parsed: parseEmail(nbspRaw),
      deliveryFingerprint: computeDeliveryFingerprint(nbspMsg),
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(nbspPayload.reply_to).toBeUndefined();
    expect(String(nbspPayload.text)).toContain(`Original From: ${nbspAddr}`);
  });

  test("extracts full UTF-8 bare mailbox without ASCII substring truncation and omits non-ASCII reply_to", () => {
    expect(extractAddress("žan@example.net")).toEqual({
      address: "žan@example.net",
      displayName: undefined,
    });
    const raw = Buffer.from(
      [
        "From: žan@example.net",
        "To: ops@kvitbit.com",
        "Subject: Příliš žlutý",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Ahoj",
      ].join("\r\n"),
      "utf8",
    );
    const msg: InboundMessage = {
      remoteIp: "203.0.113.10",
      tls: true,
      helo: "mail.example.net",
      mailFrom: "žan@example.net",
      rcptTo: ["ops@kvitbit.com"],
      rawBytes: raw,
    };
    const parsed = parseEmail(raw);
    expect(parsed.fromAddress).toBe("žan@example.net");
    const payload = buildResendForwardPayload({
      message: msg,
      parsed,
      deliveryFingerprint: computeDeliveryFingerprint(msg),
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(payload.reply_to).toBeUndefined();
    expect(String(payload.text)).toContain("Original From: žan@example.net");
  });

  test("decodes quoted-printable soft line breaks and parses multipart mixed + alternative + attachments", () => {
    const qp = decodeQuotedPrintable(Buffer.from("Hello =\r\nworld=21=0A", "latin1"));
    expect(Buffer.from(qp).toString("utf8")).toBe("Hello world!\n");

    const pdfBytes = Buffer.from("%PDF-1.4 sample invoice");
    const raw = [
      "From: =?UTF-8?B?RmFrdHVyYWNl?= <billing@vendor.cz>",
      "To: billing@kvitbit.com",
      "Reply-To: support@vendor.cz",
      "Subject: =?UTF-8?Q?Faktura_2026-001?=",
      "Date: Fri, 27 Nov 2026 12:00:00 +0000",
      "Message-ID: <msg-1@vendor.cz>",
      'Content-Type: multipart/mixed; boundary="outer-b"',
      "",
      "--outer-b",
      'Content-Type: multipart/alternative; boundary="inner-b"',
      "",
      "--inner-b",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Dobr=C3=BD den, zas=C3=ADl=C3=A1me fakturu.",
      "--inner-b",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("<p>Dobrý den, <b>faktura</b> v příloze.</p>", "utf8").toString("base64"),
      "--inner-b--",
      "--outer-b",
      'Content-Type: application/pdf; name="faktura.pdf"',
      'Content-Disposition: attachment; filename="faktura.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdfBytes.toString("base64"),
      "--outer-b--",
      "",
    ].join("\r\n");

    const parsed = parseEmail(Buffer.from(raw, "utf8"));
    expect(parsed.subject).toBe("Faktura 2026-001");
    expect(parsed.fromDisplayName).toBe("Fakturace");
    expect(parsed.fromAddress).toBe("billing@vendor.cz");
    expect(parsed.replyToAddress).toBe("support@vendor.cz");
    expect(parsed.text?.trim()).toBe("Dobrý den, zasíláme fakturu.");
    expect(parsed.html).toContain("<b>faktura</b>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "faktura.pdf",
      contentType: "application/pdf",
      sizeBytes: pdfBytes.byteLength,
      contentBase64: pdfBytes.toString("base64"),
    });
  });
});

describe("Effect MailRelay (GCS archive + Resend HTTPS)", () => {
  const sampleMessage: InboundMessage = {
    remoteIp: "203.0.113.10",
    tls: true,
    helo: "mail.resend.com",
    mailFrom: "bounces@resend.com",
    rcptTo: ["ops@kvitbit.com"],
    rawBytes: Buffer.from(
      [
        `From: =?UTF-8?B?${Buffer.from("Resend\r\nBcc: evil@attacker.tld", "utf8").toString("base64")}?= <verify@resend.com>`,
        "To: ops@kvitbit.com",
        "Subject: Verify your Resend account",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Click https://resend.com/verify?token=abc",
      ].join("\r\n"),
      "utf8",
    ),
  };

  test("builds hash-prefixed searchable GCS archive paths and sanitizes RFC 2047 CRLF injection", () => {
    const fp = computeDeliveryFingerprint(sampleMessage);
    const prefix = buildArchivePrefix(fp);
    const objectName = buildArchiveObjectName(
      new Date("2026-11-27T12:34:56.789Z"),
      fp,
      "abcdef123456",
    );
    expect(objectName).toStartWith(prefix);
    expect(objectName).toMatch(/^inbound\/by-hash\/[a-f0-9]{32}\/\d+-abcdef123456\.eml$/);

    const parsed = parseEmail(sampleMessage.rawBytes);
    const payload = buildResendForwardPayload({
      message: sampleMessage,
      parsed,
      deliveryFingerprint: fp,
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      maxAttachmentBytes: 7 * 1024 * 1024,
    });
    expect(payload.from).not.toContain("\r");
    expect(payload.from).not.toContain("\n");
    expect(payload.from).toContain("<forwarder@kvitbit.com>");
    expect(payload.to).toEqual(["filkalny@gmail.com"]);
    expect(payload.reply_to).toBe("verify@resend.com");
    expect(payload.subject).toBe("[ops] Verify your Resend account");
    expect(String(payload.text)).toContain(`gs://kvitbit-prod-mail-archive-prod/${prefix}`);

    const fallback = buildResendFallbackPayload({
      message: sampleMessage,
      parsed,
      deliveryFingerprint: fp,
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      rejectionStatus: 422,
    });
    expect(String(fallback.text)).toContain(`gs://kvitbit-prod-mail-archive-prod/${prefix}`);
  });

  test("reuses identical Idempotency-Key, archive prefix, and JSON payload across retries even when recipients are reordered", async () => {
    const resendRequests: Array<{ key: string | undefined; body: string }> = [];
    const uploadedNames: Array<string> = [];
    let attempt = 0;
    const msgOrderA: InboundMessage = {
      ...sampleMessage,
      rcptTo: ["ops@kvitbit.com", "founder@kvitbit.com"],
    };
    const msgOrderB: InboundMessage = {
      ...sampleMessage,
      rcptTo: ["founder@kvitbit.com", "ops@kvitbit.com"],
    };
    const layer = layerMailRelay({
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "resend",
      resendApiKey: Option.some(Redacted.make("re_test_key")),
    }).pipe(
      Layer.provide(
        mockHttpClientLayer((request) => {
          if (request.url.includes("metadata.google.internal")) {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 600 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (request.url.includes("storage.googleapis.com")) {
            const nameParam = new URL(request.url).searchParams.get("name");
            if (nameParam) uploadedNames.push(nameParam);
            return new Response(JSON.stringify({ name: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          attempt += 1;
          const bodyStr =
            request.body._tag === "Uint8Array"
              ? Buffer.from(request.body.body).toString("utf8")
              : "";
          resendRequests.push({
            key: request.headers["idempotency-key"],
            body: bodyStr,
          });
          if (attempt === 1) {
            return new Response("upstream timeout", { status: 504 });
          }
          return new Response(JSON.stringify({ id: "email_deduped" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      ),
    );

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        const firstRes = yield* relay.handleMessage(msgOrderA);
        const secondRes = yield* relay.handleMessage(msgOrderB);
        return { first: firstRes, second: secondRes };
      }).pipe(Effect.provide(layer)),
    );

    expect(first.smtpCode).toBe(451);
    expect(second.smtpCode).toBe(250);
    expect(resendRequests).toHaveLength(2);
    expect(resendRequests[0]?.key).toBeDefined();
    expect(resendRequests[0]?.key).toBe(resendRequests[1]?.key);
    expect(resendRequests[0]?.body).toBe(resendRequests[1]?.body);
    // Both uniquely named GCS objects live under the exact searchable hash prefix referenced in the payload.
    const expectedPrefix = buildArchivePrefix(computeDeliveryFingerprint(msgOrderA));
    const expectedArchiveUri = `gs://kvitbit-prod-mail-archive-prod/${expectedPrefix}`;
    expect(uploadedNames).toHaveLength(2);
    expect(uploadedNames[0]).toStartWith(expectedPrefix);
    expect(uploadedNames[1]).toStartWith(expectedPrefix);
    expect(uploadedNames[0]).not.toBe(uploadedNames[1]);
    const parsedReq = JSON.parse(resendRequests[0]?.body ?? "{}") as {
      text?: string;
      headers?: Record<string, string>;
    };
    expect(parsedReq.headers?.["X-Kvitbit-Archive-Prefix"]).toBe(expectedArchiveUri);
    expect(parsedReq.text).toContain(expectedArchiveUri);

    // Also send the oversized-attachment HTML fixture through the mocked relay and verify the
    // captured Resend HTML banner, text, and header all match that upload's exact directory prefix.
    const htmlWithBigAttachment = Buffer.from(
      [
        "From: vendor@example.org",
        "To: ops@kvitbit.com",
        "Subject: Huge PDF",
        'Content-Type: multipart/mixed; boundary="big-b"',
        "",
        "--big-b",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>See attachment</p>",
        "--big-b",
        'Content-Type: application/pdf; name="huge.pdf"',
        'Content-Disposition: attachment; filename="huge.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.alloc(256, 65).toString("base64"),
        "--big-b--",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const bigMsg: InboundMessage = {
      ...sampleMessage,
      rawBytes: htmlWithBigAttachment,
    };
    let capturedBigUploadName = "";
    let capturedBigResendBody = "";
    const bigLayer = layerMailRelay({
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "resend",
      resendApiKey: Option.some(Redacted.make("re_test_key")),
      maxForwardedAttachmentBytes: 100,
    }).pipe(
      Layer.provide(
        mockHttpClientLayer((request) => {
          if (request.url.includes("metadata.google.internal")) {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 600 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (request.url.includes("storage.googleapis.com")) {
            capturedBigUploadName = new URL(request.url).searchParams.get("name") ?? "";
            return new Response(JSON.stringify({ name: capturedBigUploadName }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          capturedBigResendBody =
            request.body._tag === "Uint8Array"
              ? Buffer.from(request.body.body).toString("utf8")
              : "";
          return new Response(JSON.stringify({ id: "email_big" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      ),
    );
    const bigRes = await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        return yield* relay.handleMessage(bigMsg);
      }).pipe(Effect.provide(bigLayer)),
    );
    expect(bigRes.smtpCode).toBe(250);
    const uploadedDir = capturedBigUploadName.slice(0, capturedBigUploadName.lastIndexOf("/") + 1);
    const bigExpectedUri = `gs://kvitbit-prod-mail-archive-prod/${uploadedDir}`;
    const bigPayload = JSON.parse(capturedBigResendBody) as {
      html?: string;
      text?: string;
      headers?: Record<string, string>;
    };
    expect(bigPayload.html).toContain(bigExpectedUri);
    expect(bigPayload.text).toContain(
      `Omitted large attachment(s): huge.pdf (256 bytes) (see ${bigExpectedUri})`,
    );
    expect(bigPayload.headers?.["X-Kvitbit-Archive-Prefix"]).toBe(bigExpectedUri);
  });

  test("archives to GCS and returns 250 without calling Resend in archive-only mode", async () => {
    const urls: Array<string> = [];
    const layer = layerMailRelay({
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "archive-only",
      resendApiKey: Option.none(),
    }).pipe(
      Layer.provide(
        mockHttpClientLayer((request) => {
          urls.push(request.url);
          if (request.url.includes("metadata.google.internal")) {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 600 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ name: "inbound/test.eml" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        return yield* relay.handleMessage(sampleMessage);
      }).pipe(Effect.provide(layer)),
    );
    expect(result.smtpCode).toBe(250);
    expect(result.archivePath).toStartWith("gs://kvitbit-prod-mail-archive-prod/inbound/");
    expect(urls.some((u) => u.includes("api.resend.com"))).toBe(false);
    expect(urls.some((u) => u.includes("storage.googleapis.com/upload/storage/v1/b/"))).toBe(true);
  });

  test("returns 451 when GCS archival fails (never acknowledges unarchived mail)", async () => {
    const layer = layerMailRelay({
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "resend",
      resendApiKey: Option.some(Redacted.make("re_test_key")),
    }).pipe(
      Layer.provide(
        mockHttpClientLayer((request) => {
          if (request.url.includes("metadata.google.internal")) {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 600 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("boom", { status: 503 });
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        return yield* relay.handleMessage(sampleMessage);
      }).pipe(Effect.provide(layer)),
    );
    expect(result.smtpCode).toBe(451);
  });

  test("forwards via Resend HTTPS API, retries via 451 on 429, and sends fallback notice on 422", async () => {
    let resendStatus = 200;
    let resendCalls = 0;
    const layer = layerMailRelay({
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "resend",
      resendApiKey: Option.some(Redacted.make("re_test_key")),
    }).pipe(
      Layer.provide(
        mockHttpClientLayer((request) => {
          if (request.url.includes("metadata.google.internal")) {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 600 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (request.url.includes("storage.googleapis.com")) {
            return new Response(JSON.stringify({ name: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          resendCalls += 1;
          if (resendStatus === 422 && resendCalls === 1) {
            return new Response(JSON.stringify({ message: "invalid attachment" }), { status: 422 });
          }
          if (resendStatus === 429) {
            return new Response("rate limited", { status: 429 });
          }
          return new Response(JSON.stringify({ id: "email_123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      ),
    );

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        const ok = yield* relay.handleMessage(sampleMessage);
        resendStatus = 429;
        const throttled = yield* relay.handleMessage(sampleMessage);
        resendStatus = 422;
        resendCalls = 0;
        const fallback = yield* relay.handleMessage(sampleMessage);
        return { ok, throttled, fallback, fallbackCalls: resendCalls };
      }).pipe(Effect.provide(layer)),
    );

    expect(outcome.ok.smtpCode).toBe(250);
    expect(outcome.ok.resendId).toBe("email_123");
    expect(outcome.throttled.smtpCode).toBe(451);
    expect(outcome.fallback.smtpCode).toBe(250);
    expect(outcome.fallbackCalls).toBe(2);
  });
});

describe("Effect SMTP server (RFC 5321 + RFC 6531 SMTPUTF8 + STARTTLS)", () => {
  test("parses envelope paths including empty bounce, SMTPUTF8 international sender, SIZE, and bare Postmaster", () => {
    expect(parseEnvelopePath("<>", true)).toEqual({ address: "" });
    expect(parseEnvelopePath("<>", false)).toBeUndefined();
    expect(parseEnvelopePath("<OPS@Kvitbit.com> SIZE=4096 BODY=8BITMIME", false)).toEqual({
      address: "ops@kvitbit.com",
      sizeParam: 4096,
    });
    expect(parseEnvelopePath("<žan@example.net> SMTPUTF8", true)).toEqual({
      address: "žan@example.net",
    });
    expect(parseEnvelopePath("<user@bücher.de>", true)).toEqual({
      address: "user@bücher.de",
    });
    expect(parseEnvelopePath("<Postmaster>", false, "kvitbit.com")).toEqual({
      address: "postmaster@kvitbit.com",
    });
    expect(parseEnvelopePath("<bad addr@example.net>", true)).toBeUndefined();
    expect(parseEnvelopePath("<test@example_.com>", true)).toBeUndefined();
    expect(parseEnvelopePath("<test@exam,ple.com>", true)).toBeUndefined();
    expect(parseEnvelopePath("<test@%65xample.org>", true)).toBeUndefined();
    expect(parseEnvelopePath("<test@example.org/path>", true)).toBeUndefined();
    expect(parseEnvelopePath("<test@192.0.2.1>", true)).toBeUndefined();
    // 60 'é' characters encode to a 66-octet punycode A-label (> 63-octet DNS limit per RFC 5890).
    expect(parseEnvelopePath(`<test@${"é".repeat(60)}.com>`, true)).toBeUndefined();
  });

  const runSmtpSession = (
    port: number,
    steps: ReadonlyArray<{ readonly send?: string; readonly upgradeTls?: boolean }>,
  ): Effect.Effect<Array<string>, Error> =>
    Effect.callback((resume) => {
      const replies: Array<string> = [];
      let sock: net.Socket | tls.TLSSocket = net.connect(port, "127.0.0.1");
      let stepIdx = 0;
      let buf = "";

      const advance = () => {
        if (stepIdx >= steps.length) {
          sock.end();
          resume(Effect.succeed(replies));
          return;
        }
        const step = steps[stepIdx];
        stepIdx += 1;
        if (!step) {
          sock.end();
          resume(Effect.succeed(replies));
          return;
        }
        if (step.upgradeTls) {
          const prev = sock;
          prev.removeAllListeners("data");
          const secure = tls.connect(
            { socket: prev as net.Socket, rejectUnauthorized: false },
            () => {
              sock = secure;
              attach(secure);
              advance();
            },
          );
          secure.on("error", (err) => resume(Effect.fail(err)));
          return;
        }
        if (step.send !== undefined) {
          sock.write(step.send);
        }
      };

      const attach = (target: net.Socket | tls.TLSSocket) => {
        target.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const lines = buf.split("\r\n");
          buf = lines.pop() ?? "";
          let completeReply = false;
          for (const line of lines) {
            if (!line) continue;
            replies.push(line);
            if (/^\d{3} /.test(line)) {
              completeReply = true;
            }
          }
          if (completeReply) {
            advance();
          }
        });
        target.on("error", (err) => resume(Effect.fail(err)));
      };

      attach(sock);
    });

  test("enforces allowlist, bare Postmaster, SMTPUTF8, strict both-sides CRLF DATA termination, size cap, and STARTTLS", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "kvitbit-smtp-tls-"));
    try {
      execSync(
        `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 1 -nodes -subj "/CN=mx.kvitbit.com"`,
        { stdio: "ignore" },
      );
      const tlsCert = readFileSync(`${certDir}/cert.pem`);
      const tlsKey = readFileSync(`${certDir}/key.pem`);

      const received: Array<InboundMessage> = [];
      const replies = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bound = yield* startSmtpServer({
              host: "127.0.0.1",
              port: 0,
              domain: "kvitbit.com",
              mxHost: "mx.kvitbit.com",
              allowedRecipients: new Set([
                "ops@kvitbit.com",
                "founder@kvitbit.com",
                "postmaster@kvitbit.com",
              ]),
              tlsCert,
              tlsKey,
              maxMessageBytes: 2048,
              onMessage: (msg) =>
                Effect.sync(() => {
                  received.push(msg);
                  return { smtpCode: 250 as const, smtpMessage: "2.0.0 OK" };
                }),
            });

            return yield* runSmtpSession(bound.port, [
              { send: "EHLO sender.example.com\r\n" },
              { send: "STARTTLS\r\n" },
              { upgradeTls: true },
              { send: "EHLO sender.example.com\r\n" },
              { send: "MAIL FROM:<žan@example.net> SIZE=99999\r\n" },
              { send: "MAIL FROM:<žan@example.net> SIZE=200 SMTPUTF8\r\n" },
              { send: "RCPT TO:<unknown@kvitbit.com>\r\n" },
              { send: "RCPT TO:<OPS@kvitbit.com>\r\n" },
              { send: "RCPT TO:<Postmaster>\r\n" },
              { send: "DATA\r\n" },
              {
                // Verify BOTH smuggling variants fail to terminate DATA:
                // 1) bare LF after dot (`\r\n.\n`)
                // 2) bare LF before dot (`\n.\r\n`)
                send: "Subject: Příliš žlutý\r\n\r\n..leading dot\r\nsmuggle1\r\n.\nsmuggle2\n.\r\nstill body\r\n.\r\n",
              },
              { send: "QUIT\r\n" },
            ]);
          }),
        ),
      );

      expect(replies[0]).toBe("220 mx.kvitbit.com ESMTP Kvitbit");
      expect(replies).toContain("250 STARTTLS");
      expect(replies).toContain("220 2.0.0 Ready to start TLS");
      expect(replies).toContain("552 5.3.4 Message size exceeds fixed maximum message size");
      expect(replies).toContain("550 5.1.1 User unknown");
      expect(replies).toContain("250 2.1.5 OK");
      expect(replies).toContain("250 2.0.0 OK");

      expect(received).toHaveLength(1);
      const firstMsg = received[0];
      if (!firstMsg) throw new Error("expected received message");
      expect(firstMsg.tls).toBe(true);
      expect(firstMsg.mailFrom).toBe("žan@example.net");
      expect(firstMsg.rcptTo).toEqual(["ops@kvitbit.com", "postmaster@kvitbit.com"]);
      const parsed = parseEmail(firstMsg.rawBytes);
      expect(parsed.subject).toBe("Příliš žlutý");
      expect(parsed.text).toContain(".leading dot");
      expect(parsed.text).toContain("smuggle1");
      expect(parsed.text).toContain("smuggle2");
      expect(parsed.text).toContain("still body");
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});

describe("Effect mail forwarder bundling, cold-pull reconciler, & Cloud DNS helpers", () => {
  test("bundles and compresses mail-forwarder deterministically within GCE 256 KB metadata limit", async () => {
    const first = await Effect.runPromise(bundleMailForwarderScript);
    const second = await Effect.runPromise(bundleMailForwarderScript);
    expect(first.sha).toBe(second.sha);
    expect(first.scriptB64Gz).toBe(second.scriptB64Gz);
    expect(first.sha).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.scriptB64Gz.length).toBeLessThan(200 * 1024);
    const decompressed = gunzipSync(Buffer.from(first.scriptB64Gz, "base64")).toString("utf8");
    expect(sha256Prefixed(decompressed)).toBe(first.sha);
    expect(MAIL_FORWARDER_BUN_IMAGE_REF).toBe(`oven/bun@${MAIL_FORWARDER_BUN_IMAGE_DIGEST}`);
  });

  test("generated reconcile-mail.sh cold-pulls image with Docker 29 RepoDigests normalization, decompresses script, and publishes active target", async () => {
    const bundle = await Effect.runPromise(bundleMailForwarderScript);
    const startup = buildMailForwarderStartupScript();
    const match = startup.match(
      /cat <<'RECONCILE' > \/var\/lib\/kvitbit-mail\/reconcile-mail\.sh\n([\s\S]*?)\nRECONCILE/,
    );
    if (!match?.[1]) throw new Error("Failed to extract reconcile-mail.sh from startup script");
    const reconcileScript = match[1];

    const runtimeCfg = serializeMailForwarderConfig({
      version: 1,
      projectId: "kvitbit-prod",
      mxHost: "mx.kvitbit.com",
      domain: "kvitbit.com",
      forwardTo: "filkalny@gmail.com",
      forwardFrom: "forwarder@kvitbit.com",
      aliases: ["founder", "ops"],
      archiveBucket: "kvitbit-prod-mail-archive-prod",
      relayMode: "archive-only",
      smtpPort: 2525,
      healthPort: 8081,
      resendSecretId: undefined,
    });
    const runtimeCfgSha = sha256Prefixed(runtimeCfg);
    const imageId = `sha256:${"c".repeat(64)}`;

    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-mail-reconcile-"));
    try {
      const binDir = join(sandbox, "bin");
      const metaDir = join(sandbox, "meta");
      const stateDir = join(sandbox, "state");
      const runDir = join(sandbox, "run");
      const guestAttrPath = join(sandbox, "guest-attr.txt");
      const pulledMarker = join(sandbox, "pulled");
      const runningMarker = join(sandbox, "running");

      execSync(`mkdir -p "${binDir}" "${metaDir}" "${stateDir}" "${runDir}"`);
      writeFileSync(join(sandbox, "reconcile-mail.sh"), reconcileScript, { mode: 0o700 });
      writeFileSync(join(metaDir, "kvitbit-mail-image-digest"), MAIL_FORWARDER_BUN_IMAGE_DIGEST);
      // Test with docker.io/ prefix in metadata while Docker 29 RepoDigests returns short `oven/bun@sha256:...`
      writeFileSync(
        join(metaDir, "kvitbit-mail-image-ref"),
        `docker.io/oven/bun@${MAIL_FORWARDER_BUN_IMAGE_DIGEST}`,
      );
      writeFileSync(join(metaDir, "kvitbit-mail-config"), runtimeCfg);
      writeFileSync(join(metaDir, "kvitbit-mail-config-sha"), runtimeCfgSha);
      writeFileSync(join(metaDir, "kvitbit-mail-script-b64gz"), bundle.scriptB64Gz);
      writeFileSync(join(metaDir, "kvitbit-mail-script-sha"), bundle.sha);

      // Stub curl for GCE metadata, guest-attributes, and localhost /healthz
      writeFileSync(
        join(binDir, "curl"),
        `#!/bin/bash
set -euo pipefail
url=""
method="GET"
data=""
dump_header=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
prev=""
for arg in "$@"; do
  if [ "$prev" = "-X" ]; then method="$arg"; fi
  if [ "$prev" = "--data" ]; then data="$arg"; fi
  if [ "$prev" = "--dump-header" ]; then dump_header="$arg"; fi
  prev="$arg"
done
if [[ "$url" == *"/instance/attributes/?recursive=true" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\nETag: etag-1\\r\\n\\r\\n'
  exit 0
fi
if [[ "$url" == *"/instance/attributes/"* ]]; then
  key="\${url##*/}"
  cat "${metaDir}/$key"
  exit 0
fi
if [[ "$url" == *"/instance/guest-attributes/kvitbit/mail-active-target" ]] && [ "$method" = "PUT" ]; then
  printf '%s' "$data" > "${guestAttrPath}"
  exit 0
fi
if [[ "$url" == "http://127.0.0.1:8081/healthz" ]]; then
  [ -f "${runningMarker}" ] || exit 7
  printf '{"status":"ok"}'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      // Stub docker simulating Docker 29 returning short `oven/bun@sha256:...` in RepoDigests
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/bash
set -euo pipefail
if [ "$1" = "pull" ]; then
  touch "${pulledMarker}"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  [ -f "${pulledMarker}" ] || exit 1
  printf '%s\\n%s\\n' "${imageId}" "oven/bun@${MAIL_FORWARDER_BUN_IMAGE_DIGEST}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  [ -f "${runningMarker}" ] || exit 1
  printf 'true|%s|%s|%s|%s\\n' "${imageId}" "${MAIL_FORWARDER_BUN_IMAGE_DIGEST}" "${runtimeCfgSha}" "${bundle.sha}"
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      writeFileSync(
        join(binDir, "systemctl"),
        `#!/bin/bash
if [ "$1" = "start" ]; then touch "${runningMarker}"; fi
if [ "$1" = "stop" ]; then rm -f "${runningMarker}"; fi
exit 0
`,
        { mode: 0o755 },
      );
      writeFileSync(join(binDir, "iptables"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(binDir, "chown"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const result = Bun.spawnSync(["bash", join(sandbox, "reconcile-mail.sh")], {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          KVITBIT_MAIL_STATE_DIR: stateDir,
          KVITBIT_MAIL_RUN_DIR: runDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `reconcile-mail.sh failed (${result.exitCode}): ${result.stderr.toString()}`,
        );
      }
      expect(readFileSync(guestAttrPath, "utf8")).toBe(
        `${MAIL_FORWARDER_BUN_IMAGE_DIGEST}|${runtimeCfgSha}|${bundle.sha}`,
      );
      const installedScript = readFileSync(join(stateDir, "mail-forwarder.mjs"), "utf8");
      expect(sha256Prefixed(installedScript)).toBe(bundle.sha);
      const envContent = readFileSync(join(runDir, "mail.env"), "utf8");
      expect(envContent).toContain("KVITBIT_MAIL_DOMAIN=kvitbit.com");
      expect(envContent).toContain("KVITBIT_MAIL_ALIASES=founder,ops");
      expect(envContent).toContain("KVITBIT_MAIL_RELAY_MODE=archive-only");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("formats long Cloud DNS TXT records (>255 bytes DKIM) and normalizes MX records", () => {
    expect(formatCloudDnsTxt("v=DMARC1; p=quarantine")).toBe('"v=DMARC1; p=quarantine"');
    const longDkim = `v=DKIM1; k=rsa; p=${"A".repeat(380)}`;
    const formatted = formatCloudDnsTxt(longDkim);
    const chunks = formatted.match(/"[^"]*"/g) ?? [];
    expect(chunks.length).toBe(2);
    expect((chunks[0]?.length ?? 0) - 2).toBeLessThanOrEqual(255);
    expect((chunks[1]?.length ?? 0) - 2).toBeLessThanOrEqual(255);
    expect(chunks.map((c) => c.slice(1, -1)).join("")).toBe(longDkim);

    expect(normalizeMxRrdata("10 feedback-smtp.eu-west-1.amazonses.com")).toBe(
      "10 feedback-smtp.eu-west-1.amazonses.com.",
    );
    expect(normalizeMxRrdata("10 feedback-smtp.eu-west-1.amazonses.com.")).toBe(
      "10 feedback-smtp.eu-west-1.amazonses.com.",
    );
  });
});
