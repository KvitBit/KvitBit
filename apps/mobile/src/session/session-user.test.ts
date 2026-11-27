import { describe, expect, test } from "bun:test";
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

  test("auth fetch sends the bearer and picks up a rotated token", async () => {
    let seen = null as { url: string; auth: string | null } | null;
    const auth = makeAuthFetch(
      "https://kvitbit.test",
      () => "tok",
      async (url, init) => {
        seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
        return new Response(JSON.stringify({ ok: 1 }), { headers: { "set-auth-token": "next" } });
      },
    );
    const response = await auth("/sign-in/email", { body: { email: "a" } });
    expect(seen).toEqual({
      url: "https://kvitbit.test/api/auth/sign-in/email",
      auth: "Bearer tok",
    });
    expect(response.token).toBe("next");
    expect(response.body).toEqual({ ok: 1 });
  });
});
