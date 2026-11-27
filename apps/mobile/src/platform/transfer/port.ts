/** The Transfer port (ui-port-contracts 5.3) as the app uses it: promise-based, results as data. */
import type { LocalFile, SavedFile, TransferResult } from "./http";

export interface UploadRequest {
  /** API path under `/api/v1`, e.g. `/workspaces/{id}/expenses/{eid}/attachments`. */
  readonly path: string;
  readonly file: LocalFile;
  readonly headers?: Readonly<Record<string, string>>;
  /** 0..1 */
  readonly onProgress?: (value: number) => void;
}

export interface DownloadRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly filename: string;
  /** Fallback when the response carries no Content-Type. */
  readonly contentType?: string;
}

export interface Transfer {
  /** Multipart POST, one part named `file`; the value is the decoded JSON body. */
  readonly upload: (req: UploadRequest) => Promise<TransferResult<unknown>>;
  /** Authenticated GET into app storage (Android cache, a Blob object URL on web). */
  readonly download: (req: DownloadRequest) => Promise<TransferResult<SavedFile>>;
  /** System viewer: share sheet / intent on Android, a new tab on web. */
  readonly open: (file: SavedFile) => Promise<TransferResult<void>>;
  /** Share or save: Android share sheet (share-to-save), Web Share with files or a download. */
  readonly share: (file: SavedFile) => Promise<TransferResult<void>>;
}
