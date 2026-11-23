import { describe, expect, test } from "bun:test";
import { layerResend, layerSmtp } from "@kvitbit/adapters/email";
import { EmailSender } from "@kvitbit/domain/ports";
import { Effect, Exit, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { message } from "./fixtures";
import { selfSignedCert, selfSignedKey } from "./tls-fixture";

/** A local port with nothing listening: the real clients fail before connecting. */
const closedPort = async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
};

const sendWith = (layer: Layer.Layer<EmailSender>) =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        const sender = yield* EmailSender;
        return yield* sender.send(message(), { idempotencyKey: "k1" });
      }).pipe(Effect.provide(layer)),
    ),
  );

const failureTags = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error._tag as string) : r._tag))
    : [];

describe("real transports against a closed port", () => {
  test("nodemailer connection refusal is EmailNotAccepted", async () => {
    const port = await closedPort();
    const exit = await sendWith(
      layerSmtp(
        { host: "127.0.0.1", port, secure: false, connectionTimeout: 2000 },
        { from: "Kvitbit <noreply@kvitbit.cz>" },
      ),
    );
    expect(failureTags(exit)).toEqual(["EmailNotAccepted"]);
  });

  test("fetch connection refusal is EmailNotAccepted", async () => {
    const port = await closedPort();
    const exit = await sendWith(
      layerResend({
        apiKey: Redacted.make("re_test"),
        from: "Kvitbit <noreply@kvitbit.cz>",
        baseUrl: `http://127.0.0.1:${port}`,
        timeout: "2 seconds",
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    );
    expect(failureTags(exit)).toEqual(["EmailNotAccepted"]);
  });

  test("nodemailer refusing an untrusted TLS certificate is EmailNotAccepted", async () => {
    let received = "";
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: selfSignedCert, key: selfSignedKey },
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
          { host: "127.0.0.1", port: server.port, secure: true, connectionTimeout: 2000 },
          { from: "Kvitbit <noreply@kvitbit.cz>" },
        ),
      );
      expect(failureTags(exit)).toEqual(["EmailNotAccepted"]);
      expect(received).not.toContain("DATA");
    } finally {
      server.stop(true);
    }
  });

  test.each([
    ["accepts", "250 2.0.0 queued", "ok"],
    ["never answers after DATA", undefined, "EmailOutcomeUnknown"],
    ["refuses after DATA with 554", "554 5.7.1 rejected", "EmailRejected"],
    ["defers after DATA with 451", "451 4.3.0 try later", "EmailNotAccepted"],
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
      if (expected === "ok") {
        expect(exit).toEqual(
          Exit.succeed({ provider: "smtp", providerMessageId: "<k1@kvitbit.cz>" }),
        );
      } else {
        expect(failureTags(exit)).toEqual([expected]);
      }
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
        while (true) {
          if (socket.data.inData) {
            const end = socket.data.buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            socket.data.buffer = socket.data.buffer.slice(end + 5);
            socket.data.inData = false;
            if (finalReply !== undefined) socket.write(`${finalReply}\r\n`);
            continue;
          }
          const lineEnd = socket.data.buffer.indexOf("\r\n");
          if (lineEnd < 0) return;
          const line = socket.data.buffer.slice(0, lineEnd).toUpperCase();
          socket.data.buffer = socket.data.buffer.slice(lineEnd + 2);
          if (line.startsWith("EHLO")) socket.write("250-stub\r\n250 8BITMIME\r\n");
          else if (line.startsWith("DATA")) {
            socket.data.inData = true;
            socket.write("354 go ahead\r\n");
          } else if (line.startsWith("QUIT")) socket.write("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      },
    },
  });
