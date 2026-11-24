/**
 * Pure helpers behind the Transfer port (ui-port-contracts 5.3): URLs, auth headers and the
 * mapping of a raw HTTP response (multipart upload, file download) to the same UiError the typed
 * client produces, so screens and the capture queue handle both paths alike.
 */
import {
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  Unauthorized,
} from "@kvitbit/api-contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { type Credentials, UiError } from "@kvitbit/ui-port/api";
import { Option, Redacted, Schema } from "effect";

/** A file the app holds locally: a `file://` URI on Android, an object URL or blob key on web. */
export interface SavedFile {
  readonly ref: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

/** A captured file: `sha256` drives dedupe and attach idempotency (core rule C6). */
export interface LocalFile extends SavedFile {
  readonly sha256: string;
}

export type TransferResult<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Err"; readonly error: UiError };

export const done = <A>(value: A): TransferResult<A> => ({ _tag: "Ok", value });
export const failed = <A = never>(error: UiError): TransferResult<A> => ({ _tag: "Err", error });

/** Where and as whom raw transfers go: the same origin and credentials as the typed client. */
export interface TransferTarget {
  readonly origin: string;
  readonly credentials: Credentials;
}

/** `origin + /api/v1 + path`, with the query's defined values appended. */
export const apiUrl = (
  origin: string,
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
): string => {
  const base = `${origin.replace(/\/+$/, "")}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const pairs = Object.entries(query).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (pairs.length === 0) return base;
  return `${base}?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
};

/** Bearer on Android; nothing on the web, where the session cookie rides along. */
export const authHeaders = (credentials: Credentials): Record<string, string> =>
  credentials._tag === "Bearer"
    ? {
        authorization: `Bearer ${typeof credentials.token === "string" ? credentials.token : Redacted.value(credentials.token)}`,
      }
    : {};

const WireErrorBody = Schema.Union([
  NotFound,
  Forbidden,
  Invalid,
  Conflict,
  Unavailable,
  Unauthorized,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  PayloadTooLarge,
  InvalidBotProof,
  OriginRejected,
]);
const decodeWire = Schema.decodeUnknownOption(WireErrorBody);

export const parseJson = (text: string): unknown => {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * A non-2xx response to UiError: the declared error body when it decodes, else by status
 * (413 without a body still reads as too large; anything else is Unexpected with the request id).
 */
export const errorFromResponse = (
  status: number,
  body: unknown,
  requestId: string | null = null,
): UiError => {
  const decoded = decodeWire(body);
  if (Option.isSome(decoded)) return decoded.value;
  if (status === 0) return UiError.offline;
  if (status === 413) return new PayloadTooLarge({ limitBytes: 0 });
  return UiError.unexpected(status, requestId);
};

export const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** A file name safe to use as a path segment (download targets). */
export const safeFileName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "file" : cleaned;
};
