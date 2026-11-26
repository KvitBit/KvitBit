import { createSign, type KeyObject, randomUUID, verify } from "node:crypto";
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

/**
 * Encodes text parts as a `multipart/mixed` body. Each part's body is framed
 * byte for byte so signatures over a part's body verify after parsing.
 */
export const encodeMultipartMixed = (
  parts: readonly MultipartPart[],
  boundary: string = randomUUID(),
): { readonly contentType: string; readonly body: string } => {
  const encodedParts = parts.map(({ headers, body }) =>
    [
      `--${boundary}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      body,
    ].join(CRLF),
  );

  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: [...encodedParts, `--${boundary}--`, ""].join(CRLF),
  };
};

const boundaryOf = (contentType: string): string | undefined => {
  const [mediaType = "", ...parameters] = contentType.split(";");
  if (mediaType.trim().toLowerCase() !== "multipart/mixed") return undefined;

  const boundary = parameters
    .map((parameter) => parameter.trim())
    .find((parameter) => parameter.toLowerCase().startsWith("boundary="))
    ?.slice("boundary=".length);
  return boundary?.replace(/^"(.*)"$/, "$1") || undefined;
};

const parsePart = (text: string): ParsedMultipartPart => {
  if (text.startsWith(CRLF)) {
    return { headers: new Headers(), body: text.slice(CRLF.length) };
  }

  const headerEnd = text.indexOf(CRLF + CRLF);
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const headers = new Headers();
  for (const line of headerBlock.split(CRLF)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }

  return {
    headers,
    body: headerEnd === -1 ? "" : text.slice(headerEnd + 2 * CRLF.length),
  };
};

/**
 * Parses a `multipart/mixed` body into its parts, ignoring any preamble and
 * epilogue. Returns `undefined` when the content type is not `multipart/mixed`
 * with a boundary or has no closing delimiter.
 */
export const parseMultipartMixed = (
  contentType: string,
  body: string,
): readonly ParsedMultipartPart[] | undefined => {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) return undefined;

  const delimiter = `--${boundary}`;
  const framed = CRLF + body;
  const parts: ParsedMultipartPart[] = [];
  let cursor = framed.indexOf(CRLF + delimiter);

  while (cursor !== -1) {
    const afterDelimiter = cursor + CRLF.length + delimiter.length;
    if (framed.startsWith("--", afterDelimiter)) return parts;

    const next = framed.indexOf(CRLF + delimiter, afterDelimiter);
    if (next === -1) return undefined;

    parts.push(parsePart(framed.slice(afterDelimiter + CRLF.length, next)));
    cursor = next;
  }

  return undefined;
};

// --- RFC 8941 SFV dictionary helpers for `expo-signature` ---

const escapeSfvString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** Formats `expo-signature` as an RFC 8941 SFV dictionary (`sig="...", keyid="main", alg="rsa-v1_5-sha256"`). */
export const formatExpoSignature = (
  signatureBase64: string,
  keyId: string = MANIFEST_SIGNING_KEY_ID,
  algorithm: string = MANIFEST_SIGNING_ALGORITHM,
): string =>
  `sig="${escapeSfvString(signatureBase64)}", keyid="${escapeSfvString(keyId)}", alg="${escapeSfvString(algorithm)}"`;

export interface ParsedExpoSignature {
  readonly sig: string;
  readonly keyid: string;
  readonly alg?: string;
}

const SFV_MEMBER_RE = /([a-z][a-z0-9_.-]*)="((?:\\.|[^"\\])*)"/g;

/** Parses an RFC 8941 SFV string-valued `expo-signature` header. */
export const parseExpoSignature = (header: string | null): ParsedExpoSignature | undefined => {
  if (!header) return undefined;
  const entries = new Map<string, string>();
  for (const match of header.matchAll(SFV_MEMBER_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key !== undefined && rawValue !== undefined) {
      entries.set(key, rawValue.replace(/\\(.)/g, "$1"));
    }
  }
  const sig = entries.get("sig");
  const keyid = entries.get("keyid");
  const alg = entries.get("alg");
  if (!sig || !keyid) return undefined;
  return alg === undefined ? { sig, keyid } : { sig, keyid, alg };
};

/** Signs exact UTF-8 manifest/directive body bytes with RSA PKCS #1 v1.5 SHA-256. */
export const signManifestBody = (
  body: string,
  signingKeyPem: string | KeyObject,
  keyId: string = MANIFEST_SIGNING_KEY_ID,
): string => {
  const sig = createSign("RSA-SHA256").update(body, "utf8").sign(signingKeyPem, "base64");
  return formatExpoSignature(sig, keyId, MANIFEST_SIGNING_ALGORITHM);
};

/** Verifies an `expo-signature` header against exact part body bytes and a public key or X.509 cert PEM. */
export const verifyManifestSignature = (
  body: string,
  expoSignatureHeader: string | null,
  publicKeyOrCert: string | KeyObject,
  expectedKeyId: string = MANIFEST_SIGNING_KEY_ID,
): boolean => {
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
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
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
  if (accept === null || accept.trim() === "") return true;
  for (const rawRange of accept.split(",")) {
    const [rawType = "", ...params] = rawRange.split(";");
    const type = rawType.trim().toLowerCase();
    if (type !== "multipart/mixed" && type !== "multipart/*" && type !== "*/*") {
      continue;
    }
    const qParam = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    const q = qParam === undefined ? 1 : Number(qParam);
    if (!Number.isNaN(q) && q > 0) return true;
  }
  return false;
};

/**
 * Reads and validates an Expo Updates protocol v1 manifest request from HTTP
 * headers and optional URL search params.
 */
export const readManifestRequest = (
  headers: HeaderInput,
  searchParams?: URLSearchParams,
): ReadManifestRequestResult => {
  if (getHeader(headers, "expo-protocol-version")?.trim() !== "1") {
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
    getHeader(headers, "expo-platform")?.trim() || searchParams?.get("platform")?.trim();
  if (!isMobilePlatform(rawPlatform)) {
    return {
      _tag: "Rejected",
      status: 400,
      message: "The platform must be android or ios",
    };
  }

  const rawRuntimeVersion =
    getHeader(headers, "expo-runtime-version")?.trim() ||
    searchParams?.get("runtime-version")?.trim();
  if (!rawRuntimeVersion) {
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
    getHeader(headers, "expo-channel-name")?.trim() ||
    searchParams?.get("channel-name")?.trim() ||
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

  const rawCurrentId = getHeader(headers, "expo-current-update-id")?.trim();
  const currentUpdateId = rawCurrentId && rawCurrentId.length > 0 ? rawCurrentId : null;

  return {
    _tag: "Request",
    platform: rawPlatform,
    runtimeVersion: rawRuntimeVersion,
    channel: rawChannel,
    currentUpdateId,
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
  readonly headers: Readonly<Record<string, string>>;
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
      assets: latest.assets.map((asset) => toProtocolAsset(asset, origin)),
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
  const parsedOrigin = URL.parse(origin.trim());
  const normalizedOrigin = parsedOrigin ? parsedOrigin.origin : origin.replace(/\/+$/, "");

  const reply = selectReply(request, latest, normalizedOrigin);
  const partBody = JSON.stringify(reply.body);
  const partHeaders = formDataPartHeaders(reply.part, "application/json; charset=utf-8");

  if (request.expectsSignature) {
    if (
      signingKeyPem === undefined ||
      (typeof signingKeyPem === "string" && signingKeyPem.trim() === "")
    ) {
      return {
        _tag: "SigningUnavailable",
        status: 503,
        message: "Mobile update signing is unavailable",
      };
    }
    try {
      partHeaders["expo-signature"] = signManifestBody(partBody, signingKeyPem);
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
        body: JSON.stringify({ assetRequestHeaders: {} }),
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
