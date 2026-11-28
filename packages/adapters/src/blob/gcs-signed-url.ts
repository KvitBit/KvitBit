/**
 * GCS V4 signed URLs (GOOG4-RSA-SHA256) signed locally with a service-account key, following
 * https://cloud.google.com/storage/docs/access-control/signing-urls-manually. Deterministic for
 * a fixed `now` and key: RSASSA-PKCS1-v1_5 signatures have no randomness.
 */

import { createHash, createSign } from "node:crypto"; // RSA accepts the PEM forms supported by Node's signer.
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { InvalidBlobKey, keyProblem } from "./common";

export interface GcsServiceAccountKey {
  /** The key file's `client_email`. */
  readonly clientEmail: string;
  /** The key file's `private_key`, PEM. */
  readonly privateKey: string;
}

export interface GcsSignedUrlRequest {
  readonly bucket: string;
  readonly key: string;
  readonly credentials: GcsServiceAccountKey;
  /** 1 to 604800 (seven days), the V4 maximum. */
  readonly expiresInSeconds: number;
  /**
   * Default GET. Read methods only: a signed PUT would bypass `maxBytes` and the sha256 the
   * port reports.
   */
  readonly method?: "GET" | "HEAD" | undefined;
  /** Extra signed query parameters, e.g. `response-content-disposition`. */
  readonly queryParameters?: Readonly<Record<string, string>> | undefined;
  /** Default `storage.googleapis.com`. */
  readonly host?: string | undefined;
}

/** RFC 3986 encoding: everything but unreserved characters. */
const rfc3986Escapes = [
  [/!/g, "%21"],
  [/'/g, "%27"],
  [/\(/g, "%28"],
  [/\)/g, "%29"],
  [/\*/g, "%2A"],
] as const;
const encodeRfc3986 = (value: string) =>
  Arr.reduce(rfc3986Escapes, encodeURIComponent(value), (text, [pattern, encoded]) =>
    Str.replace(pattern, encoded)(text),
  );

class InvalidSignedUrl extends Schema.TaggedError<
  InvalidSignedUrl,
  { readonly brand: unique symbol }
>()("InvalidSignedUrl", { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }) {}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** `20261123T101500Z` and `20261123` for `now` in UTC. */
const timestamps = (iso: string) => {
  const datetime = `${Str.replace(/[-:]/g, "")(Str.slice(0, 19)(iso))}Z`;
  return { datetime, date: Str.slice(0, 8)(datetime) };
};

/** The canonical request and string-to-sign parts, exposed for tests. */
export const gcsV4CanonicalRequest = Effect.fnUntraced(function* (
  request: GcsSignedUrlRequest,
  now: Date,
) {
  const problem = keyProblem(request.key);
  if (problem !== undefined)
    return yield* InvalidBlobKey.make({ key: request.key, reason: problem });
  if (
    !Number.isInteger(request.expiresInSeconds) ||
    request.expiresInSeconds < 1 ||
    request.expiresInSeconds > 604800
  ) {
    return yield* InvalidSignedUrl.make({
      message: `expiresInSeconds out of range: ${request.expiresInSeconds}`,
    });
  }
  const method = request.method ?? "GET";
  // Checked at runtime too: a signed PUT would bypass `maxBytes` and the reported sha256.
  if (method !== "GET" && method !== "HEAD") {
    return yield* InvalidSignedUrl.make({
      message: `only GET and HEAD URLs are signed, not ${String(method)}`,
    });
  }
  return yield* Effect.try({
    try: () => canonicalParts(request, method, now.toISOString()),
    catch: (cause) =>
      InvalidSignedUrl.make({ message: "cannot construct the GCS canonical request", cause }),
  });
});

const canonicalParts = (request: GcsSignedUrlRequest, method: "GET" | "HEAD", iso: string) => {
  const host = request.host ?? "storage.googleapis.com";
  const { datetime, date } = timestamps(iso);
  const scope = `${date}/auto/storage/goog4_request`;
  const path = `/${encodeRfc3986(request.bucket)}/${Arr.join(Arr.map(Str.split(request.key, "/"), encodeRfc3986), "/")}`;
  const params = {
    ...request.queryParameters,
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${request.credentials.clientEmail}/${scope}`,
    "X-Goog-Date": datetime,
    "X-Goog-Expires": String(request.expiresInSeconds),
    "X-Goog-SignedHeaders": "host",
  };
  const query = Arr.join(
    Arr.map(
      Arr.map(
        Rec.toEntries(params),
        ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const,
      ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ([name, value]) => `${name}=${value}`,
    ),
    "&",
  );
  const canonicalRequest = Arr.join(
    [method, path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"],
    "\n",
  );
  const stringToSign = Arr.join(
    ["GOOG4-RSA-SHA256", datetime, scope, sha256Hex(canonicalRequest)],
    "\n",
  );
  return { host, path, query, canonicalRequest, stringToSign };
};

/** Signs a V4 URL valid from `now`. A bad key, range or PEM fails in the error channel. */
export const signGcsV4Url = Effect.fnUntraced(function* (request: GcsSignedUrlRequest, now: Date) {
  const { host, path, query, stringToSign } = yield* gcsV4CanonicalRequest(request, now);
  const signature = yield* Effect.try({
    try: () =>
      createSign("RSA-SHA256").update(stringToSign).sign(request.credentials.privateKey, "hex"),
    catch: (cause) => InvalidSignedUrl.make({ message: "cannot sign the GCS request", cause }),
  });
  return `https://${host}${path}?${query}&X-Goog-Signature=${signature}`;
});

/** `signGcsV4Url` at the current `Clock` time; bad input is a defect. */
export const gcsSignedUrl = Effect.fn("gcsSignedUrl")(function* (request: GcsSignedUrlRequest) {
  const now = yield* DateTime.now;
  return yield* signGcsV4Url(request, DateTime.toDateUtc(now)).pipe(Effect.orDie);
});
