import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { GcsAccessToken, GcsAccessTokens, metadataServerTokenUrl } from "../../src/blob/index";

/** A metadata server answering with `answers` in turn (the last one repeats). */
const metadata = (answers: ReadonlyArray<() => Response>) => {
  const seen: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    const answer = answers[Math.min(seen.length, answers.length - 1)];
    seen.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, answer?.() ?? new Response(null, { status: 500 })),
    );
  });
  const layer = GcsAccessTokens.metadataServer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { seen, layer };
};

const token = (value: string, expiresIn: number) => () =>
  Response.json({ access_token: value, expires_in: expiresIn, token_type: "Bearer" });

const run = <A, E>(
  layer: Layer.Layer<GcsAccessToken>,
  f: (t: GcsAccessToken["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* GcsAccessToken);
    }).pipe(Effect.provide(layer)),
  );

describe("GcsAccessTokens.metadataServer", () => {
  test("asks the metadata server with Metadata-Flavor and caches the token", async () => {
    const server = metadata([token("t1", 3600), token("t2", 3600)]);
    const tokens = await run(server.layer, (t) => Effect.all([t.get, t.get, t.get]));
    expect(tokens).toEqual(["t1", "t1", "t1"]);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.url).toBe(metadataServerTokenUrl);
    expect(server.seen[0]?.headers["metadata-flavor"]).toBe("Google");
  });

  test("refreshes a token within a minute of expiry", async () => {
    const server = metadata([token("t1", 60), token("t2", 3600)]);
    const tokens = await run(server.layer, (t) => Effect.all([t.get, t.get, t.get]));
    expect(tokens).toEqual(["t1", "t2", "t2"]);
  });

  test("invalidate drops only the named token", async () => {
    const server = metadata([token("t1", 3600), token("t2", 3600)]);
    const tokens = await run(server.layer, (t) =>
      Effect.gen(function* () {
        const first = yield* t.get;
        yield* t.invalidate("other");
        const same = yield* t.get;
        yield* t.invalidate(first);
        return [first, same, yield* t.get];
      }),
    );
    expect(tokens).toEqual(["t1", "t1", "t2"]);
  });

  test("a refusal or a malformed answer is a GcsAccessTokenError without the body", async () => {
    const refused = metadata([() => new Response("secret detail", { status: 403 })]);
    const error = await run(refused.layer, (t) => Effect.flip(t.get));
    expect(error).toMatchObject({ _tag: "GcsAccessTokenError", reason: "status", httpStatus: 403 });
    expect(JSON.stringify(error)).not.toContain("secret detail");

    const malformed = metadata([() => Response.json({ access_token: "" })]);
    const invalid = await run(malformed.layer, (t) => Effect.flip(t.get));
    expect(invalid).toMatchObject({ reason: "invalid-response" });
  });
});
