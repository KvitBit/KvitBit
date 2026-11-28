import { describe, expect, test } from "bun:test";

import { createHash, createVerify, generateKeyPairSync } from "node:crypto"; // Verify the output through the PEM and RSA boundary.
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import {
  gcsV4CanonicalRequest as canonicalRequest,
  type GcsSignedUrlRequest,
  gcsSignedUrl,
  InvalidBlobKey,
  signGcsV4Url as signedUrl,
} from "../../src/blob/index";

const gcsV4CanonicalRequest = (input: GcsSignedUrlRequest, time: Date) =>
  Effect.runSync(canonicalRequest(input, time));
const signGcsV4Url = (input: GcsSignedUrlRequest, time: Date) =>
  Effect.runSync(signedUrl(input, time));

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-23T10:15:30.123Z"));
const rsaSignature = /^[0-9a-f]{512}$/;
const request: GcsSignedUrlRequest = {
  bucket: "kvitbit-blobs",
  key: "pdf/ws 1/doc(1)/cs.pdf",
  credentials: { clientEmail: "blob@kvitbit.iam.gserviceaccount.com", privateKey },
  expiresInSeconds: 900,
  queryParameters: { "response-content-disposition": 'attachment; filename="F 2026*1.pdf"' },
};

const credential = Arr.join(
  ["blob%40kvitbit.iam.gserviceaccount.com", "20261123", "auto", "storage", "goog4_request"],
  "%2F",
);
const expectedDisposition = Str.replace(
  "*",
  "%2A",
)(encodeURIComponent('attachment; filename="F 2026*1.pdf"'));
const expectedTimestamp = "20261123T101530Z";
const expectedQuery = Arr.join(
  [
    "X-Goog-Algorithm=GOOG4-RSA-SHA256",
    `X-Goog-Credential=${credential}`,
    `X-Goog-Date=${expectedTimestamp}`,
    "X-Goog-Expires=900",
    "X-Goog-SignedHeaders=host",
    `response-content-disposition=${expectedDisposition}`,
  ],
  "&",
);

describe("GCS V4 signed URLs", () => {
  test("builds the canonical request and string to sign per the V4 spec", () => {
    const parts = gcsV4CanonicalRequest(request, now);
    expect(parts.path).toBe("/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf");
    expect(parts.query).toBe(expectedQuery);
    expect(parts.canonicalRequest).toBe(
      Arr.join(
        [
          "GET",
          "/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf",
          expectedQuery,
          "host:storage.googleapis.com",
          "",
          "host",
          "UNSIGNED-PAYLOAD",
        ],
        "\n",
      ),
    );
    expect(parts.stringToSign).toBe(
      Arr.join(
        [
          "GOOG4-RSA-SHA256",
          "20261123T101530Z",
          "20261123/auto/storage/goog4_request",
          createHash("sha256").update(parts.canonicalRequest).digest("hex"),
        ],
        "\n",
      ),
    );
  });

  test("is deterministic and carries a signature the public key verifies", () => {
    const url = signGcsV4Url(request, now);
    expect(signGcsV4Url(request, now)).toBe(url);
    const prefix = `https://storage.googleapis.com/kvitbit-blobs/pdf/ws%201/doc%281%29/cs.pdf?${expectedQuery}&X-Goog-Signature=`;
    expect(Str.startsWith(prefix)(url)).toBe(true);
    const signature = Str.slice(prefix.length)(url);
    expect(signature).toMatch(rsaSignature);
    const verified = createVerify("RSA-SHA256")
      .update(gcsV4CanonicalRequest(request, now).stringToSign)
      .verify(publicKey, signature, "hex");
    expect(verified).toBe(true);
    expect(
      signGcsV4Url(request, DateTime.toDateUtc(DateTime.makeUnsafe(now.getTime() + 1000))),
    ).not.toBe(url);
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
    expect(() => signGcsV4Url({ ...request, expiresInSeconds: 0 }, now)).toThrow("out of range");
    // A JavaScript caller can pass any string; write methods are refused at runtime.
    const put = Object.defineProperty({ ...request }, "method", { value: "PUT" });
    expect(() => signGcsV4Url(put, now)).toThrow("only GET and HEAD");
    expect(() => signGcsV4Url({ ...request, expiresInSeconds: 604801 }, now)).toThrow(
      "out of range",
    );
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
