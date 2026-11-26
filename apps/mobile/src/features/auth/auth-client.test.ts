import { describe, expect, test } from "bun:test";
import type { PasskeyBridge } from "../../platform/passkeys/passkey-bridge";
import type { AuthFetch, AuthRequest, AuthResponse } from "../../session/auth-http";
import { makeAuthClient } from "./auth-client";

const sampleUser = {
  id: "u_1",
  email: "jana@kvitbit.cz",
  name: "Jana",
  emailVerified: true,
};

const makeHarness = (
  handler: (path: string, req?: AuthRequest) => Promise<AuthResponse> | AuthResponse,
  passkeyBridgeOverrides: Partial<PasskeyBridge> = {},
) => {
  const calls: Array<{ path: string; req?: AuthRequest }> = [];
  const signedInTokens: Array<string | null> = [];
  let refreshed = 0;
  let cleared = 0;

  const auth: AuthFetch = async (path, req) => {
    calls.push(req === undefined ? { path } : { path, req });
    return handler(path, req);
  };
  const passkeyBridge: PasskeyBridge = {
    availability: async () => "available",
    create: async () => ({ _tag: "Ok", value: { id: "pk_1", response: {} } }),
    get: async () => ({ _tag: "Ok", value: { id: "pk_1", response: {} } }),
    ...passkeyBridgeOverrides,
  };
  const client = makeAuthClient({
    auth,
    signedIn: async (token) => {
      signedInTokens.push(token);
      return true;
    },
    refresh: async () => {
      refreshed += 1;
    },
    clear: async () => {
      cleared += 1;
    },
    passkeyBridge,
  });
  return {
    client,
    calls,
    signedInTokens,
    getRefreshed: () => refreshed,
    getCleared: () => cleared,
  };
};

describe("AuthClient", () => {
  test("signUpEmail sends x-altcha and accept-language", async () => {
    const h = makeHarness(() => ({ status: 200, ok: true, body: {}, token: null }));
    const res = await h.client.signUpEmail(
      { email: "a@b.cz", password: "longpassword", name: "A", locale: "cs", invitation: "inv1" },
      "altcha-b64",
    );
    expect(res).toEqual({ _tag: "Ok", value: undefined });
    expect(h.calls[0]?.path).toBe("/sign-up/email");
    expect(h.calls[0]?.req?.headers).toEqual({ "accept-language": "cs", "x-altcha": "altcha-b64" });
    expect(h.calls[0]?.req?.body).toEqual({
      email: "a@b.cz",
      password: "longpassword",
      name: "A",
      invitation: "inv1",
      callbackURL: "/app/sign-in?verified=1&returnTo=%2Finvite%2Finv1",
    });
  });

  test("signInEmail establishes session and maps EMAIL_NOT_VERIFIED / InvalidBotProof", async () => {
    const okH = makeHarness(() => ({
      status: 200,
      ok: true,
      body: { user: sampleUser },
      token: "bearer-123",
    }));
    const okRes = await okH.client.signInEmail({ email: "jana@kvitbit.cz", password: "pw" }, null);
    expect(okRes).toEqual({ _tag: "Ok", value: { user: sampleUser, token: "bearer-123" } });
    expect(okH.signedInTokens).toEqual(["bearer-123"]);

    const unverifiedH = makeHarness(() => ({
      status: 403,
      ok: false,
      body: { code: "EMAIL_NOT_VERIFIED" },
      token: null,
    }));
    const uvRes = await unverifiedH.client.signInEmail({ email: "a@b.cz", password: "pw" }, null);
    expect(uvRes._tag).toBe("Err");
    if (uvRes._tag === "Err" && uvRes.error._tag === "Invalid") {
      expect(uvRes.error.issues[0]?.code).toBe("auth.email_not_verified");
    }

    const botH = makeHarness(() => ({
      status: 400,
      ok: false,
      body: { _tag: "InvalidBotProof" },
      token: null,
    }));
    const botRes = await botH.client.signInEmail({ email: "a@b.cz", password: "pw" }, "bad");
    expect(botRes._tag === "Err" && botRes.error._tag).toBe("InvalidBotProof");
  });

  test("verifyLink handles verify/magic and maps expired token to NotFound", async () => {
    const h = makeHarness((path) => {
      if (path === "/verify-email") {
        return { status: 200, ok: true, body: { user: sampleUser }, token: "t1" };
      }
      return { status: 400, ok: false, body: { code: "TOKEN_EXPIRED" }, token: null };
    });

    const verified = await h.client.verifyLink("verify", "tok1");
    expect(verified._tag).toBe("Ok");
    expect(h.calls[0]?.req?.query).toEqual({ token: "tok1" });

    const expired = await h.client.verifyLink("magic", "tok2");
    expect(expired._tag === "Err" && expired.error._tag).toBe("NotFound");
  });

  test("email verification without a session succeeds without signing in another user", async () => {
    const h = makeHarness(() => ({
      status: 200,
      ok: true,
      body: { status: true, user: null },
      token: null,
    }));
    expect(await h.client.verifyLink("verify", "token")).toEqual({ _tag: "Ok", value: null });
    expect(h.signedInTokens).toEqual([]);
    expect(h.calls.map(({ path }) => path)).toEqual(["/verify-email"]);
  });

  test("passkeySignIn returns Cancelled quietly when user dismisses sheet", async () => {
    const h = makeHarness(
      () => ({ status: 200, ok: true, body: { challenge: "abc" }, token: null }),
      { get: async () => ({ _tag: "Cancelled" }) },
    );
    expect(await h.client.passkeySignIn()).toEqual({ _tag: "Cancelled" });
  });

  test("passkeySignIn and passkeyAdd run full Better Auth ceremony", async () => {
    const h = makeHarness((path) => {
      if (path === "/passkey/generate-authenticate-options") {
        return { status: 200, ok: true, body: { challenge: "c1" }, token: null };
      }
      if (path === "/passkey/verify-authentication") {
        return { status: 200, ok: true, body: { user: sampleUser }, token: "pk-tok" };
      }
      if (path === "/passkey/generate-register-options") {
        return { status: 200, ok: true, body: { challenge: "c2" }, token: null };
      }
      if (path === "/passkey/verify-registration") {
        return {
          status: 200,
          ok: true,
          body: {
            id: "pk_9",
            name: "Pixel 9",
            createdAt: "2026-11-24T00:00:00.000Z",
            backedUp: true,
          },
          token: null,
        };
      }
      return { status: 404, ok: false, body: null, token: null };
    });

    const signedIn = await h.client.passkeySignIn();
    expect(signedIn).toEqual({ _tag: "Ok", value: { user: sampleUser, token: "pk-tok" } });

    const added = await h.client.passkeyAdd("Pixel 9");
    expect(added).toEqual({
      _tag: "Ok",
      value: {
        id: "pk_9",
        name: "Pixel 9",
        createdAt: "2026-11-24T00:00:00.000Z",
        deviceType: null,
        backedUp: true,
      },
    });
  });

  test("sessions, revokeSession, updateUser, signOut, and deleteAccount", async () => {
    const h = makeHarness((path) => {
      if (path === "/get-session") {
        return {
          status: 200,
          ok: true,
          body: { session: { id: "session-cur" }, user: sampleUser },
          token: null,
        };
      }
      if (path === "/list-sessions") {
        return {
          status: 200,
          ok: true,
          body: [
            {
              id: "session-cur",
              token: "tok-cur",
              userAgent: "Android",
              ipAddress: "1.2.3.4",
              createdAt: "2026-11-01T00:00:00Z",
              expiresAt: "2026-12-01T00:00:00Z",
            },
            {
              id: "session-other",
              token: "tok-other",
              userAgent: "Firefox",
              ipAddress: "5.6.7.8",
              createdAt: "2026-11-02T00:00:00Z",
              expiresAt: "2026-12-02T00:00:00Z",
            },
          ],
          token: null,
        };
      }
      return { status: 200, ok: true, body: {}, token: null };
    });

    const list = await h.client.sessions();
    expect(list._tag).toBe("Ok");
    if (list._tag === "Ok") {
      expect(list.value[0]?.current).toBe(true);
      expect(list.value[1]?.current).toBe(false);
    }

    await h.client.revokeSession("others");
    await h.client.revokeSession("tok-other");
    expect(h.calls.some((c) => c.path === "/revoke-other-sessions")).toBe(true);
    expect(h.calls.some((c) => c.path === "/revoke-session")).toBe(true);

    await h.client.updateUser({ name: "Jana K." });
    expect(h.getRefreshed()).toBe(1);

    await h.client.signOut();
    expect(h.getCleared()).toBe(1);

    await h.client.deleteAccount({ password: "secret" });
    expect(h.getCleared()).toBe(2);
  });

  test("never rejects on transport errors", async () => {
    const h = makeHarness(() => {
      throw new Error("socket closed");
    });
    expect(await h.client.signOut()).toEqual({ _tag: "Err", error: { _tag: "Offline" } });
  });
});
