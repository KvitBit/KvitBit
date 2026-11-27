/**
 * Android Transfer (ui-port-contracts 5.3): `expo-file-system` multipart upload task with field
 * `file` and the bearer header, `downloadAsync` into the cache directory, `expo-sharing` for the
 * system viewer and share-to-save. Web lives in `transfer.web.ts`.
 */

import { UiError } from "@kvitbit/ui-port/api";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as EffectString from "effect/String";
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
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";
import {
  apiUrl,
  authHeaders,
  done,
  errorFromResponse,
  failed,
  isSuccess,
  parseJson,
  type SavedFile,
  safeFileName,
  type TransferTarget,
} from "./http";
import type { DownloadRequest, Transfer, UploadRequest } from "./port";

const header = (headers: Record<string, string>, name: string): string | null => {
  const key = Option.getOrUndefined(
    EffectArray.findFirst(EffectRecord.keys(headers), (k) => EffectString.toLowerCase(k) === name),
  );
  return key === undefined ? null : (headers[key] ?? null);
};

export const makeTransfer = (target: TransferTarget): Transfer => {
  const upload = Effect.fn("NativeTransfer.upload")(function* (req: UploadRequest) {
    const task = yield* tryPlatform(() =>
      createUploadTask(
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
      ),
    );
    const response = yield* fromMobilePromise(() => task.uploadAsync());
    if (response === undefined || response === null) return failed(UiError.cancelled);
    const body = parseJson(response.body);
    if (isSuccess(response.status)) return done(body);
    return failed(
      errorFromResponse({
        status: response.status,
        body,
        requestId: header(response.headers, "x-request-id"),
      }),
    );
  });

  const download = Effect.fn("NativeTransfer.download")(function* (req: DownloadRequest) {
    const now = yield* Clock.currentTimeMillis;
    const uri = `${cacheDirectory ?? ""}${now}-${safeFileName(req.filename)}`;
    const response = yield* fromMobilePromise(() =>
      downloadAsync(apiUrl(target.origin, req.path, req.query), uri, {
        headers: authHeaders(target.credentials),
      }),
    );
    if (!isSuccess(response.status)) {
      const text = yield* fromMobilePromise(() => readAsStringAsync(response.uri)).pipe(
        Effect.orElseSucceed(() => ""),
      );
      yield* Effect.ignore(
        fromMobilePromise(() => deleteAsync(response.uri, { idempotent: true })),
      );
      return failed(
        errorFromResponse({
          status: response.status,
          body: parseJson(text),
          requestId: header(response.headers, "x-request-id"),
        }),
      );
    }
    const info = yield* fromMobilePromise(() => getInfoAsync(response.uri));
    return done({
      ref: response.uri,
      name: req.filename,
      contentType:
        header(response.headers, "content-type") ?? req.contentType ?? "application/octet-stream",
      size: info.exists ? info.size : 0,
    });
  });

  const share = (file: SavedFile) =>
    runMobileEffect(
      fromMobilePromise(() =>
        shareAsync(file.ref, { mimeType: file.contentType, dialogTitle: file.name }),
      ).pipe(
        Effect.map(done),
        Effect.orElseSucceed(() => failed(UiError.unexpected())),
      ),
    );
  return {
    upload: (req) =>
      runMobileEffect(upload(req).pipe(Effect.orElseSucceed(() => failed(UiError.offline)))),
    download: (req) =>
      runMobileEffect(download(req).pipe(Effect.orElseSucceed(() => failed(UiError.offline)))),
    open: share,
    share,
  };
};
