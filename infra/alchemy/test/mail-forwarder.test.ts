import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  buildResendForwardPayload,
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
  test("decodes RFC 2047 UTF-8 headers and extracts addresses safely", () => {
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

  test("builds date-partitioned GCS archive paths and sanitizes RFC 2047 CRLF injection", () => {
    const objectName = buildArchiveObjectName(new Date("2026-11-27T12:34:56.789Z"), "abcdef123456");
    expect(objectName).toMatch(/^inbound\/2026\/11\/27\/\d+-abcdef123456\.eml$/);

    const parsed = parseEmail(sampleMessage.rawBytes);
    const payload = buildResendForwardPayload({
      message: sampleMessage,
      parsed,
      archiveUri: `gs://kvitbit-prod-mail-archive-prod/${objectName}`,
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

describe("Effect SMTP server (RFC 5321 + STARTTLS)", () => {
  test("parses envelope paths including empty bounce sender and SIZE extension", () => {
    expect(parseEnvelopePath("<>", true)).toEqual({ address: "" });
    expect(parseEnvelopePath("<>", false)).toBeUndefined();
    expect(parseEnvelopePath("<OPS@Kvitbit.com> SIZE=4096 BODY=8BITMIME", false)).toEqual({
      address: "ops@kvitbit.com",
      sizeParam: 4096,
    });
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

  test("enforces recipient allowlist, dot-unstuffing, SMTP smuggling protection, size cap, and STARTTLS", async () => {
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
              mxHost: "mx.kvitbit.com",
              allowedRecipients: new Set(["ops@kvitbit.com", "founder@kvitbit.com"]),
              tlsCert,
              tlsKey,
              maxMessageBytes: 1024,
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
              { send: "MAIL FROM:<verify@resend.com> SIZE=99999\r\n" },
              { send: "MAIL FROM:<verify@resend.com> SIZE=200\r\n" },
              { send: "RCPT TO:<unknown@kvitbit.com>\r\n" },
              { send: "RCPT TO:<OPS@kvitbit.com>\r\n" },
              { send: "DATA\r\n" },
              {
                send: "Subject: Hello\r\n\r\n..leading dot\r\nnot-end\n.\nstill body\r\n.\r\n",
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
      expect(firstMsg.rcptTo).toEqual(["ops@kvitbit.com"]);
      const body = Buffer.from(firstMsg.rawBytes).toString("utf8");
      expect(body).toContain("\r\n.leading dot\r\n");
      expect(body).toContain("not-end\r\n.\r\nstill body");
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});

describe("Effect mail forwarder bundling & Cloud DNS helpers", () => {
  test("bundles and compresses mail-forwarder deterministically within GCE 256 KB metadata limit", async () => {
    const first = await Effect.runPromise(bundleMailForwarderScript);
    const second = await Effect.runPromise(bundleMailForwarderScript);
    expect(first.sha).toBe(second.sha);
    expect(first.scriptB64Gz).toBe(second.scriptB64Gz);
    expect(first.sha).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.scriptB64Gz.length).toBeLessThan(200 * 1024);
    const decompressed = gunzipSync(Buffer.from(first.scriptB64Gz, "base64")).toString("utf8");
    expect(sha256Prefixed(decompressed)).toBe(first.sha);
    expect(MAIL_FORWARDER_BUN_IMAGE_REF).toBe(
      `docker.io/oven/bun@${MAIL_FORWARDER_BUN_IMAGE_DIGEST}`,
    );
  });

  test("startup script hardens container, decompresses script, and redirects TCP 25 -> 2525", () => {
    const script = buildMailForwarderStartupScript();
    expect(script).toContain("kvitbit-mail-script-b64gz");
    expect(script).toContain("base64 -d | gunzip");
    expect(script).toContain("PREROUTING -p tcp --dport 25 -j REDIRECT --to-port");
    expect(script).toContain("--read-only --cap-drop=ALL --security-opt=no-new-privileges:true");
    expect(script).toContain("--user 1000:1000");
    expect(script).toContain("/bin/bash /var/lib/kvitbit-mail/reconcile-mail.sh");
    expect(script).toContain("mail-active-target");
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
