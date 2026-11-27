import * as FetchHttpClient from "effect/http/FetchHttpClient";
/**
 * Web/PWA Transfer (ui-port-contracts 5.3): XHR multipart upload (progress through
 * `xhr.upload`), fetch to a Blob for downloads, a new tab to open and Web Share with files, else
 * an `<a download>`, to share. The session cookie authenticates, so no header is added.
 */

import { UiError } from "@kvitbit/ui-port/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectRecord from "effect/Record";
import * as EffectString from "effect/String";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { blobOf } from "../capture/blob-store";
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
  type TransferResult,
  type TransferTarget,
} from "./http";
import type { DownloadRequest, Transfer, UploadRequest } from "./port";

const downloadLink = (file: SavedFile, url: string): void => {
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

export const makeTransfer = (target: TransferTarget): Transfer => {
  const upload = Effect.fn("WebTransfer.upload")(function* (req: UploadRequest) {
    const blob = yield* fromMobilePromise(() => blobOf(req.file.ref));
    if (blob === null) return failed(UiError.unexpected());
    const result = yield* Deferred.make<TransferResult<unknown>>();
    const complete = (outcome: TransferResult<unknown>) => {
      Deferred.doneUnsafe(result, Effect.succeed(outcome));
    };
    yield* tryPlatform(() => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl(target.origin, req.path));
      xhr.withCredentials = true;
      xhr.setRequestHeader("accept", "application/json");
      for (const [name, value] of EffectRecord.toEntries({
        ...authHeaders(target.credentials),
        ...req.headers,
      })) {
        xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) req.onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        const body = parseJson(xhr.responseText);
        complete(
          isSuccess(xhr.status)
            ? done(body)
            : failed(errorFromResponse(xhr.status, body, xhr.getResponseHeader("x-request-id"))),
        );
      };
      xhr.onerror = () => complete(failed(UiError.offline));
      xhr.ontimeout = () => complete(failed(UiError.timeout));
      xhr.onabort = () => complete(failed(UiError.cancelled));
      const form = new FormData();
      form.append("file", blob, req.file.name);
      xhr.send(form);
    });
    return yield* Deferred.await(result);
  });

  const download = Effect.fn("WebTransfer.download")(function* (req: DownloadRequest) {
    const fetch = yield* FetchHttpClient.Fetch;
    const response = yield* fromMobilePromise(() =>
      fetch(apiUrl(target.origin, req.path, req.query), {
        credentials: "include",
        headers: authHeaders(target.credentials),
      }),
    );
    if (!isSuccess(response.status)) {
      const text = yield* fromMobilePromise(() => response.text()).pipe(
        Effect.orElseSucceed(() => ""),
      );
      return failed(
        errorFromResponse(response.status, parseJson(text), response.headers.get("x-request-id")),
      );
    }
    const blob = yield* fromMobilePromise(() => response.blob());
    const ref = yield* tryPlatform(() => URL.createObjectURL(blob));
    const contentType = blob.type === "" ? req.contentType : blob.type;
    return done({
      ref,
      name: req.filename,
      contentType:
        contentType === undefined || contentType === "" ? "application/octet-stream" : contentType,
      size: blob.size,
    });
  });

  return {
    upload: (req) =>
      runMobileEffect(upload(req).pipe(Effect.orElseSucceed(() => failed(UiError.offline)))),
    download: (req) =>
      runMobileEffect(download(req).pipe(Effect.orElseSucceed(() => failed(UiError.offline)))),
    open: (file) =>
      runMobileEffect(open(file).pipe(Effect.orElseSucceed(() => failed(UiError.unexpected())))),
    share: (file) =>
      runMobileEffect(share(file).pipe(Effect.orElseSucceed(() => failed(UiError.unexpected())))),
  };
};

const open = Effect.fn("WebTransfer.open")(function* (file: SavedFile) {
  let url = file.ref;
  if (EffectString.startsWith("idb:")(url)) {
    const blob = yield* fromMobilePromise(() => blobOf(url));
    if (blob === null) return failed(UiError.unexpected());
    url = yield* tryPlatform(() => URL.createObjectURL(blob));
  }
  yield* tryPlatform(() => window.open(url, "_blank", "noopener"));
  return done(undefined);
});

const share = Effect.fn("WebTransfer.share")(function* (file: SavedFile) {
  const blob = yield* fromMobilePromise(() => blobOf(file.ref));
  if (blob === null) return failed(UiError.unexpected());
  const asFile = yield* tryPlatform(() => new File([blob], file.name, { type: file.contentType }));
  const files = [asFile];
  const shared = yield* tryPlatform(() => navigator.canShare?.({ files }) === true).pipe(
    Effect.flatMap((supported) =>
      supported
        ? fromMobilePromise(() => navigator.share({ files, title: file.name })).pipe(
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
    Effect.catch(({ cause }) =>
      Effect.succeed(cause instanceof DOMException && cause.name === "AbortError"),
    ),
  );
  if (shared) return done(undefined);
  const url = yield* tryPlatform(() => URL.createObjectURL(blob));
  yield* tryPlatform(() => downloadLink(file, url));
  yield* Effect.forkDetach(
    Effect.sleep("60 seconds").pipe(
      Effect.andThen(Effect.ignore(tryPlatform(() => URL.revokeObjectURL(url)))),
    ),
  );
  return done(undefined);
});
