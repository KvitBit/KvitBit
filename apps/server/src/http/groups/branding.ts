/** `branding` group handlers (http-mcp-contracts 3.5.3 & 3.4): branding settings, resolved theme, images and PDF preview. */
import {
  Api,
  BRANDING_IMAGE_MAX_BYTES,
  type BrandingView,
  PayloadTooLarge,
  type ResolvedTheme,
} from "@kvitbit/api-contract";
import {
  type ImageRef,
  Invalid,
  Unavailable,
  Workspaces,
  type WorkspaceView,
} from "@kvitbit/domain/contract";
import { Effect, Stream } from "effect";
import type { Multipart } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { downloadResponse, fileDownload, withRevision } from "../conventions";
import { resolveTheme } from "./workspace/themeResolver";

/** Sentinel defect used to abort core's `Stream.runForEach` cleanly when a multipart part fails mid-stream. */
class MultipartStreamDefect {
  readonly _tag = "MultipartStreamDefect";
  constructor(readonly error: Multipart.MultipartError) {}
}

const mapMultipartError = (
  error: Multipart.MultipartError,
): Invalid | PayloadTooLarge | Unavailable => {
  switch (error.reason._tag) {
    case "FileTooLarge":
    case "BodyTooLarge":
    case "FieldTooLarge":
      return new PayloadTooLarge({ limitBytes: BRANDING_IMAGE_MAX_BYTES });
    case "TooManyParts":
    case "Parse":
      return new Invalid({ issues: [{ path: ["file"], code: "request.malformed" }] });
    case "InternalError":
      return new Unavailable({ dependency: "blob_storage" });
  }
};

const toBrandingView = (
  view: WorkspaceView,
  preResolved?: ResolvedTheme | null,
): Effect.Effect<BrandingView> =>
  Effect.gen(function* () {
    const b = view.branding;
    const resolvedTheme =
      preResolved !== undefined
        ? preResolved
        : b.theme === null
          ? null
          : yield* resolveTheme(b.theme).pipe(
              Effect.catchTag("Invalid", () => Effect.succeed(null)),
            );
    return {
      pdfTemplate: b.pdfTemplate,
      accentColor: b.accentColor,
      footerText: b.footerText,
      theme: b.theme,
      resolvedTheme,
      logo: b.logo,
      stamp: b.stamp,
      revision: view.revision,
    };
  });

export const BrandingGroupLive = HttpApiBuilder.group(Api, "branding", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("getBranding", () =>
        Effect.flatMap(workspaces.current, (view) => toBrandingView(view)),
      )
      .handle("updateBranding", ({ headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          Effect.gen(function* () {
            const preResolved =
              payload.theme === undefined
                ? undefined
                : payload.theme === null
                  ? null
                  : yield* resolveTheme(payload.theme);
            const view = yield* workspaces.updateSettings({ branding: payload }, expectedRevision);
            return yield* toBrandingView(view, preResolved);
          }),
        ),
      )
      .handle("previewPdf", ({ payload }) =>
        Effect.map(workspaces.previewBranding(payload), (file) =>
          fileDownload(file, { disposition: "inline" }),
        ),
      )
      .handle("putImage", ({ params, payload }) =>
        Effect.gen(function* () {
          let uploaded: ImageRef | undefined;
          yield* Stream.runForEach(payload, (part) =>
            Effect.gen(function* () {
              if (part._tag !== "File" || part.key !== "file" || uploaded !== undefined) {
                return yield* new Invalid({
                  issues: [{ path: ["file"], code: "request.malformed" }],
                });
              }
              const bytes = part.content.pipe(
                Stream.catch((err) => Stream.die(new MultipartStreamDefect(err))),
              );
              uploaded = yield* workspaces
                .setBrandingImage(params.image, { contentType: part.contentType, bytes })
                .pipe(
                  Effect.catchDefect((defect) =>
                    defect instanceof MultipartStreamDefect
                      ? Effect.fail(mapMultipartError(defect.error))
                      : Effect.die(defect),
                  ),
                );
            }),
          ).pipe(Effect.catchTag("MultipartError", (err) => Effect.fail(mapMultipartError(err))));
          if (uploaded === undefined) {
            return yield* new Invalid({
              issues: [{ path: ["file"], code: "request.malformed" }],
            });
          }
          return uploaded;
        }),
      )
      .handle("getImage", ({ params }) =>
        Effect.gen(function* () {
          const file = yield* workspaces.brandingImage(params.image);
          const view = yield* workspaces.current;
          const ref = view.branding[params.image];
          return downloadResponse(ref === null ? file : { ...file, sizeBytes: ref.bytes }, {
            etag: ref === null ? undefined : `"${ref.sha256}"`,
            cacheControl: "private, max-age=300",
          });
        }),
      )
      .handle("removeImage", ({ params }) => workspaces.removeBrandingImage(params.image));
  }),
);
