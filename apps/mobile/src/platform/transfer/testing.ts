/**
 * Test stand-ins for the Transfer port. Screen tests replace the native module before importing
 * the screen: `mock.module(".../platform/transfer/transfer", () => ({ makeTransfer: () => fake }))`.
 */
import { mock } from "bun:test";
import type { SavedFile, TransferResult } from "./http";
import type { DownloadRequest, Transfer, UploadRequest } from "./port";

export interface FakeTransfer extends Transfer {
  readonly uploads: Array<UploadRequest>;
  readonly downloads: Array<DownloadRequest>;
  readonly shared: Array<SavedFile>;
  readonly opened: Array<SavedFile>;
}

export const fakeTransfer = (
  replies: {
    readonly upload?: (req: UploadRequest) => TransferResult<unknown>;
    readonly download?: (req: DownloadRequest) => TransferResult<SavedFile>;
  } = {},
): FakeTransfer => {
  const uploads: Array<UploadRequest> = [];
  const downloads: Array<DownloadRequest> = [];
  const shared: Array<SavedFile> = [];
  const opened: Array<SavedFile> = [];
  return {
    uploads,
    downloads,
    shared,
    opened,
    upload: async (req) => {
      uploads.push(req);
      return replies.upload?.(req) ?? { _tag: "Ok", value: {} };
    },
    download: async (req) => {
      downloads.push(req);
      return (
        replies.download?.(req) ?? {
          _tag: "Ok",
          value: {
            ref: `file:///cache/${req.filename}`,
            name: req.filename,
            contentType: req.contentType ?? "application/octet-stream",
            size: 1,
          },
        }
      );
    },
    open: async (file) => {
      opened.push(file);
      return { _tag: "Ok", value: undefined };
    },
    share: async (file) => {
      shared.push(file);
      return { _tag: "Ok", value: undefined };
    },
  };
};

/** Registers the fake as the platform Transfer for every later import of the module. */
export const useFakeTransfer = (fake: FakeTransfer): void => {
  mock.module(new URL("./transfer.ts", import.meta.url).pathname, () => ({
    makeTransfer: () => fake,
  }));
};
