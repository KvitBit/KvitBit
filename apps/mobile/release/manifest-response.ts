// Effect's crypto APIs do not provide synchronous RSA signing or X.509 verification.
// @effect-diagnostics-next-line nodeBuiltinImport:off The synchronous Expo signing API accepts Node RSA keys and X.509 certificates.
import { createSign, type KeyObject, randomUUID, verify } from "node:crypto";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  assertChannel,
  assertRuntimeVersion,
  assetRoutePath,
  DEFAULT_UPDATE_CHANNEL,
  isMobilePlatform,
  MANIFEST_CACHE_CONTROL,
  type MobilePlatform,
  type StoredPublication,
  type StoredUpdateAsset,
} from "./storage-layout";

/** Key id and algorithm embedded in `app.config.ts` `updates.codeSigningMetadata`. */
export const MANIFEST_SIGNING_KEY_ID = "main";
export const MANIFEST_SIGNING_ALGORITHM = "rsa-v1_5-sha256";

/** One body part of a `multipart/mixed` message (RFC 2046). */
export interface MultipartPart {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A parsed body part; `body` is exact bytes between delimiters. */
export interface ParsedMultipartPart {
  readonly headers: Headers;
  readonly body: string;
}

const CRLF = "\r\n";
const QUOTED_BOUNDARY_RE = /^"(.*)"$/;
const TRAILING_SLASHES_RE = /\/+$/;
const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

interface EncodedMultipart {
  readonly contentType: string;
  readonly body: string;
}

/** Frames each part byte for byte so its signature survives parsing. */
export const encodeMultipartMixed: {
  (boundary?: string): (parts: readonly MultipartPart[]) => EncodedMultipart;
  (parts: readonly MultipartPart[], boundary?: string): EncodedMultipart;
} = Fn.dual(
  (args) => Arr.isArray(args[0]),
  (parts: readonly MultipartPart[], boundary: string = randomUUID()): EncodedMultipart => {
    const encodedParts = Arr.map(parts, ({ headers, body }) =>
      Arr.join(
        [
          `--${boundary}`,
          ...Arr.map(Rec.toEntries(headers), ([name, value]) => `${name}: ${value}`),
          "",
          body,
        ],
        CRLF,
      ),
    );

    return {
      contentType: `multipart/mixed; boundary=${boundary}`,
      body: Arr.join([...encodedParts, `--${boundary}--`, ""], CRLF),
    };
  },
);

const boundaryOf = (contentType: string): string | undefined => {
  const [mediaType, ...parameters] = Str.split(";")(contentType);
  if (Str.toLowerCase(Str.trim(mediaType)) !== "multipart/mixed") return undefined;

  const parameter = Arr.findFirst(Arr.map(parameters, Str.trim), (value) =>
    Str.startsWith("boundary=")(Str.toLowerCase(value)),
  );
  if (Option.isNone(parameter)) return undefined;
  const boundary = Str.replace(
    QUOTED_BOUNDARY_RE,
    "$1",
  )(Str.slice("boundary=".length)(parameter.value));
  return boundary === "" ? undefined : boundary;
};

const parsePart = (text: string): ParsedMultipartPart => {
  if (Str.startsWith(CRLF)(text)) {
    return { headers: new Headers(), body: Str.slice(CRLF.length)(text) };
  }

  const headerEnd = Str.indexOf(CRLF + CRLF)(text);
  const headerBlock = Option.isNone(headerEnd) ? text : Str.slice(0, headerEnd.value)(text);
  const headers = new Headers();
  for (const line of Str.split(CRLF)(headerBlock)) {
    const separator = Str.indexOf(":")(line);
    if (Option.isSome(separator) && separator.value > 0) {
      headers.append(
        Str.slice(0, separator.value)(line),
        Str.trim(Str.slice(separator.value + 1)(line)),
      );
    }
  }

  return {
    headers,
    body: Option.isNone(headerEnd) ? "" : Str.slice(headerEnd.value + 2 * CRLF.length)(text),
  };
};

/**
 * Parses a `multipart/mixed` body into its parts, ignoring any preamble and
 * epilogue. Returns `undefined` when the content type is not `multipart/mixed`
 * with a boundary or has no closing delimiter.
 */
export const parseMultipartMixed: {
  (body: string): (contentType: string) => readonly ParsedMultipartPart[] | undefined;
  (contentType: string, body: string): readonly ParsedMultipartPart[] | undefined;
} = Fn.dual(2, (contentType: string, body: string): readonly ParsedMultipartPart[] | undefined => {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) return undefined;

  const delimiter = `${CRLF}--${boundary}`;
  const framed = CRLF + body;
  const parts: ParsedMultipartPart[] = [];
  let cursor = Option.getOrElse(Str.indexOf(delimiter)(framed), () => -1);

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    if (Str.startsWith("--", afterDelimiter)(framed)) return parts;

    // @effect-diagnostics-next-line preferEffectString:off Native indexOf accepts an offset, so each scan starts at the current delimiter.
    const next = framed.indexOf(delimiter, afterDelimiter);
    if (next === -1) return undefined;

    parts.push(parsePart(Str.slice(afterDelimiter + CRLF.length, next)(framed)));
    cursor = next;
  }

  return undefined;
});

// --- RFC 8941 SFV dictionary helpers for `expo-signature` ---

const escapeSfvString = (value: string): string =>
  Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(value));

/** Formats `expo-signature` as an RFC 8941 SFV dictionary (`sig="...", keyid="main", alg="rsa-v1_5-sha256"`). */
export const formatExpoSignature = ({
  signatureBase64,
  keyId = MANIFEST_SIGNING_KEY_ID,
  algorithm = MANIFEST_SIGNING_ALGORITHM,
}: {
  readonly signatureBase64: string;
  readonly keyId?: string;
  readonly algorithm?: string;
}): string =>
  `sig="${escapeSfvString(signatureBase64)}", keyid="${escapeSfvString(keyId)}", alg="${escapeSfvString(algorithm)}"`;

export interface ParsedExpoSignature {
  readonly sig: string;
  readonly keyid: string;
  readonly alg?: string;
}

const SFV_MEMBER_RE = /([a-z][a-z0-9_.-]*)="((?:\\.|[^"\\])*)"/g;
const SFV_ESCAPE_RE = /\\(.)/g;

/** Parses an RFC 8941 SFV string-valued `expo-signature` header. */
export const parseExpoSignature = (header: string | null): ParsedExpoSignature | undefined => {
  if (header === null || header === "") return undefined;
  const entries = new Map<string, string>();
  for (const match of Str.matchAll(SFV_MEMBER_RE)(header)) {
    const key = match[1];
    const rawValue = match[2];
    if (key !== undefined && rawValue !== undefined) {
      entries.set(key, Str.replace(SFV_ESCAPE_RE, "$1")(rawValue));
    }
  }
  const sig = entries.get("sig");
  const keyid = entries.get("keyid");
  const alg = entries.get("alg");
  if (sig === undefined || sig === "" || keyid === undefined || keyid === "") return undefined;
  return alg === undefined ? { sig, keyid } : { sig, keyid, alg };
};

/** Signs exact UTF-8 manifest/directive body bytes with RSA PKCS #1 v1.5 SHA-256. */
export const signManifestBody = ({
  body,
  signingKeyPem,
  keyId = MANIFEST_SIGNING_KEY_ID,
}: {
  readonly body: string;
  readonly signingKeyPem: string | KeyObject;
  readonly keyId?: string;
}): string => {
  const sig = createSign("RSA-SHA256").update(body, "utf8").sign(signingKeyPem, "base64");
  return formatExpoSignature({
    signatureBase64: sig,
    keyId,
    algorithm: MANIFEST_SIGNING_ALGORITHM,
  });
};

/** Verifies an `expo-signature` header against exact part body bytes and a public key or X.509 cert PEM. */
export const verifyManifestSignature = ({
  body,
  expoSignatureHeader,
  publicKeyOrCert,
  expectedKeyId = MANIFEST_SIGNING_KEY_ID,
}: {
  readonly body: string;
  readonly expoSignatureHeader: string | null;
  readonly publicKeyOrCert: string | KeyObject;
  readonly expectedKeyId?: string;
}): boolean => {
  const parsed = parseExpoSignature(expoSignatureHeader);
  if (parsed === undefined) return false;
  if (parsed.keyid !== expectedKeyId) return false;
  if (parsed.alg !== undefined && parsed.alg !== MANIFEST_SIGNING_ALGORITHM) return false;
  try {
    return verify(
      "RSA-SHA256",
      Buffer.from(body, "utf8"),
      publicKeyOrCert,
      Buffer.from(parsed.sig, "base64"),
    );
  } catch {
    return false;
  }
};

// --- Manifest request reading & response building ---

export type HeaderInput = Headers | Readonly<Record<string, string | undefined>>;

export interface ManifestRequest {
  readonly _tag: "Request";
  readonly platform: MobilePlatform;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | null;
  readonly expectsSignature: boolean;
}

export interface ManifestRequestRejected {
  readonly _tag: "Rejected";
  readonly status: 400 | 406;
  readonly message: string;
}

export type ReadManifestRequestResult = ManifestRequest | ManifestRequestRejected;

const getHeader = (headers: HeaderInput, name: string): string | null => {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const lower = Str.toLowerCase(name);
  for (const [key, value] of Rec.toEntries(headers)) {
    if (Str.toLowerCase(key) === lower) {
      return value ?? null;
    }
  }
  return null;
};

const hasHeader = (headers: HeaderInput, name: string): boolean => {
  if (headers instanceof Headers) {
    return headers.has(name);
  }
  return getHeader(headers, name) !== null;
};

const acceptsMultipartMixed = (accept: string | null): boolean => {
  if (accept === null || Str.trim(accept) === "") return true;
  for (const rawRange of Str.split(",")(accept)) {
    const [rawType, ...params] = Str.split(";")(rawRange);
    const type = Str.toLowerCase(Str.trim(rawType));
    if (type !== "multipart/mixed" && type !== "multipart/*" && type !== "*/*") {
      continue;
    }
    const qParam = Arr.findFirst(
      Arr.map(params, (param) => Str.toLowerCase(Str.trim(param))),
      Str.startsWith("q="),
    );
    const q = Option.isNone(qParam) ? 1 : Number(Str.slice(2)(qParam.value));
    if (!Number.isNaN(q) && q > 0) return true;
  }
  return false;
};

const nonBlank = (value: string | null | undefined): string | undefined => {
  const trimmed = Str.trim(value ?? "");
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Reads and validates an Expo Updates protocol v1 manifest request from HTTP
 * headers and optional URL search params.
 */
export const readManifestRequest = ({
  headers,
  searchParams,
}: {
  readonly headers: HeaderInput;
  readonly searchParams?: URLSearchParams;
}): ReadManifestRequestResult => {
  if (nonBlank(getHeader(headers, "expo-protocol-version")) !== "1") {
    return {
      _tag: "Rejected",
      status: 406,
      message: "Only Expo Updates protocol 1 is supported",
    };
  }

  if (!acceptsMultipartMixed(getHeader(headers, "accept"))) {
    return {
      _tag: "Rejected",
      status: 406,
      message: "Update responses are multipart/mixed only",
    };
  }

  const rawPlatform =
    nonBlank(getHeader(headers, "expo-platform")) ?? nonBlank(searchParams?.get("platform"));
  if (!isMobilePlatform(rawPlatform)) {
    return {
      _tag: "Rejected",
      status: 400,
      message: "The platform must be android or ios",
    };
  }

  const rawRuntimeVersion =
    nonBlank(getHeader(headers, "expo-runtime-version")) ??
    nonBlank(searchParams?.get("runtime-version"));
  if (rawRuntimeVersion === undefined) {
    return {
      _tag: "Rejected",
      status: 400,
      message: "The runtime version is missing",
    };
  }
  try {
    assertRuntimeVersion(rawRuntimeVersion);
  } catch {
    return {
      _tag: "Rejected",
      status: 400,
      message: "The runtime version is invalid",
    };
  }

  const rawChannel =
    nonBlank(getHeader(headers, "expo-channel-name")) ??
    nonBlank(searchParams?.get("channel-name")) ??
    DEFAULT_UPDATE_CHANNEL;
  try {
    assertChannel(rawChannel);
  } catch {
    return {
      _tag: "Rejected",
      status: 400,
      message: "The channel name is invalid",
    };
  }

  return {
    _tag: "Request",
    platform: rawPlatform,
    runtimeVersion: rawRuntimeVersion,
    channel: rawChannel,
    currentUpdateId: nonBlank(getHeader(headers, "expo-current-update-id")) ?? null,
    expectsSignature: hasHeader(headers, "expo-expect-signature"),
  };
};

export interface BuildManifestResponseInput {
  readonly request: ManifestRequest;
  readonly latest: StoredPublication | null | undefined;
  readonly origin: string;
  readonly signingKeyPem?: string | KeyObject | undefined;
  readonly boundary?: string | undefined;
}

export interface ManifestResponseOk {
  readonly _tag: "Response";
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>> & { readonly "content-type": string };
  readonly body: string;
}

export interface ManifestSigningUnavailable {
  readonly _tag: "SigningUnavailable";
  readonly status: 503;
  readonly message: string;
}

export type BuildManifestResponseResult = ManifestResponseOk | ManifestSigningUnavailable;

interface ProtocolAsset {
  readonly hash: string;
  readonly key: string;
  readonly contentType: string;
  readonly fileExtension?: string;
  readonly url: string;
}

const toProtocolAsset = (asset: StoredUpdateAsset, origin: string): ProtocolAsset => {
  const url = `${origin}${assetRoutePath(asset.sha256)}`;
  return asset.fileExtension === undefined
    ? {
        hash: asset.hash,
        key: asset.key,
        contentType: asset.contentType,
        url,
      }
    : {
        hash: asset.hash,
        key: asset.key,
        contentType: asset.contentType,
        fileExtension: asset.fileExtension,
        url,
      };
};

interface ManifestReply {
  readonly part: "manifest" | "directive";
  readonly body: object;
}

const NO_UPDATE_AVAILABLE: ManifestReply = {
  part: "directive",
  body: { type: "noUpdateAvailable" },
};

const selectReply = (
  request: ManifestRequest,
  latest: StoredPublication | null | undefined,
  origin: string,
): ManifestReply => {
  if (latest === null || latest === undefined) {
    return NO_UPDATE_AVAILABLE;
  }
  if (latest.type === "rollBackToEmbedded") {
    return {
      part: "directive",
      body: {
        type: "rollBackToEmbedded",
        parameters: { commitTime: latest.createdAt },
      },
    };
  }
  if (request.currentUpdateId === latest.id) {
    return NO_UPDATE_AVAILABLE;
  }
  return {
    part: "manifest",
    body: {
      id: latest.id,
      createdAt: latest.createdAt,
      runtimeVersion: latest.runtimeVersion,
      launchAsset: toProtocolAsset(latest.launchAsset, origin),
      assets: Arr.map(latest.assets, (asset) => toProtocolAsset(asset, origin)),
      metadata: latest.metadata,
      extra: latest.extra,
    },
  };
};

const formDataPartHeaders = (name: string, contentType: string): Record<string, string> => ({
  "content-type": contentType,
  "content-disposition": `form-data; name="${name}"`,
});

/**
 * Builds an Expo Updates protocol v1 `multipart/mixed` response with all s5
 * headers and RSA-v1_5-SHA256 signing (`keyid="main"`) when the client sends
 * `expo-expect-signature`.
 */
export const buildManifestResponse = ({
  request,
  latest,
  origin,
  signingKeyPem,
  boundary,
}: BuildManifestResponseInput): BuildManifestResponseResult => {
  const parsedOrigin = URL.parse(Str.trim(origin));
  const normalizedOrigin = parsedOrigin?.origin ?? Str.replace(TRAILING_SLASHES_RE, "")(origin);

  const reply = selectReply(request, latest, normalizedOrigin);
  const partBody = Result.getOrThrow(encodeJson(reply.body));
  const partHeaders = formDataPartHeaders(reply.part, "application/json; charset=utf-8");

  if (request.expectsSignature) {
    if (
      signingKeyPem === undefined ||
      (Str.isString(signingKeyPem) && Str.trim(signingKeyPem) === "")
    ) {
      return {
        _tag: "SigningUnavailable",
        status: 503,
        message: "Mobile update signing is unavailable",
      };
    }
    try {
      partHeaders["expo-signature"] = signManifestBody({ body: partBody, signingKeyPem });
    } catch {
      return {
        _tag: "SigningUnavailable",
        status: 503,
        message: "Mobile update signing key is invalid",
      };
    }
  }

  const multipart = encodeMultipartMixed(
    [
      { headers: partHeaders, body: partBody },
      {
        headers: formDataPartHeaders("extensions", "application/json"),
        body: '{"assetRequestHeaders":{}}',
      },
    ],
    boundary,
  );

  return {
    _tag: "Response",
    status: 200,
    headers: {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "expo-manifest-filters": "",
      "expo-server-defined-headers": "",
      "cache-control": MANIFEST_CACHE_CONTROL,
      "content-type": multipart.contentType,
    },
    body: multipart.body,
  };
};
