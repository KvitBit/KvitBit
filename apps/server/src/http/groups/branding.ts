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
import * as Effect from "effect/Effect";
import type * as Multipart from "effect/http/Multipart";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Stream from "effect/Stream";
import { downloadResponse, withRevision } from "../conventions";
import { multipartFailureKind } from "./records/multipart";
import { resolveTheme } from "./workspace/themeResolver";

/** Sentinel defect used to abort core's `Stream.runForEach` cleanly when a multipart part fails mid-stream. */
class MultipartStreamDefect {
  readonly _tag = "MultipartStreamDefect";
  readonly error: Multipart.MultipartError;

  constructor(error: Multipart.MultipartError) {
    this.error = error;
  }
}

const mapMultipartError = (
  error: Multipart.MultipartError,
): Invalid | PayloadTooLarge | Unavailable => {
  switch (multipartFailureKind[error.reason._tag]) {
    case "size":
      return PayloadTooLarge.make({ limitBytes: BRANDING_IMAGE_MAX_BYTES });
    case "shape":
      return Invalid.make({ issues: [{ path: ["file"], code: "request.malformed" }] });
    case "internal":
      return Unavailable.make({ dependency: "blob_storage" });
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

export const BrandingGroupLive = HttpApiBuilder.group(
  Api,
  "branding",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("getBranding", () =>
        Effect.flatMap(workspaces.current, (view) => toBrandingView(view)),
      )
      .handle("updateBranding", ({ headers, payload }) =>
        withRevision(
          headers["if-match"],
          Effect.fnUntraced(function* (expectedRevision) {
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
          downloadResponse({ disposition: "inline" })(file),
        ),
      )
      .handle(
        "putImage",
        Effect.fnUntraced(function* ({ params, payload }) {
          let uploaded: ImageRef | undefined;
          yield* Stream.runForEach(
            payload,
            Effect.fnUntraced(function* (part) {
              if (part._tag !== "File" || part.key !== "file" || uploaded !== undefined) {
                return yield* Invalid.make({
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
                      ? defect.error.pipe(mapMultipartError, Effect.fail)
                      : Effect.die(defect),
                  ),
                );
            }),
          ).pipe(
            Effect.catchTag("MultipartError", (error) =>
              error.pipe(mapMultipartError, Effect.fail),
            ),
          );
          if (uploaded === undefined) {
            return yield* Invalid.make({
              issues: [{ path: ["file"], code: "request.malformed" }],
            });
          }
          return uploaded;
        }),
      )
      .handle(
        "getImage",
        Effect.fnUntraced(function* ({ params }) {
          const file = yield* workspaces.brandingImage(params.image);
          const view = yield* workspaces.current;
          const ref = view.branding[params.image];
          return downloadResponse({
            etag: ref === null ? undefined : `"${ref.sha256}"`,
            cacheControl: "private, max-age=300",
          })(ref === null ? file : { ...file, sizeBytes: ref.bytes });
        }),
      )
      .handle("removeImage", ({ params }) => workspaces.removeBrandingImage(params.image));
  }),
);
