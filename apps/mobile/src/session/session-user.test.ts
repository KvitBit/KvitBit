import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeAuthFetch } from "./auth-http";
import { readSessionUser } from "./session-user";

describe("session", () => {
  test("reads the Better Auth get-session body", () => {
    expect(readSessionUser(null)).toBeNull();
    expect(
      readSessionUser({ user: { id: "u", email: "a@b.cz", name: "A", emailVerified: true } }),
    ).toEqual({
      id: "u",
      email: "a@b.cz",
      name: "A",
      emailVerified: true,
    });
  });

  test("auth fetch sends the bearer and picks up a rotated token", () => {
    const requests: { url: string; auth: string | null }[] = [];
    const auth = makeAuthFetch(
      "https://kvitbit.test",
      () => "tok",
      (url, init) => {
        requests.push({ url: url.href, auth: new Headers(init.headers).get("authorization") });
        return Effect.runPromise(
          Effect.succeed(new Response('{"ok":1}', { headers: { "set-auth-token": "next" } })),
        );
      },
    );
    return auth("/sign-in/email", { body: { email: "a" } }).then((response) => {
      expect(requests).toEqual([
        {
          url: "https://kvitbit.test/api/auth/sign-in/email",
          auth: "Bearer tok",
        },
      ]);
      expect(response.token).toBe("next");
      expect(response.body).toEqual({ ok: 1 });
    });
  });
});
