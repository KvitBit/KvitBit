import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { readReceiptBytes } from "../../platform/capture/receipt-files";
import type { LocalFile, SavedFile } from "../../platform/transfer";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
import { ATTACHMENT_MAX_BYTES, validateAttachmentFile } from "./model";

export class InvalidReceipt extends Schema.TaggedError<
  InvalidReceipt,
  { readonly brand: unique symbol }
>()("InvalidReceipt", {
  issue: Schema.Literals(["too_large", "unsupported_type"]),
}) {
  override get message() {
    return this.issue;
  }
}

export const readReceipt = Effect.fn("readReceipt")(
  function* (
    file: SavedFile,
    readBytes: (
      ref: string,
      limit: number,
    ) => Promise<Uint8Array<ArrayBuffer> | null> = readReceiptBytes,
  ) {
    // Picker metadata is advisory. Check the bytes that will actually be uploaded.
    const issue = validateAttachmentFile({ ...file, size: 0 });
    if (issue !== null) return yield* InvalidReceipt.make({ issue });
    const bytes = yield* fromMobilePromise(() => readBytes(file.ref, ATTACHMENT_MAX_BYTES));
    if (bytes === null || bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      return yield* InvalidReceipt.make({ issue: "too_large" });
    }
    const hash = yield* fromMobilePromise(() => digest(CryptoDigestAlgorithm.SHA256, bytes));
    const sha256 = Arr.join(
      Array.from(new Uint8Array(hash), (byte) => Str.padStart(2, "0")(byte.toString(16))),
      "",
    );
    const saved: LocalFile = { ...file, size: bytes.byteLength, sha256 };
    return { file: saved, bytes };
  },
  (effect) =>
    runFeatureEffect(
      Effect.catchTag(effect, "MobileBridgeError", (error) => Effect.die(error.cause)),
    ),
);
