import { describe, expect, test } from "bun:test";
// The signing tests generate PEM keys for the synchronous Node-compatible RSA adapter.

import { generateKeyPairSync } from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  buildManifestResponse,
  parseExpoSignature,
  parseMultipartMixed,
  readManifestRequest,
  verifyManifestSignature,
} from "./manifest-response";
import type { StoredRollback, StoredUpdate } from "./storage-layout";

const manifestJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    launchAsset: Schema.Struct({ url: Schema.String }),
    assets: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        fileExtension: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const parseJson = (value: string) =>
  Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(value).pipe(Option.getOrThrow);

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SAMPLE_UPDATE: StoredUpdate = {
  schema: 1,
  type: "update",
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-11-24T12:00:00.000Z",
  channel: "production",
  platform: "android",
  runtimeVersion: "fp-1234",
  launchAsset: {
    sha256: Str.repeat(64)("a"),
    hash: Str.repeat(43)("A"),
    key: Str.repeat(2)("0123456789abcdef"),
    contentType: "application/javascript",
  },
  assets: [
    {
      sha256: Str.repeat(64)("b"),
      hash: Str.repeat(43)("B"),
      key: Str.repeat(2)("fedcba9876543210"),
      contentType: "image/png",
      fileExtension: ".png",
    },
  ],
  metadata: {},
  extra: { expoClient: { name: "Kvitbit" } },
};

const SAMPLE_ROLLBACK: StoredRollback = {
  schema: 1,
  type: "rollBackToEmbedded",
  id: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-11-24T13:00:00.000Z",
  channel: "production",
  platform: "android",
  runtimeVersion: "fp-1234",
};

describe("readManifestRequest", () => {
  test("reads headers, defaults channel to production, and detects signature expectation", () => {
    const result = readManifestRequest({
      headers: new Headers({
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "fp-1234",
        "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
        accept: "multipart/mixed",
      }),
    });
    expect(result).toEqual({
      _tag: "Request",
      platform: "android",
      runtimeVersion: "fp-1234",
      channel: "production",
      currentUpdateId: null,
      expectsSignature: true,
    });
  });

  test("falls back to query parameters for platform, runtime-version, and channel-name", () => {
    const result = readManifestRequest({
      headers: { "expo-protocol-version": "1" },
      searchParams: new URLSearchParams("platform=ios&runtime-version=fp-9&channel-name=staging"),
    });
    expect(result).toEqual({
      _tag: "Request",
      platform: "ios",
      runtimeVersion: "fp-9",
      channel: "staging",
      currentUpdateId: null,
      expectsSignature: false,
    });
  });

  test("rejects unsupported protocol version or unacceptable media type with 406", () => {
    expect(
      readManifestRequest({
        headers: {
          "expo-protocol-version": "0",
          "expo-platform": "android",
          "expo-runtime-version": "1",
        },
      }),
    ).toMatchObject({ _tag: "Rejected", status: 406 });

    expect(
      readManifestRequest({
        headers: {
          "expo-protocol-version": "1",
          "expo-platform": "android",
          "expo-runtime-version": "1",
          accept: "application/json",
        },
      }),
    ).toMatchObject({ _tag: "Rejected", status: 406 });
  });

  test("rejects invalid platform or missing runtime version with 400", () => {
    expect(
      readManifestRequest({
        headers: {
          "expo-protocol-version": "1",
          "expo-platform": "web",
          "expo-runtime-version": "1",
        },
      }),
    ).toMatchObject({ _tag: "Rejected", status: 400 });

    expect(
      readManifestRequest({
        headers: {
          "expo-protocol-version": "1",
          "expo-platform": "android",
        },
      }),
    ).toMatchObject({ _tag: "Rejected", status: 400 });
  });
});

describe("buildManifestResponse", () => {
  test("emits signed multipart/mixed manifest with s5 headers and asset URLs", () => {
    const req = readManifestRequest({
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "fp-1234",
        "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      },
    });
    expect(req._tag).toBe("Request");
    if (req._tag !== "Request") return;

    const res = buildManifestResponse({
      request: req,
      latest: SAMPLE_UPDATE,
      origin: "https://kvitbit.cz/",
      signingKeyPem: privateKey,
      boundary: "test-boundary",
    });

    expect(res._tag).toBe("Response");
    if (res._tag !== "Response") return;

    expect(res.status).toBe(200);
    expect(res.headers["expo-protocol-version"]).toBe("1");
    expect(res.headers["expo-sfv-version"]).toBe("0");
    expect(res.headers["cache-control"]).toBe("private, max-age=0");
    expect(res.headers["content-type"]).toBe("multipart/mixed; boundary=test-boundary");

    const parts = parseMultipartMixed(res.headers["content-type"], res.body);
    expect(parts).toHaveLength(2);
    const manifestPart = parts?.[0];
    const extensionsPart = parts?.[1];
    expect(manifestPart?.headers.get("content-disposition")).toBe('form-data; name="manifest"');
    expect(extensionsPart?.headers.get("content-disposition")).toBe('form-data; name="extensions"');

    const sigHeader = manifestPart?.headers.get("expo-signature") ?? null;
    expect(parseExpoSignature(sigHeader)).toMatchObject({
      keyid: "main",
      alg: "rsa-v1_5-sha256",
    });
    expect(
      verifyManifestSignature({
        body: manifestPart?.body ?? "",
        expoSignatureHeader: sigHeader,
        publicKeyOrCert: publicKey,
      }),
    ).toBe(true);
    expect(
      verifyManifestSignature({
        body: `${manifestPart?.body ?? ""}x`,
        expoSignatureHeader: sigHeader,
        publicKeyOrCert: publicKey,
      }),
    ).toBe(false);

    const manifest = Schema.decodeOption(manifestJson)(manifestPart?.body ?? "{}").pipe(
      Option.getOrThrow,
    );
    expect(manifest.id).toBe(SAMPLE_UPDATE.id);
    expect(manifest.launchAsset.url).toBe(
      `https://kvitbit.cz/api/mobile/updates/assets/${Str.repeat(64)("a")}`,
    );
    expect(manifest.assets[0]?.url).toBe(
      `https://kvitbit.cz/api/mobile/updates/assets/${Str.repeat(64)("b")}`,
    );
    expect(manifest.assets[0]?.fileExtension).toBe(".png");
  });

  test("returns noUpdateAvailable directive for unknown runtime version or matching currentUpdateId", () => {
    const baseReq = readManifestRequest({
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "fp-1234",
        "expo-current-update-id": SAMPLE_UPDATE.id,
      },
    });
    if (baseReq._tag !== "Request") throw new Error("expected Request");

    for (const latest of [null, SAMPLE_UPDATE]) {
      const res = buildManifestResponse({
        request: baseReq,
        latest,
        origin: "https://kvitbit.cz",
      });
      expect(res._tag).toBe("Response");
      if (res._tag !== "Response") continue;
      const parts = parseMultipartMixed(res.headers["content-type"], res.body);
      expect(parts?.[0]?.headers.get("content-disposition")).toBe('form-data; name="directive"');
      expect(parts?.[0]?.headers.get("expo-signature")).toBeNull();
      expect(parseJson(parts?.[0]?.body ?? "{}")).toEqual({ type: "noUpdateAvailable" });
    }
  });

  test("returns signed rollBackToEmbedded directive with commitTime", () => {
    const req = readManifestRequest({
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "fp-1234",
        "expo-expect-signature": 'sig, keyid="main"',
      },
    });
    if (req._tag !== "Request") throw new Error("expected Request");

    const res = buildManifestResponse({
      request: req,
      latest: SAMPLE_ROLLBACK,
      origin: "https://kvitbit.cz",
      signingKeyPem: privateKey,
    });
    expect(res._tag).toBe("Response");
    if (res._tag !== "Response") return;

    const parts = parseMultipartMixed(res.headers["content-type"], res.body);
    const directivePart = parts?.[0];
    expect(directivePart?.headers.get("content-disposition")).toBe('form-data; name="directive"');
    expect(parseJson(directivePart?.body ?? "{}")).toEqual({
      type: "rollBackToEmbedded",
      parameters: { commitTime: SAMPLE_ROLLBACK.createdAt },
    });
    expect(
      verifyManifestSignature({
        body: directivePart?.body ?? "",
        expoSignatureHeader: directivePart?.headers.get("expo-signature") ?? null,
        publicKeyOrCert: publicKey,
      }),
    ).toBe(true);
  });

  test("returns 503 SigningUnavailable when expo-expect-signature is set without a valid key", () => {
    const req = readManifestRequest({
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "android",
        "expo-runtime-version": "fp-1234",
        "expo-expect-signature": 'sig, keyid="main"',
      },
    });
    if (req._tag !== "Request") throw new Error("expected Request");

    expect(
      buildManifestResponse({
        request: req,
        latest: SAMPLE_UPDATE,
        origin: "https://kvitbit.cz",
      }),
    ).toMatchObject({ _tag: "SigningUnavailable", status: 503 });

    expect(
      buildManifestResponse({
        request: req,
        latest: SAMPLE_UPDATE,
        origin: "https://kvitbit.cz",
        signingKeyPem: "not-a-pem-key",
      }),
    ).toMatchObject({ _tag: "SigningUnavailable", status: 503 });
  });
});
