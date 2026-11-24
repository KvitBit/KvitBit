import { describe, expect, test } from "bun:test";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  type GcsSignedUrlRequest,
  gcsSignedUrl,
  gcsV4CanonicalRequest,
  InvalidBlobKey,
  signGcsV4Url,
} from "../../src/blob/index";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const now = new Date("2026-11-23T10:15:30.123Z");
const request: GcsSignedUrlRequest = {
  bucket: "kvitbit-blobs",
  key: "pdf/ws 1/doc(1)/cs.pdf",
  credentials: { clientEmail: "blob@kvitbit.iam.gserviceaccount.com", privateKey },
  expiresInSeconds: 900,
  queryParameters: { "response-content-disposition": 'attachment; filename="F 2026*1.pdf"' },
};

const credential =
  "blob%40kvitbit.iam.gserviceaccount.com%2F20261123%2Fauto%2Fstorage%2Fgoog4_request";
const expectedQuery = [
  "X-Goog-Algorithm=GOOG4-RSA-SHA256",
  `X-Goog-Credential=${credential}`,
  "X-Goog-Date=20261123T101530Z",
  "X-Goog-Expires=900",
  "X-Goog-SignedHeaders=host",
  "response-content-disposition=attachment%3B%20filename%3D%22F%202026%2A1.pdf%22",
].join("&");

describe("GCS V4 signed URLs", () => {
  test("builds the canonical request and string to sign per the V4 spec", () => {
    const parts = gcsV4CanonicalRequest(request, now);
    expect(parts.path).toBe("/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf");
    expect(parts.query).toBe(expectedQuery);
    expect(parts.canonicalRequest).toBe(
      [
        "GET",
        "/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf",
        expectedQuery,
        "host:storage.googleapis.com",
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );
    expect(parts.stringToSign).toBe(
      [
        "GOOG4-RSA-SHA256",
        "20261123T101530Z",
        "20261123/auto/storage/goog4_request",
        createHash("sha256").update(parts.canonicalRequest).digest("hex"),
      ].join("\n"),
    );
  });

  test("is deterministic and carries a signature the public key verifies", () => {
    const url = signGcsV4Url(request, now);
    expect(signGcsV4Url(request, now)).toBe(url);
    const prefix = `https://storage.googleapis.com/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf?${expectedQuery}&X-Goog-Signature=`;
    expect(url.startsWith(prefix)).toBe(true);
    const signature = url.slice(prefix.length);
    expect(signature).toMatch(/^[0-9a-f]{512}$/);
    const verified = createVerify("RSA-SHA256")
      .update(gcsV4CanonicalRequest(request, now).stringToSign)
      .verify(publicKey, signature, "hex");
    expect(verified).toBe(true);
    expect(signGcsV4Url(request, new Date(now.getTime() + 1000))).not.toBe(url);
  });

  test("parses as a URL whose parameters decode back to the inputs", () => {
    const url = new URL(signGcsV4Url(request, now));
    expect(url.searchParams.get("X-Goog-Credential")).toBe(
      "blob@kvitbit.iam.gserviceaccount.com/20261123/auto/storage/goog4_request",
    );
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="F 2026*1.pdf"',
    );
  });

  test("rejects bad keys and expiries", () => {
    expect(() => signGcsV4Url({ ...request, key: "../x" }, now)).toThrow(InvalidBlobKey);
    expect(() => signGcsV4Url({ ...request, expiresInSeconds: 0 }, now)).toThrow(RangeError);
    // A JavaScript caller can pass any string; write methods are refused at runtime.
    const put = { ...request, method: "PUT" } as unknown as GcsSignedUrlRequest;
    expect(() => signGcsV4Url(put, now)).toThrow(RangeError);
    expect(() => signGcsV4Url({ ...request, expiresInSeconds: 604801 }, now)).toThrow(RangeError);
    expect(() => signGcsV4Url({ ...request, expiresInSeconds: 604800 }, now)).not.toThrow();
  });

  test("gcsSignedUrl signs at the Clock's time", async () => {
    const url = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        return yield* gcsSignedUrl(request);
      }).pipe(Effect.provide(Layer.fresh(TestClock.layer()))),
    );
    expect(url).toBe(signGcsV4Url(request, now));
  });
});
