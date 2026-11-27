import { describe, expect, test } from "bun:test";
import { makeNativePasskeyBridge, type NativePasskeyModule } from "./passkey-bridge.native";
import { makeWebPasskeyBridge, type WebCredentialsEnv } from "./passkey-bridge.web";
import { base64UrlToBytes, bytesToBase64Url, toBase64Url } from "./passkey-codec";

describe("passkey-codec", () => {
  test("base64url round-trips bytes and normalizes standard padded base64", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10, 0xfe]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded.includes("+")).toBe(false);
    expect(encoded.includes("/")).toBe(false);
    expect(encoded.includes("=")).toBe(false);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
    expect(toBase64Url("abc+def/ghi==")).toBe("abc-def_ghi");
  });
});

describe("makeNativePasskeyBridge", () => {
  const makeModule = (overrides: Partial<NativePasskeyModule> = {}): NativePasskeyModule => ({
    isSupported: () => true,
    create: async () => ({
      id: "cred+1==",
      rawId: "cred+1==",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: "Y2xpZW50+A==",
        attestationObject: "YXR0ZXN0/w==",
        transports: ["internal", "unknown-transport"],
      },
    }),
    get: async () => ({
      id: "cred+1==",
      type: "public-key",
      response: {
        clientDataJSON: "Y2xpZW50==",
        authenticatorData: "YXV0aA==",
        signature: "c2ln+w==",
        userHandle: null,
      },
    }),
    ...overrides,
  });

  test("reports available / unavailable from native module", async () => {
    expect(await makeNativePasskeyBridge(async () => makeModule()).availability()).toBe(
      "available",
    );
    expect(
      await makeNativePasskeyBridge(async () =>
        makeModule({ isSupported: () => false }),
      ).availability(),
    ).toBe("unavailable");
    expect(await makeNativePasskeyBridge(async () => null).availability()).toBe("unavailable");
  });

  test("normalizes registration and authentication responses to unpadded base64url", async () => {
    const bridge = makeNativePasskeyBridge(async () => makeModule());
    const created = await bridge.create({ challenge: "abc" });
    expect(created._tag).toBe("Ok");
    if (created._tag === "Ok") {
      expect(created.value.id).toBe("cred-1");
      expect(created.value.rawId).toBe("cred-1");
      const resp = created.value.response as Record<string, unknown>;
      expect(resp.clientDataJSON).toBe("Y2xpZW50-A");
      expect(resp.attestationObject).toBe("YXR0ZXN0_w");
      expect(resp.transports).toEqual(["internal"]);
    }

    const assertion = await bridge.get({ challenge: "abc" });
    expect(assertion._tag).toBe("Ok");
    if (assertion._tag === "Ok") {
      expect(assertion.value.rawId).toBe("cred-1");
      const resp = assertion.value.response as Record<string, unknown>;
      expect(resp.signature).toBe("c2ln-w");
      expect("userHandle" in resp).toBe(false);
    }
  });

  test("maps Android UserCancelled, Interrupted, DomError: NotAllowedError and iOS ERR_USER_CANCELLED to Cancelled", async () => {
    for (const err of [
      { code: "Passkey Get", message: "UserCancelled" },
      { code: "Passkey Get", message: "Interrupted by OS" },
      { code: "Passkey Create", message: "DomError: NotAllowedError - dismissed" },
      { code: "ERR_USER_CANCELLED", message: "cancelled" },
    ]) {
      const bridge = makeNativePasskeyBridge(async () =>
        makeModule({
          get: async () => {
            throw err;
          },
        }),
      );
      expect(await bridge.get({ challenge: "abc" })).toEqual({ _tag: "Cancelled" });
    }
  });

  test("maps unexpected errors to Failed", async () => {
    const bridge = makeNativePasskeyBridge(async () =>
      makeModule({
        create: async () => {
          throw new Error("hardware error");
        },
      }),
    );
    expect(await bridge.create({ challenge: "abc" })).toEqual({
      _tag: "Failed",
      message: "hardware error",
    });
  });
});

describe("makeWebPasskeyBridge", () => {
  test("reports available, hybrid_only, and unavailable", async () => {
    const dummyCreds: WebCredentialsEnv["credentials"] = {
      create: async () => null,
      get: async () => null,
    };
    expect(await makeWebPasskeyBridge(() => ({})).availability()).toBe("unavailable");
    expect(
      await makeWebPasskeyBridge(() => ({
        credentials: dummyCreds,
        PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true },
      })).availability(),
    ).toBe("available");
    expect(
      await makeWebPasskeyBridge(() => ({
        credentials: dummyCreds,
        PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false },
      })).availability(),
    ).toBe("hybrid_only");
  });

  test("converts options and serializes attestation/assertion credentials", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const bridge = makeWebPasskeyBridge(() => ({
      PublicKeyCredential: {},
      credentials: {
        create: async (opts) => {
          expect(opts.publicKey?.challenge).toBeInstanceOf(Uint8Array);
          return {
            id: "web-cred",
            rawId: bytes,
            type: "public-key",
            authenticatorAttachment: "platform",
            getClientExtensionResults: () => ({}),
            response: {
              clientDataJSON: bytes,
              attestationObject: bytes,
              getTransports: () => ["internal"],
            },
          } as unknown as Credential;
        },
        get: async () => {
          throw new DOMException("dismissed", "NotAllowedError");
        },
      },
    }));

    const created = await bridge.create({
      challenge: "AQIDBA",
      user: { id: "AQID", name: "a@b.cz", displayName: "A" },
    });
    expect(created._tag).toBe("Ok");
    if (created._tag === "Ok") {
      expect(created.value.id).toBe("web-cred");
      expect(created.value.rawId).toBe("AQIDBA");
    }

    const cancelled = await bridge.get({ challenge: "AQIDBA" });
    expect(cancelled).toEqual({ _tag: "Cancelled" });
  });
});
