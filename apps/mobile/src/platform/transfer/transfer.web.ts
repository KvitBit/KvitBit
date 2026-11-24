/**
 * Web/PWA Transfer (ui-port-contracts 5.3): XHR multipart upload (progress through
 * `xhr.upload`), fetch to a Blob for downloads, a new tab to open and Web Share with files, else
 * an `<a download>`, to share. The session cookie authenticates, so no header is added.
 */
import { UiError } from "@kvitbit/ui-port/api";
import { blobOf } from "../capture/blob-store";
import {
  apiUrl,
  authHeaders,
  done,
  errorFromResponse,
  failed,
  isSuccess,
  parseJson,
  type SavedFile,
  type TransferTarget,
} from "./http";
import type { Transfer } from "./port";

const download = (file: SavedFile, url: string): void => {
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

export const makeTransfer = (target: TransferTarget): Transfer => ({
  upload: async (req) => {
    const blob = await blobOf(req.file.ref);
    if (blob === null) return failed(UiError.unexpected());
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl(target.origin, req.path));
      xhr.withCredentials = true;
      xhr.setRequestHeader("accept", "application/json");
      for (const [k, v] of Object.entries({ ...authHeaders(target.credentials), ...req.headers }))
        xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) req.onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        const body = parseJson(xhr.responseText);
        resolve(
          isSuccess(xhr.status)
            ? done(body)
            : failed(errorFromResponse(xhr.status, body, xhr.getResponseHeader("x-request-id"))),
        );
      };
      xhr.onerror = () => resolve(failed(UiError.offline));
      xhr.ontimeout = () => resolve(failed(UiError.timeout));
      xhr.onabort = () => resolve(failed(UiError.cancelled));
      const form = new FormData();
      form.append("file", blob, req.file.name);
      xhr.send(form);
    });
  },
  download: async (req) => {
    try {
      const response = await fetch(apiUrl(target.origin, req.path, req.query), {
        credentials: "include",
        headers: authHeaders(target.credentials),
      });
      if (!isSuccess(response.status)) {
        const text = await response.text().catch(() => "");
        return failed(
          errorFromResponse(response.status, parseJson(text), response.headers.get("x-request-id")),
        );
      }
      const blob = await response.blob();
      return done({
        ref: URL.createObjectURL(blob),
        name: req.filename,
        contentType: blob.type || req.contentType || "application/octet-stream",
        size: blob.size,
      });
    } catch {
      return failed(UiError.offline);
    }
  },
  open: async (file) => {
    const url = file.ref.startsWith("idb:") ? await objectUrlOf(file.ref) : file.ref;
    if (url === null) return failed(UiError.unexpected());
    window.open(url, "_blank", "noopener");
    return done(undefined);
  },
  share: async (file) => {
    const blob = await blobOf(file.ref);
    if (blob === null) return failed(UiError.unexpected());
    const asFile = new File([blob], file.name, { type: file.contentType });
    try {
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [asFile] })) {
        await navigator.share({ files: [asFile], title: file.name });
        return done(undefined);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return done(undefined);
    }
    const url = URL.createObjectURL(blob);
    download(file, url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return done(undefined);
  },
});

const objectUrlOf = async (ref: string): Promise<string | null> => {
  const blob = await blobOf(ref);
  return blob === null ? null : URL.createObjectURL(blob);
};
