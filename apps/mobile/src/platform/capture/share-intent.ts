import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

export interface IncomingSharedFile {
  readonly uri: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

interface KvitbitShareIntentNative {
  readonly listPendingSharedFiles?: () => Promise<readonly IncomingSharedFile[]>;
  readonly acknowledgeSharedFiles?: (uris: readonly string[]) => Promise<void>;
}

const getNative = (): KvitbitShareIntentNative | undefined =>
  (NativeModules as { KvitbitShareIntent?: KvitbitShareIntentNative }).KvitbitShareIntent;

/** Lists files until the durable receipt queue confirms that it has a copy. */
export const listPendingSharedFiles = async (): Promise<readonly IncomingSharedFile[]> =>
  Platform.OS === "android" ? ((await getNative()?.listPendingSharedFiles?.()) ?? []) : [];

export const acknowledgeSharedFiles = async (uris: readonly string[]): Promise<void> => {
  if (Platform.OS === "android" && uris.length > 0)
    await getNative()?.acknowledgeSharedFiles?.(uris);
};

/** Subscribes to live Android share-sheet deliveries while the app is open. */
export const subscribeSharedFiles = (onFiles: () => void): (() => void) => {
  if (Platform.OS !== "android") return () => {};
  const sub = DeviceEventEmitter.addListener("KvitbitSharedReceipts", onFiles);
  return () => sub.remove();
};
