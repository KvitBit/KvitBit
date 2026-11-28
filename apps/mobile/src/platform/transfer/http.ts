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
import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";

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
const trailingSlashes = /\/+$/;
const isTokenText = Schema.is(Schema.String);

type Query = Readonly<Record<string, string | undefined>>;

export const apiUrl: {
  (path: string, query?: Query): (origin: string) => string;
  (origin: string, path: string, query?: Query): string;
} = Fn.dual(
  (args) => Predicate.isString(args[1]),
  (origin: string, path: string, query: Query = {}): string => {
    const base = `${EffectString.replace(trailingSlashes, "")(origin)}/api/v1${EffectString.startsWith("/")(path) ? path : `/${path}`}`;
    const pairs = EffectArray.filter(
      EffectRecord.toEntries(query),
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    if (pairs.length === 0) return base;
    return `${base}?${EffectArray.join(
      EffectArray.map(pairs, ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`),
      "&",
    )}`;
  },
);

/** Bearer on Android; nothing on the web, where the session cookie rides along. */
export const authHeaders = (credentials: Credentials): Record<string, string> =>
  credentials._tag === "Bearer"
    ? {
        authorization: `Bearer ${isTokenText(credentials.token) ? credentials.token : Redacted.value(credentials.token)}`,
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

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

export const parseJson = (text: string): unknown =>
  EffectString.trim(text) === "" ? null : Option.getOrElse(decodeJson(text), () => text);

/**
 * A non-2xx response to UiError: the declared error body when it decodes, else by status
 * (413 without a body still reads as too large; anything else is Unexpected with the request id).
 */
export const errorFromResponse = ({
  status,
  body,
  requestId = null,
}: {
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string | null;
}): UiError => {
  const decoded = decodeWire(body);
  if (Option.isSome(decoded)) return decoded.value;
  if (status === 0) return UiError.offline;
  if (status === 413) return PayloadTooLarge.make({ limitBytes: 0 });
  return UiError.unexpected(status, requestId);
};

export const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** A file name safe to use as a path segment (download targets). */
export const safeFileName = (name: string): string => {
  const cleaned = EffectString.replace(
    /^-+|-+$/g,
    "",
  )(EffectString.replace(/[^A-Za-z0-9._-]+/g, "-")(name));
  return cleaned === "" ? "file" : cleaned;
};
