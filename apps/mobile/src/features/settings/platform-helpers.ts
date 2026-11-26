import { BRANDING_IMAGE_MAX_BYTES, BRANDING_IMAGE_TYPES } from "@kvitbit/api-contract";
import type { BrandingImage, ImageRef, WorkspaceId } from "@kvitbit/domain/contract";
import { type Credentials, type UiError, UiError as UiErrorFactory } from "@kvitbit/ui-port/api";
import { Platform } from "react-native";
import { apiUrl, authHeaders, errorFromResponse, parseJson } from "../../platform/transfer/http";

/** Copies text to clipboard using expo-clipboard on native and navigator.clipboard on web. */
export const copyToClipboard = async (value: string): Promise<boolean> => {
  try {
    const clipboard = await import("expo-clipboard");
    await clipboard.setStringAsync(value);
    return true;
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
};

export interface PickedBrandingImage {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly file?: Blob;
}

export type PickImageOutcome =
  | { readonly _tag: "Picked"; readonly file: PickedBrandingImage }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Invalid"; readonly reason: "type" | "size" | "unavailable" };

const isAcceptedBrandingType = (mimeType: string): boolean =>
  (BRANDING_IMAGE_TYPES as ReadonlyArray<string>).includes(mimeType.toLowerCase());

/** Picks a PNG or JPEG image (<= 2 MB) for workspace logo or stamp. */
export const pickBrandingImage = async (): Promise<PickImageOutcome> => {
  try {
    const picker = await import("expo-image-picker");
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return { _tag: "Cancelled" };
    const asset = result.assets[0];
    if (asset === undefined) return { _tag: "Cancelled" };
    const mimeType =
      asset.mimeType ?? (asset.uri.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    if (!isAcceptedBrandingType(mimeType)) return { _tag: "Invalid", reason: "type" };
    if (asset.fileSize !== undefined && asset.fileSize > BRANDING_IMAGE_MAX_BYTES) {
      return { _tag: "Invalid", reason: "size" };
    }
    const name = asset.fileName ?? `branding.${mimeType === "image/png" ? "png" : "jpg"}`;
    const webFile = (asset as { readonly file?: Blob }).file;
    return {
      _tag: "Picked",
      file: {
        uri: asset.uri,
        name,
        mimeType,
        ...(asset.fileSize === undefined ? {} : { sizeBytes: asset.fileSize }),
        ...(webFile === undefined ? {} : { file: webFile }),
      },
    };
  } catch {
    return { _tag: "Invalid", reason: "unavailable" };
  }
};

/**
 * Uploads a branding image via `PUT /api/v1/workspaces/:workspaceId/branding/:image`
 * (multipart field `file`, per BrandingImagePayload in @kvitbit/api-contract).
 */
export const uploadBrandingImage = async (params: {
  readonly origin: string;
  readonly credentials: Credentials;
  readonly workspaceId: WorkspaceId;
  readonly image: BrandingImage;
  readonly file: PickedBrandingImage;
}): Promise<
  | { readonly _tag: "Ok"; readonly value: ImageRef }
  | { readonly _tag: "Err"; readonly error: UiError }
> => {
  try {
    const url = apiUrl(params.origin, `/workspaces/${params.workspaceId}/branding/${params.image}`);
    const body = new FormData();
    if (Platform.OS === "web") {
      const blob = params.file.file ?? (await (await fetch(params.file.uri)).blob());
      body.append("file", blob, params.file.name);
    } else {
      body.append("file", {
        uri: params.file.uri,
        name: params.file.name,
        type: params.file.mimeType,
      } as unknown as Blob);
    }
    const response = await fetch(url, {
      method: "PUT",
      headers: authHeaders(params.credentials),
      credentials: params.credentials._tag === "Bearer" ? "omit" : "include",
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        _tag: "Err",
        error: errorFromResponse(response.status, text, response.headers.get("x-request-id")),
      };
    }
    const parsed = parseJson(text);
    if (parsed === undefined) {
      return {
        _tag: "Err",
        error: UiErrorFactory.unexpected(response.status, response.headers.get("x-request-id")),
      };
    }
    return { _tag: "Ok", value: parsed as ImageRef };
  } catch {
    return { _tag: "Err", error: UiErrorFactory.offline };
  }
};
