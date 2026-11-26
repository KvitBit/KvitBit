/**
 * Pure core of `GET /api/mobile/updates/manifest` (Expo Updates protocol v1,
 * http-mcp-contracts section 5, wire-compatible with `@kvitbit/mobile` release/manifest-response).
 */
import { createSign, randomUUID } from "node:crypto";
import {
  defaultChannel,
  isValidSegment,
  type StoredPublication,
  type StoredUpdateAsset,
  type UpdatePlatform,
  updateAssetPath,
  updatePlatforms,
} from "./layout";

/** What an installed app states about itself when it checks for an update. */
export interface ManifestRequest {
  readonly platform: UpdatePlatform;
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

export interface HeaderReader {
  readonly get: (name: string) => string | null;
}

/** The key id and algorithm app.config.ts `updates.codeSigningMetadata` names. */
export const signingKeyId = "main";
export const signingAlgorithm = "rsa-v1_5-sha256";

const acceptsMultipart = (accept: string | null): boolean =>
  accept === null ||
  accept
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim().toLowerCase())
    .some((type) => type === "multipart/mixed" || type === "multipart/*" || type === "*/*");

/**
 * Reads an Expo Updates protocol 1 request. The protocol lets the platform and runtime version
 * also arrive as query parameters. Only protocol 1 multipart responses carry directives, so
 * another protocol or a client refusing multipart gets 406.
 */
export const readManifestRequest = (
  headers: HeaderReader,
  query: URLSearchParams = new URLSearchParams(),
): ({ readonly _tag: "Request" } & ManifestRequest) | ManifestRequestRejected => {
  if (headers.get("expo-protocol-version") !== "1") {
    return { _tag: "Rejected", status: 406, message: "Only Expo Updates protocol 1 is supported" };
  }
  if (!acceptsMultipart(headers.get("accept"))) {
    return { _tag: "Rejected", status: 406, message: "Update responses are multipart/mixed only" };
  }
  const platform = headers.get("expo-platform") ?? query.get("platform");
  if (!updatePlatforms.includes(platform as UpdatePlatform)) {
    return { _tag: "Rejected", status: 400, message: "The platform must be android or ios" };
  }
  const runtimeVersion = headers.get("expo-runtime-version") || query.get("runtime-version");
  if (!runtimeVersion || !isValidSegment(runtimeVersion)) {
    return { _tag: "Rejected", status: 400, message: "The runtime version is missing or invalid" };
  }
  const channel = headers.get("expo-channel-name") || defaultChannel;
  if (!isValidSegment(channel)) {
    return { _tag: "Rejected", status: 400, message: "The channel name is invalid" };
  }
  return {
    _tag: "Request",
    platform: platform as UpdatePlatform,
    runtimeVersion,
    channel,
    currentUpdateId: headers.get("expo-current-update-id"),
    expectsSignature: headers.get("expo-expect-signature") !== null,
  };
};

/** The single part an update check answers with, besides its extensions. */
export interface ManifestReply {
  readonly part: "manifest" | "directive";
  readonly body: Readonly<Record<string, unknown>>;
}

export const noUpdateAvailable: ManifestReply = {
  part: "directive",
  body: { type: "noUpdateAvailable" },
};

const manifestAsset = (origin: string, asset: StoredUpdateAsset) => ({
  hash: asset.hash,
  key: asset.key,
  contentType: asset.contentType,
  ...(asset.fileExtension === undefined ? {} : { fileExtension: asset.fileExtension }),
  url: `${origin.replace(/\/+$/, "")}${updateAssetPath(asset.sha256)}`,
});

/**
 * What the app should do given the newest publication for its channel, platform and runtime:
 * run the update unless it already does, or return to its embedded update.
 */
export const manifestReply = (
  request: ManifestRequest,
  latest: StoredPublication | undefined,
  origin: string,
): ManifestReply => {
  if (
    latest === undefined ||
    latest.platform !== request.platform ||
    latest.runtimeVersion !== request.runtimeVersion ||
    latest.channel !== request.channel
  ) {
    return noUpdateAvailable;
  }
  if (latest.type === "rollBackToEmbedded") {
    return {
      part: "directive",
      body: { type: "rollBackToEmbedded", parameters: { commitTime: latest.createdAt } },
    };
  }
  if (request.currentUpdateId === latest.id) return noUpdateAvailable;
  return {
    part: "manifest",
    body: {
      id: latest.id,
      createdAt: latest.createdAt,
      runtimeVersion: latest.runtimeVersion,
      launchAsset: manifestAsset(origin, latest.launchAsset),
      assets: latest.assets.map((asset) => manifestAsset(origin, asset)),
      metadata: latest.metadata,
      extra: latest.extra,
    },
  };
};

/**
 * The `expo-signature` value for a part body: an RSA PKCS #1 v1.5 SHA-256 signature over the
 * body's exact UTF-8 bytes, as an RFC 8941 dictionary.
 */
export const signPartBody = (body: string, privateKeyPem: string): string => {
  const sig = createSign("RSA-SHA256").update(body, "utf8").sign(privateKeyPem, "base64");
  return `sig="${sig}", keyid="${signingKeyId}", alg="${signingAlgorithm}"`;
};

export interface MultipartPart {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Frames text parts as multipart/mixed byte for byte, so a part signature still verifies. */
export const encodeMultipartMixed = (parts: readonly MultipartPart[], boundary: string) => ({
  contentType: `multipart/mixed; boundary=${boundary}`,
  body: [
    ...parts.map(({ headers, body }) =>
      [
        `--${boundary}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        body,
      ].join("\r\n"),
    ),
    `--${boundary}--`,
    "",
  ].join("\r\n"),
});

const formDataPart = (name: string, contentType: string) => ({
  "content-type": contentType,
  "content-disposition": `form-data; name="${name}"`,
});

export interface ManifestResponse {
  readonly _tag: "Response";
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly reply: ManifestReply;
}

export interface ManifestSigningUnavailable {
  readonly _tag: "SigningUnavailable";
  readonly status: 503;
  readonly message: string;
}

/**
 * The full response to an update check. A request that expects a signature without a configured
 * key gets `SigningUnavailable` (answer 503), never an unsigned manifest.
 */
export const buildManifestResponse = (input: {
  readonly request: ManifestRequest;
  readonly latest: StoredPublication | undefined;
  /** The public origin asset URLs start with, e.g. `https://kvitbit.example`. */
  readonly origin: string;
  readonly signingKeyPem?: string | undefined;
  readonly boundary?: string;
}): ManifestResponse | ManifestSigningUnavailable => {
  const reply = manifestReply(input.request, input.latest, input.origin);
  const body = JSON.stringify(reply.body);
  let headers: Record<string, string> = formDataPart(reply.part, "application/json; charset=utf-8");
  if (input.request.expectsSignature) {
    if (!input.signingKeyPem) {
      return {
        _tag: "SigningUnavailable",
        status: 503,
        message: "Mobile update signing is unavailable",
      };
    }
    headers = { ...headers, "expo-signature": signPartBody(body, input.signingKeyPem) };
  }
  const multipart = encodeMultipartMixed(
    [
      { headers, body },
      {
        headers: formDataPart("extensions", "application/json"),
        body: JSON.stringify({ assetRequestHeaders: {} }),
      },
    ],
    input.boundary ?? randomUUID(),
  );
  return {
    _tag: "Response",
    status: 200,
    reply,
    body: multipart.body,
    headers: {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "expo-manifest-filters": "",
      "expo-server-defined-headers": "",
      "cache-control": "private, max-age=0",
      "content-type": multipart.contentType,
    },
  };
};
