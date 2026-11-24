/**
 * Android Transfer (ui-port-contracts 5.3): `expo-file-system` multipart upload task with field
 * `file` and the bearer header, `downloadAsync` into the cache directory, `expo-sharing` for the
 * system viewer and share-to-save. Web lives in `transfer.web.ts`.
 */

import { UiError } from "@kvitbit/ui-port/api";
import {
  cacheDirectory,
  createUploadTask,
  deleteAsync,
  downloadAsync,
  FileSystemUploadType,
  getInfoAsync,
  readAsStringAsync,
} from "expo-file-system/legacy";
import { shareAsync } from "expo-sharing";
import {
  apiUrl,
  authHeaders,
  done,
  errorFromResponse,
  failed,
  isSuccess,
  parseJson,
  safeFileName,
  type TransferTarget,
} from "./http";
import type { Transfer } from "./port";

const header = (headers: Record<string, string>, name: string): string | null => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? null : (headers[key] ?? null);
};

export const makeTransfer = (target: TransferTarget): Transfer => ({
  upload: async (req) => {
    try {
      const task = createUploadTask(
        apiUrl(target.origin, req.path),
        req.file.ref,
        {
          httpMethod: "POST",
          uploadType: FileSystemUploadType.MULTIPART,
          fieldName: "file",
          mimeType: req.file.contentType,
          headers: {
            accept: "application/json",
            ...authHeaders(target.credentials),
            ...req.headers,
          },
        },
        (progress) => {
          if (progress.totalBytesExpectedToSend > 0)
            req.onProgress?.(progress.totalBytesSent / progress.totalBytesExpectedToSend);
        },
      );
      const response = await task.uploadAsync();
      if (response === undefined || response === null) return failed(UiError.cancelled);
      const body = parseJson(response.body);
      if (isSuccess(response.status)) return done(body);
      return failed(
        errorFromResponse(response.status, body, header(response.headers, "x-request-id")),
      );
    } catch {
      return failed(UiError.offline);
    }
  },
  download: async (req) => {
    const target_ = `${cacheDirectory ?? ""}${Date.now()}-${safeFileName(req.filename)}`;
    try {
      const response = await downloadAsync(apiUrl(target.origin, req.path, req.query), target_, {
        headers: authHeaders(target.credentials),
      });
      if (!isSuccess(response.status)) {
        const text = await readAsStringAsync(response.uri).catch(() => "");
        await deleteAsync(response.uri, { idempotent: true }).catch(() => undefined);
        return failed(
          errorFromResponse(
            response.status,
            parseJson(text),
            header(response.headers, "x-request-id"),
          ),
        );
      }
      const info = await getInfoAsync(response.uri);
      return done({
        ref: response.uri,
        name: req.filename,
        contentType:
          header(response.headers, "content-type") ?? req.contentType ?? "application/octet-stream",
        size: info.exists ? info.size : 0,
      });
    } catch {
      return failed(UiError.offline);
    }
  },
  open: async (file) => {
    try {
      await shareAsync(file.ref, { mimeType: file.contentType, dialogTitle: file.name });
      return done(undefined);
    } catch {
      return failed(UiError.unexpected());
    }
  },
  share: async (file) => {
    try {
      await shareAsync(file.ref, { mimeType: file.contentType, dialogTitle: file.name });
      return done(undefined);
    } catch {
      return failed(UiError.unexpected());
    }
  },
});
