import { RequestCaller } from "@kvitbit/api-contract";
/** `publicShare` group handlers (http-mcp-contracts 3.4 & 3.5.1): visitor side of PublicShareLinks. */

import { Api } from "@kvitbit/api-contract";
import { ShareVisitorDevice } from "@kvitbit/core";
import { PublicShareLinks, Unavailable } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { compact, downloadResponse, fileDownload } from "../conventions";
import { jsonizeSharedDocumentView } from "./documents/jsonize";

type ShareDevice = "desktop" | "mobile" | "tablet" | "unknown";
const TABLET_UA = /ipad|tablet|playbook|silk|kindle/i;
const ANDROID_UA = /android/i;
const MOBILE_MARKER = /mobile/i;
const MOBILE_UA = /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/i;
const DESKTOP_UA = /windows nt|macintosh|mac os x|linux|x11|cros|ubuntu|fedora/i;

/** Coarse device class from User-Agent for `ShareVisitorDevice` (no raw UA stored in core). */
export const deviceFromUserAgent = (userAgent: string | undefined): ShareDevice => {
  if (userAgent === undefined) return "unknown";
  const ua = Str.trim(userAgent);
  if (ua.length === 0) return "unknown";
  if (TABLET_UA.test(ua) || (ANDROID_UA.test(ua) && !MOBILE_MARKER.test(ua))) {
    return "tablet";
  }
  if (MOBILE_UA.test(ua)) {
    return "mobile";
  }
  if (DESKTOP_UA.test(ua)) {
    return "desktop";
  }
  return "unknown";
};

const withVisitorDevice = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(
      effect,
      ShareVisitorDevice,
      deviceFromUserAgent(request.headers["user-agent"]),
    ),
  );

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

export const PublicShareGroupLive = HttpApiBuilder.group(
  Api,
  "publicShare",
  Effect.fnUntraced(function* (handlers) {
    const shareLinks = yield* PublicShareLinks;
    return handlers
      .handle("open", () =>
        Effect.flatMap(RequestCaller, (caller) =>
          withVisitorDevice(Effect.map(shareLinks.open(caller), jsonizeSharedDocumentView)),
        ),
      )
      .handle("pdf", ({ query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withVisitorDevice(
            Effect.map(shareLinks.pdf(caller, compact(query)), (file) => fileDownload(file)),
          ),
        ),
      )
      .handle(
        "logo",
        Effect.fnUntraced(function* () {
          const caller = yield* RequestCaller;
          const file = yield* shareLinks.logo(caller);
          const chunks = yield* Stream.runCollect(file.bytes).pipe(
            Effect.mapError(() => Unavailable.make({ dependency: "blob_storage" })),
          );
          const body = concatBytes(chunks);
          const hash = Bun.CryptoHasher.hash("sha256", body, "hex");
          return downloadResponse({ etag: `"${hash}"`, cacheControl: "private, max-age=300" })({
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: body.byteLength,
            bytes: Stream.make(body),
          });
        }),
      );
  }),
);
