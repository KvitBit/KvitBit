import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { IncomingSharedFile } from "../../platform/capture/share-intent";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
import type { CaptureAccess, makeCaptureQueue } from "./capture-queue";

export const importSharedReceipts = Effect.fn("CaptureShare.import")(
  function* (
    access: CaptureAccess,
    queue: Pick<ReturnType<typeof makeCaptureQueue>, "stage">,
    inbox: {
      readonly list: () => Promise<readonly IncomingSharedFile[]>;
      readonly acknowledge: (uris: readonly string[]) => Promise<void>;
    },
  ) {
    if (!access.canWrite()) return null;
    const files = yield* fromMobilePromise(() => inbox.list());
    if (!access.canWrite() || files.length === 0) return null;
    const sources = Arr.map(files, (file) => ({
      ref: file.uri,
      source: file.uri,
      name: file.filename,
      contentType: file.mimeType,
      size: file.sizeBytes,
    }));
    const staged = yield* fromMobilePromise(() => queue.stage(access, null, sources));
    if (staged.acknowledge.length > 0) {
      yield* fromMobilePromise(() => inbox.acknowledge(staged.acknowledge));
    }
    return staged;
  },
  (effect) => runFeatureEffect(Effect.catch(effect, (error) => Effect.die(error.cause))),
);
