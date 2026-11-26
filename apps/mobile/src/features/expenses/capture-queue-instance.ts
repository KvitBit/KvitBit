import { captureStorage } from "../../platform/capture/capture-storage";
import { removeReceiptBytes, saveReceiptBytes } from "../../platform/capture/receipt-files";
import { makeCaptureQueue } from "./capture-queue";

export const captureQueue = makeCaptureQueue({
  storage: captureStorage,
  saveBytes: saveReceiptBytes,
  removeBytes: removeReceiptBytes,
});
