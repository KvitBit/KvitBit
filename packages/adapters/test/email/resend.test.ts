import { describe, expect, test } from "bun:test";
import {
  makeResendEmailSender,
  RESEND_PROVIDER,
  resendIdempotencyKey,
} from "@kvitbit/adapters/email";
import { Effect, Exit, Layer, Redacted } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { message } from "./fixtures";

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Reply =
  | { readonly status: number; readonly body?: unknown }
  | { readonly transport: unknown }
  | "hang";

const fakeClient = (reply: Reply, seen: Array<Seen>) =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) => {
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    seen.push({ url: url.toString(), headers: request.headers, body });
    if (reply === "hang") return Effect.never;
    if ("transport" in reply) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: reply.transport }),
        }),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

const send = (reply: Reply, key = "delivery-1") => {
  const seen: Array<Seen> = [];
  const program = Effect.gen(function* () {
    const sender = yield* makeResendEmailSender({
      apiKey: Redacted.make("re_test"),
      from: "Kvitbit <noreply@kvitbit.cz>",
      baseUrl: "https://resend.test/",
      timeout: "50 millis",
    });
    return yield* sender.send(message(), { idempotencyKey: key });
  }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, fakeClient(reply, seen))));
  return Effect.runPromise(Effect.exit(program)).then((exit) => ({ exit, seen }));
};

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((r) => ("error" in r ? r.error._tag : r._tag)) : [];

describe("ResendEmailSender", () => {
  test("posts the message with the idempotency key and returns the Resend id", async () => {
    const { exit, seen } = await send({ status: 200, body: { id: "re_123" } });
    expect(exit).toEqual(Exit.succeed({ provider: RESEND_PROVIDER, providerMessageId: "re_123" }));
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.url).toBe("https://resend.test/emails");
    expect(request?.headers["idempotency-key"]).toBe("delivery-1");
    expect(request?.headers.authorization).toBe("Bearer re_test");
    expect(request?.body).toEqual({
      from: "Kvitbit <noreply@kvitbit.cz>",
      to: ["jana@klient.cz"],
      cc: ["ucetni@klient.cz"],
      reply_to: "Studio Nováková <studio@novakova.cz>",
      subject: "Faktura 2026-0042",
      html: "<p>Dobrý den</p>",
      text: "Dobrý den",
      attachments: [{ filename: "faktura.pdf", content: "AQID", content_type: "application/pdf" }],
      tags: [
        { name: "template", value: "E01" },
        { name: "workspace_id", value: "ws_1" },
      ],
    });
  });

  test("bounds long idempotency keys to a stable digest", () => {
    const long = "k".repeat(300);
    expect(resendIdempotencyKey(long)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(resendIdempotencyKey(long)).toBe(resendIdempotencyKey(long));
    expect(resendIdempotencyKey(`${long}x`)).not.toBe(resendIdempotencyKey(long));
    expect(resendIdempotencyKey("abc")).toBe("abc");
  });

  test.each([
    [400, "EmailRejected"],
    [422, "EmailRejected"],
    [429, "EmailNotAccepted"],
    [401, "EmailNotAccepted"],
    [403, "EmailNotAccepted"],
    [500, "EmailNotAccepted"],
    [503, "EmailNotAccepted"],
    [409, "EmailOutcomeUnknown"],
  ])("status %i fails with %s", async (status, tag) => {
    const { exit } = await send({ status, body: { name: "error" } });
    expect(failureTag(exit)).toEqual([tag]);
  });

  test("a 2xx answer without an id is an unknown outcome", async () => {
    const { exit } = await send({ status: 200, body: { ok: true } });
    expect(failureTag(exit)).toEqual(["EmailOutcomeUnknown"]);
  });

  test("a timeout is an unknown outcome", async () => {
    const { exit } = await send("hang");
    expect(failureTag(exit)).toEqual(["EmailOutcomeUnknown"]);
  });

  test("a refused connection is not accepted", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { exit } = await send({ transport: cause });
    expect(failureTag(exit)).toEqual(["EmailNotAccepted"]);
  });

  test("a dropped connection after sending is an unknown outcome", async () => {
    const { exit } = await send({
      transport: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    expect(failureTag(exit)).toEqual(["EmailOutcomeUnknown"]);
  });
});
