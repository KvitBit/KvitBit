import { describe, expect, test } from "bun:test";
import {
  makeSmtpEmailSender,
  SMTP_PROVIDER,
  type SmtpMail,
  smtpMessageId,
} from "@kvitbit/adapters/email";
import { Effect, Exit } from "effect";
import { message } from "./fixtures";

const smtpError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.code ?? "smtp")), fields);

const run = (
  outcome: "ok" | Error,
  key = "delivery-1",
  recipients: { accepted?: Array<string>; rejected?: Array<string> } = {},
) => {
  const sent: Array<SmtpMail> = [];
  const sender = makeSmtpEmailSender(
    {
      sendMail: async (mail) => {
        sent.push(mail);
        if (outcome !== "ok") throw outcome;
        return { messageId: mail.messageId, ...recipients };
      },
    },
    { from: "Kvitbit <noreply@kvitbit.cz>" },
  );
  return Effect.runPromise(Effect.exit(sender.send(message(), { idempotencyKey: key }))).then(
    (exit) => ({ exit, sent }),
  );
};

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((r) => ("error" in r ? r.error._tag : r._tag)) : [];

describe("SmtpEmailSender", () => {
  test("sends the mapped mail and uses the idempotency key as Message-ID", async () => {
    const { exit, sent } = await run("ok");
    expect(exit).toEqual(
      Exit.succeed({ provider: SMTP_PROVIDER, providerMessageId: "<delivery-1@kvitbit.cz>" }),
    );
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail?.from).toBe("Kvitbit <noreply@kvitbit.cz>");
    expect(mail?.to).toEqual(["jana@klient.cz"]);
    expect(mail?.cc).toEqual(["ucetni@klient.cz"]);
    expect(mail?.replyTo).toBe("Studio Nováková <studio@novakova.cz>");
    expect(mail?.subject).toBe("Faktura 2026-0042");
    expect(mail?.text).toBe("Dobrý den");
    expect(mail?.html).toBe("<p>Dobrý den</p>");
    expect(mail?.attachments[0]?.filename).toBe("faktura.pdf");
    expect([...(mail?.attachments[0]?.content ?? [])]).toEqual([1, 2, 3]);
    expect(mail?.headers).toEqual({
      "X-Kvitbit-Tag-template": "E01",
      "X-Kvitbit-Tag-workspace-id": "ws_1",
    });
  });

  test("Message-ID is stable per key and hashes keys it cannot carry", () => {
    expect(smtpMessageId("a b<c>", "kvitbit.cz")).toMatch(/^<sha256-[0-9a-f]{64}@kvitbit\.cz>$/);
    expect(smtpMessageId("a b<c>", "kvitbit.cz")).toBe(smtpMessageId("a b<c>", "kvitbit.cz"));
    expect(smtpMessageId("d-1", "kvitbit.cz")).toBe("<d-1@kvitbit.cz>");
  });

  test.each([
    [
      "5xx recipient refusal",
      { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" },
      "EmailRejected",
    ],
    ["5xx after DATA", { code: "EMESSAGE", responseCode: 554, command: "DATA" }, "EmailRejected"],
    ["envelope error without reply", { code: "EENVELOPE" }, "EmailRejected"],
    [
      "5xx authentication",
      { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" },
      "EmailNotAccepted",
    ],
    [
      "4xx greylisting",
      { code: "EENVELOPE", responseCode: 451, command: "RCPT TO" },
      "EmailNotAccepted",
    ],
    [
      "4xx after DATA",
      { code: "EMESSAGE", responseCode: 452, command: "DATA" },
      "EmailNotAccepted",
    ],
    [
      "refused connection",
      { code: "ESOCKET", originalCode: "ECONNREFUSED", command: "CONN" },
      "EmailNotAccepted",
    ],
    ["DNS failure", { code: "EDNS", command: "CONN" }, "EmailNotAccepted"],
    [
      "connect timeout",
      { code: "ETIMEDOUT", timeoutType: "CONNECT_TIMEOUT", command: "CONN" },
      "EmailNotAccepted",
    ],
    [
      "greeting timeout",
      { code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT", command: "CONN" },
      "EmailNotAccepted",
    ],
    [
      "socket timeout after DATA",
      { code: "ETIMEDOUT", timeoutType: "SOCKET_TIMEOUT", command: "CONN" },
      "EmailOutcomeUnknown",
    ],
    ["dropped connection", { code: "ECONNECTION", command: "CONN" }, "EmailOutcomeUnknown"],
    ["unrecognised failure", { code: "EWHATEVER" }, "EmailOutcomeUnknown"],
  ])("%s fails with the right error", async (_name, fields, tag) => {
    const { exit } = await run(smtpError(fields));
    expect(failureTag(exit)).toEqual([tag]);
  });

  test("a partial recipient refusal still succeeds: some recipients have the message", async () => {
    const { exit } = await run("ok", "delivery-1", {
      accepted: ["jana@klient.cz"],
      rejected: ["ucetni@klient.cz"],
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a resolution with every recipient refused is a rejection", async () => {
    const { exit } = await run("ok", "delivery-1", { accepted: [], rejected: ["jana@klient.cz"] });
    expect(failureTag(exit)).toEqual(["EmailRejected"]);
  });
});
