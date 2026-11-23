/**
 * GCS V4 signed URLs (GOOG4-RSA-SHA256) signed locally with a service-account key, following
 * https://cloud.google.com/storage/docs/access-control/signing-urls-manually. Deterministic for
 * a fixed `now` and key: RSASSA-PKCS1-v1_5 signatures have no randomness.
 */
import { createHash, createSign } from "node:crypto";
import { Clock, Effect } from "effect";
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
const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** `20261123T101500Z` and `20261123` for `now` in UTC. */
const timestamps = (now: Date) => {
  const iso = now.toISOString(); // 2026-11-23T10:15:00.000Z
  const datetime = `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
  return { datetime, date: datetime.slice(0, 8) };
};

/** The canonical request and string-to-sign parts, exposed for tests. */
export const gcsV4CanonicalRequest = (request: GcsSignedUrlRequest, now: Date) => {
  const problem = keyProblem(request.key);
  if (problem !== undefined) throw new InvalidBlobKey({ key: request.key, reason: problem });
  if (
    !Number.isInteger(request.expiresInSeconds) ||
    request.expiresInSeconds < 1 ||
    request.expiresInSeconds > 604800
  ) {
    throw new RangeError(`expiresInSeconds out of range: ${request.expiresInSeconds}`);
  }
  const host = request.host ?? "storage.googleapis.com";
  const { datetime, date } = timestamps(now);
  const scope = `${date}/auto/storage/goog4_request`;
  const path = `/${encodeRfc3986(request.bucket)}/${request.key.split("/").map(encodeRfc3986).join("/")}`;
  const params: Record<string, string> = {
    ...request.queryParameters,
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${request.credentials.clientEmail}/${scope}`,
    "X-Goog-Date": datetime,
    "X-Goog-Expires": String(request.expiresInSeconds),
    "X-Goog-SignedHeaders": "host",
  };
  const query = Object.keys(params)
    .map((name) => [encodeRfc3986(name), encodeRfc3986(params[name] ?? "")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    request.method ?? "GET",
    path,
    query,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["GOOG4-RSA-SHA256", datetime, scope, sha256Hex(canonicalRequest)].join(
    "\n",
  );
  return { host, path, query, canonicalRequest, stringToSign };
};

/** A V4 signed URL for `request`, valid from `now`. Throws on a bad key, range or PEM. */
export const signGcsV4Url = (request: GcsSignedUrlRequest, now: Date): string => {
  const { host, path, query, stringToSign } = gcsV4CanonicalRequest(request, now);
  const signature = createSign("RSA-SHA256")
    .update(stringToSign)
    .sign(request.credentials.privateKey, "hex");
  return `https://${host}${path}?${query}&X-Goog-Signature=${signature}`;
};

/** `signGcsV4Url` at the current `Clock` time; bad input is a defect. */
export const gcsSignedUrl = (request: GcsSignedUrlRequest): Effect.Effect<string> =>
  Effect.flatMap(Clock.currentTimeMillis, (millis) =>
    Effect.sync(() => signGcsV4Url(request, new Date(millis))),
  );
