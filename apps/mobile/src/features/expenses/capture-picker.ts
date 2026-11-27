/** Camera, gallery and document picker ports for expense receipt capture. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { LocalFile } from "../../platform/transfer";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
import { ALLOWED_ATTACHMENT_TYPES, ATTACHMENT_MAX_BYTES, validateAttachmentFile } from "./model";
import { InvalidReceipt, readReceipt } from "./receipt-file";

export type PickerOutcome =
  | { readonly _tag: "Picked"; readonly files: ReadonlyArray<LocalFile> }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "PermissionDenied" }
  | { readonly _tag: "Error"; readonly message: string };

export interface ReceiptPicker {
  readonly takePhoto: () => Promise<PickerOutcome>;
  readonly pickFromGallery: () => Promise<PickerOutcome>;
  readonly pickDocument: () => Promise<PickerOutcome>;
}

const mimeFromName = (name: string, fallback: string): string => {
  const lower = Str.toLowerCase(name);
  if (Str.endsWith(".pdf")(lower)) return "application/pdf";
  if (Str.endsWith(".png")(lower)) return "image/png";
  if (Str.endsWith(".heic")(lower)) return "image/heic";
  if (Str.endsWith(".heif")(lower)) return "image/heif";
  if (Str.endsWith(".jpg")(lower) || Str.endsWith(".jpeg")(lower)) return "image/jpeg";
  return fallback;
};

interface PickerAsset {
  readonly uri: string;
  readonly fileName?: string | null | undefined;
  readonly name?: string | undefined;
  readonly mimeType?: string | null | undefined;
  readonly fileSize?: number | null | undefined;
  readonly size?: number | null | undefined;
}

const assetToLocalFile = Effect.fn("CapturePicker.readAsset")(
  (asset: PickerAsset, fallbackName: string, fallbackMime: string) => {
    const name = asset.fileName ?? asset.name ?? fallbackName;
    const contentType = asset.mimeType ?? mimeFromName(name, fallbackMime);
    const size = asset.fileSize ?? asset.size ?? 0;
    const source = { ref: asset.uri, name, contentType, size };
    // Leave rejected metadata for the caller to present alongside any accepted files.
    if (validateAttachmentFile(source) !== null) {
      return Effect.succeed({ ...source, sha256: "" });
    }
    return fromMobilePromise(() => readReceipt(source)).pipe(
      Effect.map(({ file }) => file),
      Effect.catchIf(
        (error) => Schema.is(InvalidReceipt)(error.cause) && error.cause.issue === "too_large",
        () => Effect.succeed({ ...source, size: ATTACHMENT_MAX_BYTES + 1, sha256: "" }),
      ),
    );
  },
);

const readAssets = Effect.fn("CapturePicker.readAssets")(function* (
  result: ImagePicker.ImagePickerResult | DocumentPicker.DocumentPickerResult,
  fileName: (index: number) => string,
  fallbackMime: string,
) {
  if (result.canceled || result.assets.length === 0) return { _tag: "Cancelled" } as const;
  const files = yield* Effect.forEach(
    result.assets,
    (asset, index) => assetToLocalFile(asset, fileName(index), fallbackMime),
    { concurrency: "unbounded" },
  );
  return { _tag: "Picked", files } as const;
});

type PickerError = Effect.Error<ReturnType<typeof fromMobilePromise>>;

const runPicker = (fallback: string) => (effect: Effect.Effect<PickerOutcome, PickerError>) =>
  runFeatureEffect(
    Effect.orElseSucceed(
      effect,
      (error): PickerOutcome => ({
        _tag: "Error",
        message: error.cause instanceof Error ? error.cause.message : fallback,
      }),
    ),
  );

export const defaultReceiptPicker: ReceiptPicker = {
  takePhoto: Effect.fn("CapturePicker.takePhoto")(function* () {
    const permission = yield* fromMobilePromise(ImagePicker.requestCameraPermissionsAsync);
    if (!permission.granted) return { _tag: "PermissionDenied" } as const;
    const result = yield* fromMobilePromise(() =>
      ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
      }),
    );
    return yield* readAssets(result, (index) => `receipt-${index + 1}.jpg`, "image/jpeg");
  }, runPicker("Camera unavailable")),
  pickFromGallery: Effect.fn("CapturePicker.gallery")(function* () {
    const result = yield* fromMobilePromise(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 0.9,
      }),
    );
    return yield* readAssets(result, (index) => `photo-${index + 1}.jpg`, "image/jpeg");
  }, runPicker("Gallery unavailable")),
  pickDocument: Effect.fn("CapturePicker.document")(function* () {
    const result = yield* fromMobilePromise(() =>
      DocumentPicker.getDocumentAsync({
        type: [...ALLOWED_ATTACHMENT_TYPES],
        multiple: true,
        copyToCacheDirectory: true,
      }),
    );
    return yield* readAssets(result, (index) => `document-${index + 1}.pdf`, "application/pdf");
  }, runPicker("Document picker unavailable")),
};
