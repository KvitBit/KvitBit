import { BRANDING_IMAGE_MAX_BYTES, BRANDING_IMAGE_TYPES } from "@kvitbit/api-contract";
import { type BrandingImage, ImageRef, type WorkspaceId } from "@kvitbit/domain/contract";
import { type ApiResult, type Credentials, err, ok, UiError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Platform } from "react-native";
import { apiUrl, authHeaders, errorFromResponse } from "../../platform/transfer/http";
import { fromMobilePromise } from "../../runtime/request-intent";

/** Copies text to clipboard using expo-clipboard, with the browser API as a fallback. */
export const copyToClipboard = Effect.fn("Settings.copyToClipboard")(
  function* (value: string) {
    const clipboard = yield* fromMobilePromise(() => import("expo-clipboard"));
    yield* fromMobilePromise(() => clipboard.setStringAsync(value));
    return true;
  },
  (effect, value) =>
    Effect.catch(effect, () => {
      const clipboard = globalThis.navigator?.clipboard;
      return clipboard === undefined
        ? Effect.succeed(false)
        : fromMobilePromise(() => clipboard.writeText(value)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
    }),
);

interface PickedBrandingImage {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly file?: Blob;
}

type PickImageOutcome =
  | { readonly _tag: "Picked"; readonly file: PickedBrandingImage }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Invalid"; readonly reason: "type" | "size" | "unavailable" };

/** Picks a PNG or JPEG image (<= 2 MB) for workspace logo or stamp. */
export const pickBrandingImage = Effect.fn("Settings.pickBrandingImage")(
  function* (): Effect.fn.Return<
    PickImageOutcome,
    Effect.Error<ReturnType<typeof fromMobilePromise>>
  > {
    const picker = yield* fromMobilePromise(() => import("expo-image-picker"));
    const result = yield* fromMobilePromise(() =>
      picker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        quality: 1,
      }),
    );
    const asset = result.assets?.[0];
    if (result.canceled || asset === undefined) return { _tag: "Cancelled" };
    const mimeType =
      asset.mimeType ??
      (Str.endsWith(".png")(Str.toLowerCase(asset.uri)) ? "image/png" : "image/jpeg");
    if (!Arr.some(BRANDING_IMAGE_TYPES, (accepted) => accepted === Str.toLowerCase(mimeType))) {
      return { _tag: "Invalid", reason: "type" };
    }
    if (asset.fileSize !== undefined && asset.fileSize > BRANDING_IMAGE_MAX_BYTES) {
      return { _tag: "Invalid", reason: "size" };
    }
    const file = {
      uri: asset.uri,
      name: asset.fileName ?? `branding.${mimeType === "image/png" ? "png" : "jpg"}`,
      mimeType,
    };
    return {
      _tag: "Picked",
      file: asset.file === undefined ? file : { ...file, file: asset.file },
    };
  },
  Effect.orElseSucceed((): PickImageOutcome => ({ _tag: "Invalid", reason: "unavailable" })),
);

const decodeImageRef = Schema.decodeOption(Schema.fromJsonString(ImageRef));

/** Uploads a logo or stamp using the branding endpoint's multipart file field. */
export const uploadBrandingImage = Effect.fn("Settings.uploadBrandingImage")(
  function* (params: {
    readonly origin: string;
    readonly credentials: Credentials;
    readonly workspaceId: WorkspaceId;
    readonly image: BrandingImage;
    readonly file: PickedBrandingImage;
  }): Effect.fn.Return<ApiResult<ImageRef>, Effect.Error<ReturnType<typeof fromMobilePromise>>> {
    const url = apiUrl(params.origin, `/workspaces/${params.workspaceId}/branding/${params.image}`);
    const fetch = yield* FetchHttpClient.Fetch;
    const body = new FormData();
    if (Platform.OS === "web") {
      let blob = params.file.file;
      if (blob === undefined) {
        const response = yield* fromMobilePromise(() => fetch(params.file.uri));
        blob = yield* fromMobilePromise(() => response.blob());
      }
      body.append("file", blob, params.file.name);
    } else {
      // React Native FormData accepts URI parts in addition to browser Blob parts.
      Reflect.apply(body.append, body, [
        "file",
        {
          uri: params.file.uri,
          name: params.file.name,
          type: params.file.mimeType,
        },
      ]);
    }
    const response = yield* fromMobilePromise(() =>
      fetch(url, {
        method: "PUT",
        headers: authHeaders(params.credentials),
        credentials: params.credentials._tag === "Bearer" ? "omit" : "include",
        body,
      }),
    );
    const text = yield* fromMobilePromise(() => response.text());
    const requestId = response.headers.get("x-request-id");
    if (!response.ok)
      return err(errorFromResponse({ status: response.status, body: text, requestId }));
    const parsed = decodeImageRef(text);
    return Option.isSome(parsed)
      ? ok(parsed.value)
      : err(UiError.unexpected(response.status, requestId));
  },
  Effect.orElseSucceed((): ApiResult<ImageRef> => err(UiError.offline)),
);
