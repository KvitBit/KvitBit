/**
 * Pure core of `GET /api/mobile/updates/manifest` (Expo Updates protocol v1,
 * http-mcp-contracts section 5, wire-compatible with `@kvitbit/mobile` release/manifest-response).
 */
import * as Arr from "effect/Array";
import * as KeyFormat from "effect/crypto/KeyFormat";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  defaultChannel,
  isValidSegment,
  type ReadPublication,
  UpdatePlatform,
  updateAssetPath,
} from "./layout";

/** What an installed app states about itself when it checks for an update. */
interface ManifestRequest {
  readonly platform: UpdatePlatform;
  readonly runtimeVersion: string;
  readonly channel: string;
  readonly currentUpdateId: string | null;
  readonly expectsSignature: boolean;
}

interface ManifestRequestRejected {
  readonly _tag: "Rejected";
  readonly status: 400 | 406;
  readonly message: string;
}

export interface HeaderReader {
  readonly get: (name: string) => string | null;
}

/** The key id and algorithm app.config.ts `updates.codeSigningMetadata` names. */
const signingKeyId = "main";
const signingAlgorithm = "rsa-v1_5-sha256";
const privateKeyStart = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/m;
const rsaPrivateKeyBlock =
  /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----[ \t]*\n([A-Za-z0-9+/= \t\n]+)\n-----END \1-----[ \t]*(?=\n|$)/;
const trailingSlashes = /\/+$/;
const randomBoundary = SecureRandom.SecureRandom.use((random) => random.uuidV4());

const isUpdatePlatform = Schema.is(UpdatePlatform);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const acceptsMultipart = (accept: string | null): boolean =>
  accept === null ||
  Arr.some(Str.split(accept, ","), (entry) => {
    const mediaType = Str.split(entry, ";")[0];
    const type = Str.toLowerCase(Str.trim(mediaType));
    return type === "multipart/mixed" || type === "multipart/*" || type === "*/*";
  });

/**
 * Reads an Expo Updates protocol 1 request. The protocol lets the platform and runtime version
 * also arrive as query parameters. Only protocol 1 multipart responses carry directives, so
 * another protocol or a client refusing multipart gets 406.
 */
export const readManifestRequest = ({
  headers,
  query,
}: {
  readonly headers: HeaderReader;
  readonly query: URLSearchParams;
}): ({ readonly _tag: "Request" } & ManifestRequest) | ManifestRequestRejected => {
  if (headers.get("expo-protocol-version") !== "1") {
    return { _tag: "Rejected", status: 406, message: "Only Expo Updates protocol 1 is supported" };
  }
  if (!acceptsMultipart(headers.get("accept"))) {
    return { _tag: "Rejected", status: 406, message: "Update responses are multipart/mixed only" };
  }
  const platform = headers.get("expo-platform") ?? query.get("platform");
  if (!isUpdatePlatform(platform)) {
    return { _tag: "Rejected", status: 400, message: "The platform must be android or ios" };
  }
  const runtimeHeader = headers.get("expo-runtime-version");
  const runtimeVersion =
    runtimeHeader === null || runtimeHeader === "" ? query.get("runtime-version") : runtimeHeader;
  if (runtimeVersion === null || !isValidSegment(runtimeVersion)) {
    return { _tag: "Rejected", status: 400, message: "The runtime version is missing or invalid" };
  }
  const channelHeader = headers.get("expo-channel-name");
  const channel = channelHeader === null || channelHeader === "" ? defaultChannel : channelHeader;
  if (!isValidSegment(channel)) {
    return { _tag: "Rejected", status: 400, message: "The channel name is invalid" };
  }
  return {
    _tag: "Request",
    platform,
    runtimeVersion,
    channel,
    currentUpdateId: headers.get("expo-current-update-id"),
    expectsSignature: headers.get("expo-expect-signature") !== null,
  };
};

const noUpdateAvailable = {
  part: "directive",
  body: { type: "noUpdateAvailable" },
} as const;

type StoredUpdateAsset = Extract<ReadPublication, { type: "update" }>["launchAsset"];

const manifestAsset = (origin: string, asset: StoredUpdateAsset) => ({
  hash: asset.hash,
  key: asset.key,
  contentType: asset.contentType,
  fileExtension: asset.fileExtension,
  url: `${Str.replace(trailingSlashes, "")(origin)}${updateAssetPath(asset.sha256)}`,
});

/**
 * What the app should do given the newest publication for its channel, platform and runtime:
 * run the update unless it already does, or return to its embedded update.
 */
const manifestReply = (
  request: ManifestRequest,
  latest: ReadPublication | undefined,
  origin: string,
) => {
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
    } as const;
  }
  if (request.currentUpdateId === latest.id) return noUpdateAvailable;
  return {
    part: "manifest",
    body: {
      id: latest.id,
      createdAt: latest.createdAt,
      runtimeVersion: latest.runtimeVersion,
      launchAsset: manifestAsset(origin, latest.launchAsset),
      assets: Arr.map(latest.assets, (asset) => manifestAsset(origin, asset)),
      metadata: latest.metadata,
      extra: latest.extra,
    },
  } as const;
};

interface MultipartPart {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Frames text parts as multipart/mixed byte for byte, so a part signature still verifies. */
const encodeMultipartMixed = (parts: readonly MultipartPart[], boundary: string) => ({
  contentType: `multipart/mixed; boundary=${boundary}`,
  body: Arr.join(
    [
      ...Arr.map(parts, ({ headers, body }) =>
        Arr.join(
          [
            `--${boundary}`,
            ...Arr.map(Record.toEntries(headers), ([name, value]) => `${name}: ${value}`),
            "",
            body,
          ],
          "\r\n",
        ),
      ),
      `--${boundary}--`,
      "",
    ],
    "\r\n",
  ),
});

const formDataPart = (name: string, contentType: string) => ({
  "content-type": contentType,
  "content-disposition": `form-data; name="${name}"`,
});

interface ManifestResponse {
  readonly _tag: "Response";
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly reply: ReturnType<typeof manifestReply>;
}

interface ManifestSigningUnavailable {
  readonly _tag: "SigningUnavailable";
  readonly status: 503;
  readonly message: string;
}

class ManifestSigningFailure extends Schema.TaggedError<
  ManifestSigningFailure,
  { readonly brand: unique symbol }
>()("ManifestSigningFailure", { cause: Schema.Unknown }) {}

const signingFailure = (cause: unknown) => ManifestSigningFailure.make({ cause });

/** Signs the exact UTF-8 bytes that will be written to the multipart response. */
const signPartBody = Effect.fnUntraced(function* (body: string, pem: string) {
  // OpenSSL exports may add a preamble above the first private key block.
  const keyText = Str.replace(/\r\n/g, "\n")(pem);
  const start = privateKeyStart.exec(keyText);
  const block = start && rsaPrivateKeyBlock.exec(Str.slice(start.index)(keyText));
  const label = block?.[1];
  const encoded = block?.[2];
  if (label === undefined || encoded === undefined)
    return yield* signingFailure("Expected an RSA private key PEM");
  const format = label === "RSA PRIVATE KEY" ? KeyFormat.pkcs1 : KeyFormat.pkcs8;
  const canonicalPem = `-----BEGIN ${label}-----\n${Str.replace(/\s/g, "")(encoded)}\n-----END ${label}-----`;
  const key = yield* KeyFormat.decodePrivate(
    KeyFormat.pem(format),
    Signature.rsaPkcs1v15Sha256,
    canonicalPem,
  ).pipe(Effect.mapError(signingFailure));
  const signer = yield* Signature.Signature;
  const signature = yield* signer
    .sign(key, new TextEncoder().encode(body))
    .pipe(Effect.mapError(signingFailure));
  const sig = Base64.encode(signature);
  return `sig="${sig}", keyid="${signingKeyId}", alg="${signingAlgorithm}"`;
});

/**
 * The full response to an update check. A request that expects a signature without a configured
 * key gets `SigningUnavailable` (answer 503), never an unsigned manifest.
 */
export const buildManifestResponse = Effect.fnUntraced(function* (input: {
  readonly request: ManifestRequest;
  readonly latest: ReadPublication | undefined;
  /** The public origin asset URLs start with, e.g. `https://kvitbit.example`. */
  readonly origin: string;
  readonly signingKeyPem?: string | undefined;
  readonly boundary?: string;
}) {
  const reply = manifestReply(input.request, input.latest, input.origin);
  const body = yield* encodeJson(reply.body);
  let headers: Record<string, string> = formDataPart(reply.part, "application/json; charset=utf-8");
  if (input.request.expectsSignature) {
    if (input.signingKeyPem === undefined || input.signingKeyPem === "") {
      return {
        _tag: "SigningUnavailable",
        status: 503,
        message: "Mobile update signing is unavailable",
      } satisfies ManifestSigningUnavailable;
    }
    const signature = yield* signPartBody(body, input.signingKeyPem);
    headers = { ...headers, "expo-signature": signature };
  }
  const extensions = yield* encodeJson({ assetRequestHeaders: {} });
  const multipart = encodeMultipartMixed(
    [
      { headers, body },
      {
        headers: formDataPart("extensions", "application/json"),
        body: extensions,
      },
    ],
    input.boundary ?? (yield* randomBoundary),
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
  } satisfies ManifestResponse;
}, Effect.orDie);
