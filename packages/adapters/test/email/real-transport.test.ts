import { describe, expect, test } from "bun:test";
import { layerResend, layerSmtp } from "@kvitbit/adapters/email";
import { EmailSender } from "@kvitbit/domain/ports";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Str from "effect/String";
import { failureTags, message } from "./fixtures";
import {
  clientOnlyCert,
  clientOnlyKey,
  selfSignedCert,
  selfSignedKey,
  testCa,
} from "./tls-fixture";

/** A local port with nothing listening: the real clients fail before connecting. */
const closedPort = () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
  const port = server.port;
  server.stop(true);
  return port;
};

const sendWith = (layer: Layer.Layer<EmailSender>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sender = yield* EmailSender;
      return yield* sender.send(message(), { idempotencyKey: "k1" });
    }).pipe(Effect.provide(layer)),
  );

describe("real transports against a closed port", () => {
  test("nodemailer connection refusal is EmailNotAccepted", async () => {
    const port = closedPort();
    const exit = await sendWith(
      layerSmtp(
        { host: "127.0.0.1", port, secure: false, connectionTimeout: 2000 },
        { from: "Kvitbit <noreply@kvitbit.cz>" },
      ),
    );
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailNotAccepted"]);
  });

  test("fetch connection refusal is EmailNotAccepted", async () => {
    const port = closedPort();
    const exit = await sendWith(
      layerResend({
        apiKey: Redacted.make("re_test"),
        from: "Kvitbit <noreply@kvitbit.cz>",
        baseUrl: `http://127.0.0.1:${port}`,
        timeout: "2 seconds",
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    );
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailNotAccepted"]);
  });

  test.each([
    ["self-signed", { cert: selfSignedCert, key: selfSignedKey }, {}],
    [
      "client-auth-only (INVALID_PURPOSE)",
      { cert: clientOnlyCert, key: clientOnlyKey },
      { tls: { ca: testCa } },
    ],
  ])("nodemailer refusing a %s TLS certificate is EmailNotAccepted", async (_name, tls, extra) => {
    let received = "";
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls,
      socket: {
        open(socket) {
          socket.write("220 stub ESMTP\r\n");
        },
        data(socket, chunk) {
          received += new TextDecoder().decode(chunk);
          socket.write("250 ok\r\n");
        },
      },
    });
    try {
      const exit = await sendWith(
        layerSmtp(
          { host: "127.0.0.1", port: server.port, secure: true, connectionTimeout: 2000, ...extra },
          { from: "Kvitbit <noreply@kvitbit.cz>" },
        ),
      );
      const tags = failureTags(exit);
      expect(tags).toEqual(["EmailNotAccepted"]);
      expect(received).not.toContain("DATA");
    } finally {
      server.stop(true);
    }
  });

  test.each([
    ["accepts", "250 2.0.0 queued", { provider: "smtp", providerMessageId: "<k1@kvitbit.cz>" }],
    ["never answers after DATA", undefined, ["EmailOutcomeUnknown"]],
    ["refuses after DATA with 554", "554 5.7.1 rejected", ["EmailRejected"]],
    ["defers after DATA with 451", "451 4.3.0 try later", ["EmailNotAccepted"]],
  ])("nodemailer against an SMTP stub that %s", async (_name, finalReply, expected) => {
    const server = smtpStub(finalReply);
    try {
      const exit = await sendWith(
        layerSmtp(
          {
            host: "127.0.0.1",
            port: server.port,
            secure: false,
            ignoreTLS: true,
            socketTimeout: 300,
          },
          { from: "Kvitbit <noreply@kvitbit.cz>" },
        ),
      );
      const actual = Exit.isSuccess(exit) ? exit.value : failureTags(exit);
      expect(actual).toEqual(expected);
    } finally {
      server.stop(true);
    }
  });
});

/** Minimal SMTP server: accepts the envelope and DATA, then answers the message with `finalReply`. */
const smtpStub = (finalReply: string | undefined) =>
  Bun.listen<{ inData: boolean; buffer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { inData: false, buffer: "" };
        socket.write("220 stub ESMTP\r\n");
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        while (socket.data.buffer.length > 0) {
          if (socket.data.inData) {
            const end = Str.indexOf("\r\n.\r\n")(socket.data.buffer);
            if (Option.isNone(end)) return;
            socket.data.buffer = Str.slice(end.value + 5)(socket.data.buffer);
            socket.data.inData = false;
            if (finalReply !== undefined) socket.write(`${finalReply}\r\n`);
            continue;
          }
          const lineEnd = Str.indexOf("\r\n")(socket.data.buffer);
          if (Option.isNone(lineEnd)) return;
          const line = Str.toUpperCase(Str.slice(0, lineEnd.value)(socket.data.buffer));
          socket.data.buffer = Str.slice(lineEnd.value + 2)(socket.data.buffer);
          if (Str.startsWith("EHLO")(line)) socket.write("250-stub\r\n250 8BITMIME\r\n");
          else if (Str.startsWith("DATA")(line)) {
            socket.data.inData = true;
            socket.write("354 go ahead\r\n");
          } else if (Str.startsWith("QUIT")(line)) socket.write("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      },
    },
  });
