/** `publicShare` group handlers (http-mcp-contracts 3.4 & 3.5.1): visitor side of PublicShareLinks. */
import { createHash } from "node:crypto";
import { Api } from "@kvitbit/api-contract";
import { ShareVisitorDevice } from "@kvitbit/core";
import { PublicShareLinks, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Stream } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpApiBuilder } from "effect/http-api";
import { compact, downloadResponse, fileDownload } from "../conventions";
import { jsonizeSharedDocumentView } from "./documents/jsonize";

type ShareDevice = "desktop" | "mobile" | "tablet" | "unknown";

/** Coarse device class from User-Agent for `ShareVisitorDevice` (no raw UA stored in core). */
export const deviceFromUserAgent = (userAgent: string | undefined): ShareDevice => {
  if (userAgent === undefined) return "unknown";
  const ua = userAgent.trim();
  if (ua.length === 0) return "unknown";
  if (
    /ipad|tablet|playbook|silk|kindle/i.test(ua) ||
    (/android/i.test(ua) && !/mobile/i.test(ua))
  ) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/i.test(ua)) {
    return "mobile";
  }
  if (/windows nt|macintosh|mac os x|linux|x11|cros|ubuntu|fedora/i.test(ua)) {
    return "desktop";
  }
  return "unknown";
};

const withVisitorDevice = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(HttpServerRequest, (request) =>
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

export const PublicShareGroupLive = HttpApiBuilder.group(Api, "publicShare", (handlers) =>
  Effect.gen(function* () {
    const shareLinks = yield* PublicShareLinks;
    return handlers
      .handle("open", () =>
        withVisitorDevice(Effect.map(shareLinks.open, jsonizeSharedDocumentView)),
      )
      .handle("pdf", ({ query }) =>
        withVisitorDevice(Effect.map(shareLinks.pdf(compact(query)), (file) => fileDownload(file))),
      )
      .handle("logo", () =>
        Effect.gen(function* () {
          const file = yield* shareLinks.logo;
          const chunks = yield* Stream.runCollect(file.bytes).pipe(
            Effect.mapError(() => new Unavailable({ dependency: "blob_storage" })),
          );
          const body = concatBytes(chunks);
          const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
          return downloadResponse(
            {
              filename: file.filename,
              contentType: file.contentType,
              sizeBytes: body.byteLength,
              bytes: Stream.make(body),
            },
            {
              etag,
              cacheControl: "private, max-age=300",
            },
          );
        }),
      );
  }),
);
