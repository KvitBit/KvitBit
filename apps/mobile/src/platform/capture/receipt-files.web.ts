import { blobOf, deleteBlob, putBlob } from "./blob-store";

export async function readReceiptBytes(ref: string, limit: number) {
  const blob = await blobOf(ref);
  if (blob === null) throw new Error("Receipt file unavailable");
  return blob.size > limit ? null : new Uint8Array(await blob.arrayBuffer());
}

export async function saveReceiptBytes(key: string, _name: string, bytes: Uint8Array<ArrayBuffer>) {
  const ref = await putBlob(key, new Blob([bytes]));
  // A subsequent read cannot run until the put transaction has finished.
  if ((await blobOf(ref))?.size !== bytes.byteLength) throw new Error("Receipt file was not saved");
  return ref;
}

export const removeReceiptBytes = deleteBlob;
