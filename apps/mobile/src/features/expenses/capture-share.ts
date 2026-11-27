import type { IncomingSharedFile } from "../../platform/capture/share-intent";
import type { CaptureAccess, makeCaptureQueue } from "./capture-queue";

export async function importSharedReceipts(
  access: CaptureAccess,
  queue: Pick<ReturnType<typeof makeCaptureQueue>, "stage">,
  inbox: {
    readonly list: () => Promise<readonly IncomingSharedFile[]>;
    readonly acknowledge: (uris: readonly string[]) => Promise<void>;
  },
) {
  if (!access.canWrite()) return null;
  const files = await inbox.list();
  if (!access.canWrite() || files.length === 0) return null;
  const staged = await queue.stage(
    access,
    null,
    files.map((file) => ({
      ref: file.uri,
      source: file.uri,
      name: file.filename,
      contentType: file.mimeType,
      size: file.sizeBytes,
    })),
  );
  if (staged.acknowledge.length > 0) await inbox.acknowledge(staged.acknowledge);
  return staged;
}
