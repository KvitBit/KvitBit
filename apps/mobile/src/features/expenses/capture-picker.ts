/**
 * Camera, gallery and document pickers for expense receipt capture.
 * Isolated behind a narrow interface so capture and detail screens can be tested without native bridges.
 */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { LocalFile } from "../../platform/transfer";
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
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return fallback;
};

const assetToLocalFile = async (
  asset: {
    readonly uri: string;
    readonly fileName?: string | null | undefined;
    readonly name?: string | undefined;
    readonly mimeType?: string | null | undefined;
    readonly fileSize?: number | null | undefined;
    readonly size?: number | null | undefined;
  },
  fallbackName: string,
  fallbackMime: string,
): Promise<LocalFile> => {
  const name = asset.fileName ?? asset.name ?? fallbackName;
  const contentType = asset.mimeType ?? mimeFromName(name, fallbackMime);
  const size = asset.fileSize ?? asset.size ?? 0;
  const source = { ref: asset.uri, name, contentType, size };
  // Leave rejected metadata for the caller to present alongside any accepted files.
  if (validateAttachmentFile(source) !== null) return { ...source, sha256: "" };
  try {
    return (await readReceipt(source)).file;
  } catch (error) {
    if (error instanceof InvalidReceipt && error.issue === "too_large") {
      return { ...source, size: ATTACHMENT_MAX_BYTES + 1, sha256: "" };
    }
    throw error;
  }
};

export const defaultReceiptPicker: ReceiptPicker = {
  takePhoto: async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return { _tag: "PermissionDenied" };
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
      });
      if (result.canceled || result.assets.length === 0) return { _tag: "Cancelled" };
      const files = await Promise.all(
        result.assets.map((asset, index) =>
          assetToLocalFile(asset, `receipt-${index + 1}.jpg`, "image/jpeg"),
        ),
      );
      return { _tag: "Picked", files };
    } catch (error) {
      return {
        _tag: "Error",
        message: error instanceof Error ? error.message : "Camera unavailable",
      };
    }
  },
  pickFromGallery: async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 0.9,
      });
      if (result.canceled || result.assets.length === 0) return { _tag: "Cancelled" };
      const files = await Promise.all(
        result.assets.map((asset, index) =>
          assetToLocalFile(asset, `photo-${index + 1}.jpg`, "image/jpeg"),
        ),
      );
      return { _tag: "Picked", files };
    } catch (error) {
      return {
        _tag: "Error",
        message: error instanceof Error ? error.message : "Gallery unavailable",
      };
    }
  },
  pickDocument: async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [...ALLOWED_ATTACHMENT_TYPES],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || result.assets.length === 0) return { _tag: "Cancelled" };
      const files = await Promise.all(
        result.assets.map((asset, index) =>
          assetToLocalFile(asset, `document-${index + 1}.pdf`, "application/pdf"),
        ),
      );
      return { _tag: "Picked", files };
    } catch (error) {
      return {
        _tag: "Error",
        message: error instanceof Error ? error.message : "Document picker unavailable",
      };
    }
  },
};
