import { describe, expect, test } from "bun:test";
import * as EffectString from "effect/String";
import { makeNativePasskeyBridge, type NativePasskeyModule } from "./passkey-bridge.native";
import { makeWebPasskeyBridge, type WebCredentialsEnv } from "./passkey-bridge.web";
import { base64UrlToBytes, bytesToBase64Url, toBase64Url } from "./passkey-codec";

describe("passkey-codec", () => {
  test("base64url round-trips bytes and normalizes standard padded base64", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10, 0xfe]);
    const encoded = bytesToBase64Url(bytes);
    expect(EffectString.includes("+")(encoded)).toBe(false);
    expect(EffectString.includes("/")(encoded)).toBe(false);
    expect(EffectString.includes("=")(encoded)).toBe(false);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
    expect(toBase64Url("abc+def/ghi==")).toBe("abc-def_ghi");
  });
});

describe("makeNativePasskeyBridge", () => {
  const makeModule = (overrides: Partial<NativePasskeyModule> = {}): NativePasskeyModule => ({
    isSupported: () => true,
    create: () =>
      Promise.resolve({
        id: "cred+1==",
        rawId: "cred+1==",
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          // biome-ignore lint/security/noSecrets: Base64 fixture for normalization.
          clientDataJSON: "Y2xpZW50+A==",
          attestationObject: "YXR0ZXN0/w==",
          transports: ["internal", "unknown-transport"],
        },
      }),
    get: () =>
      Promise.resolve({
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
    expect(await makeNativePasskeyBridge(() => Promise.resolve(makeModule())).availability()).toBe(
      "available",
    );
    expect(
      await makeNativePasskeyBridge(() =>
        Promise.resolve(makeModule({ isSupported: () => false })),
      ).availability(),
    ).toBe("unavailable");
    expect(await makeNativePasskeyBridge(() => Promise.resolve(null)).availability()).toBe(
      "unavailable",
    );
  });

  test("normalizes registration and authentication responses to unpadded base64url", async () => {
    const bridge = makeNativePasskeyBridge(() => Promise.resolve(makeModule()));
    const created = await bridge.create({ challenge: "abc" });
    expect(created).toMatchObject({
      _tag: "Ok",
      value: {
        id: "cred-1",
        rawId: "cred-1",
        response: {
          clientDataJSON: "Y2xpZW50-A",
          attestationObject: "YXR0ZXN0_w",
          transports: ["internal"],
        },
      },
    });

    const assertion = await bridge.get({ challenge: "abc" });
    expect(assertion).toEqual({
      _tag: "Ok",
      value: {
        id: "cred-1",
        rawId: "cred-1",
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln-w" },
      },
    });
  });

  test.each([
    { code: "Passkey Get", message: "UserCancelled" },
    { code: "Passkey Get", message: "Interrupted by OS" },
    { code: "Passkey Create", message: "DomError: NotAllowedError - dismissed" },
    { code: "ERR_USER_CANCELLED", message: "cancelled" },
  ])("maps $message to Cancelled", async (error) => {
    const bridge = makeNativePasskeyBridge(() =>
      Promise.resolve(makeModule({ get: () => Promise.reject(error) })),
    );
    expect(await bridge.get({ challenge: "abc" })).toEqual({ _tag: "Cancelled" });
  });

  test("maps unexpected errors to Failed", async () => {
    const bridge = makeNativePasskeyBridge(() =>
      Promise.resolve(makeModule({ create: () => Promise.reject(new Error("hardware error")) })),
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
      create: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    };
    expect(await makeWebPasskeyBridge(() => ({})).availability()).toBe("unavailable");
    expect(
      await makeWebPasskeyBridge(() => ({
        credentials: dummyCreds,
        PublicKeyCredential: {
          isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
        },
      })).availability(),
    ).toBe("available");
    expect(
      await makeWebPasskeyBridge(() => ({
        credentials: dummyCreds,
        PublicKeyCredential: {
          isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
        },
      })).availability(),
    ).toBe("hybrid_only");
  });

  test("converts registration options and serializes attestation without JSON helpers", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const bridge = makeWebPasskeyBridge(() => ({
      PublicKeyCredential: {},
      credentials: {
        create: (opts) => {
          expect(opts?.publicKey?.challenge).toBeInstanceOf(Uint8Array);
          const credential = {
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
          };
          return Promise.resolve(credential);
        },
        get: () => Promise.reject(new DOMException("dismissed", "NotAllowedError")),
      },
    }));

    const created = await bridge.create({
      challenge: "AQIDBA",
      rp: { id: "kvitbit.test", name: "Kvitbit" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      user: { id: "AQID", name: "a@b.cz", displayName: "A" },
    });
    expect(created).toMatchObject({ _tag: "Ok", value: { id: "web-cred", rawId: "AQIDBA" } });

    const cancelled = await bridge.get({ challenge: "AQIDBA" });
    expect(cancelled).toEqual({ _tag: "Cancelled" });
  });

  test("serializes inherited assertion fields without a browser JSON helper", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    class Assertion {
      readonly bytes = bytes;
      get clientDataJSON() {
        return this.bytes;
      }
      get authenticatorData() {
        return this.clientDataJSON;
      }
      get signature() {
        return this.clientDataJSON;
      }
      get userHandle() {
        return this.clientDataJSON;
      }
    }

    const credential = {
      id: "web-cred",
      rawId: bytes,
      type: "public-key",
      response: new Assertion(),
    };
    const bridge = makeWebPasskeyBridge(() => ({
      PublicKeyCredential: {},
      credentials: { create: () => Promise.resolve(null), get: () => Promise.resolve(credential) },
    }));
    expect(await bridge.get({ challenge: "AQID" })).toEqual({
      _tag: "Ok",
      value: {
        id: "web-cred",
        rawId: "AQID",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "AQID",
          authenticatorData: "AQID",
          signature: "AQID",
          userHandle: "AQID",
        },
      },
    });
  });

  test("uses the browser JSON helpers when available", async () => {
    const challenge = new Uint8Array([1, 2, 3]);
    const json = {
      id: "web-cred",
      rawId: "AQID",
      response: { signature: "AQID" },
      type: "public-key",
    };
    const credential = { id: json.id, type: json.type, toJSON: () => json };
    const bridge = makeWebPasskeyBridge(() => ({
      PublicKeyCredential: {
        parseRequestOptionsFromJSON: (options) => {
          expect(options.challenge).toBe("AQID");
          return { challenge };
        },
      },
      credentials: {
        create: () => Promise.resolve(null),
        get: (options) => {
          expect(options?.publicKey?.challenge).toBe(challenge);
          return Promise.resolve(credential);
        },
      },
    }));
    expect(await bridge.get({ challenge: "AQID" })).toEqual({ _tag: "Ok", value: json });
  });
});
