import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { readReceiptBytes } from "../../platform/capture/receipt-files";
import type { LocalFile, SavedFile } from "../../platform/transfer";
import { ATTACHMENT_MAX_BYTES, validateAttachmentFile } from "./model";

type ReceiptIssue = NonNullable<ReturnType<typeof validateAttachmentFile>>;

export class InvalidReceipt extends Error {
  constructor(readonly issue: ReceiptIssue) {
    super(issue);
  }
}

export async function readReceipt(
  file: SavedFile,
  readBytes = readReceiptBytes,
): Promise<{
  readonly file: LocalFile;
  readonly bytes: Uint8Array<ArrayBuffer>;
}> {
  // Picker metadata is advisory. Check the bytes that will actually be uploaded.
  const issue = validateAttachmentFile({ ...file, size: 0 });
  if (issue !== null) throw new InvalidReceipt(issue);
  const bytes = await readBytes(file.ref, ATTACHMENT_MAX_BYTES);
  if (bytes === null || bytes.byteLength > ATTACHMENT_MAX_BYTES)
    throw new InvalidReceipt("too_large");
  const hash = await digest(CryptoDigestAlgorithm.SHA256, bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { file: { ...file, size: bytes.byteLength, sha256 }, bytes };
}
