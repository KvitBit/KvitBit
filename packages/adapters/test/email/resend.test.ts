import { describe, expect, test } from "bun:test";
import {
  makeResendEmailSender,
  RESEND_PROVIDER,
  resendIdempotencyKey,
} from "@kvitbit/adapters/email";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { failureTags, message } from "./fixtures";

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(json);
const encodeJson = Schema.encodeEffect(json);
const digestKey = /^sha256-[0-9a-f]{64}$/;

type Reply =
  | { readonly status: number; readonly body?: unknown }
  | { readonly transport: unknown }
  | "hang";

const fakeClient = (reply: Reply, seen: Array<Seen>) =>
  HttpClient.make(
    Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest, url: URL) {
      const body =
        request.body._tag === "Uint8Array"
          ? yield* decodeJson(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
          : undefined;
      seen.push({ url: url.toString(), headers: request.headers, body });
      if (reply === "hang") return yield* Effect.never;
      if ("transport" in reply) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: reply.transport }),
        });
      }
      const encoded =
        reply.body === undefined ? null : yield* encodeJson(reply.body).pipe(Effect.orDie);
      return HttpClientResponse.fromWeb(
        request,
        new Response(encoded, {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

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
  }).pipe(Effect.provideService(HttpClient.HttpClient, fakeClient(reply, seen)));
  return Effect.runPromiseExit(program).then((exit) => ({ exit, seen }));
};

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
    const long = Str.repeat(300)("k");
    expect(resendIdempotencyKey(long)).toMatch(digestKey);
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
    [408, "EmailOutcomeUnknown"],
    [425, "EmailNotAccepted"],
    [413, "EmailRejected"],
  ])("status %i fails with %s", async (status, tag) => {
    const { exit } = await send({ status, body: { name: "error" } });
    const tags = failureTags(exit);
    expect(tags).toEqual([tag]);
  });

  test("a 2xx answer without an id is an unknown outcome", async () => {
    const { exit } = await send({ status: 200, body: { ok: true } });
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailOutcomeUnknown"]);
  });

  test("a timeout is an unknown outcome", async () => {
    const { exit } = await send("hang");
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailOutcomeUnknown"]);
  });

  test("a refused connection is not accepted", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { exit } = await send({ transport: cause });
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailNotAccepted"]);
  });

  test("a dropped connection after sending is an unknown outcome", async () => {
    const { exit } = await send({
      transport: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const tags = failureTags(exit);
    expect(tags).toEqual(["EmailOutcomeUnknown"]);
  });

  test("failure causes never retain the request or its Authorization header", async () => {
    const { exit } = await send({
      transport: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const serialized = Effect.runSync(
      encodeJson(
        Exit.isFailure(exit)
          ? Arr.map(exit.cause.reasons, (r) => ("error" in r ? r.error : r))
          : [],
      ),
    );
    expect(serialized).not.toContain("re_test");
    expect(serialized).toContain("ECONNRESET");
  });
});
