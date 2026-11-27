import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DeviceEventEmitter, NativeModules, Platform } from "react-native";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";

const IncomingSharedFile = Schema.Struct({
  uri: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
});

export type IncomingSharedFile = typeof IncomingSharedFile.Type;

const decodeFiles = Schema.decodeUnknownEffect(Schema.Array(IncomingSharedFile));
const NativeMethod = Schema.instanceOf(globalThis.Function);
const NativeShareIntent = Schema.Struct({
  listPendingSharedFiles: Schema.optional(NativeMethod),
  acknowledgeSharedFiles: Schema.optional(NativeMethod),
});
const decodeNative = Schema.decodeUnknownOption(NativeShareIntent);
const nativeModule = tryPlatform(() => {
  const raw: unknown = NativeModules["KvitbitShareIntent"];
  return { raw, methods: decodeNative(raw) };
});

const list = Effect.fn("ShareIntent.list")(function* () {
  if (Platform.OS !== "android") return [];
  const { raw, methods: native } = yield* nativeModule;
  if (Option.isNone(native) || native.value.listPendingSharedFiles === undefined) return [];
  const { listPendingSharedFiles } = native.value;
  const files = yield* fromMobilePromise(
    (): Promise<unknown> => Reflect.apply(listPendingSharedFiles, raw, []),
  );
  return yield* decodeFiles(files ?? []);
});

const acknowledge = Effect.fn("ShareIntent.acknowledge")(function* (uris: readonly string[]) {
  if (Platform.OS !== "android" || uris.length === 0) return;
  const { raw, methods: native } = yield* nativeModule;
  if (Option.isNone(native) || native.value.acknowledgeSharedFiles === undefined) return;
  const { acknowledgeSharedFiles } = native.value;
  yield* fromMobilePromise(
    (): Promise<unknown> => Reflect.apply(acknowledgeSharedFiles, raw, [uris]),
  );
});

/** Lists files until the durable receipt queue confirms that it has a copy. */
export const listPendingSharedFiles = (): Promise<readonly IncomingSharedFile[]> =>
  runMobileEffect(list());

export const acknowledgeSharedFiles = (uris: readonly string[]): Promise<void> =>
  runMobileEffect(acknowledge(uris));

/** Subscribes to live Android share-sheet deliveries while the app is open. */
export const subscribeSharedFiles = (onFiles: () => void): (() => void) => {
  if (Platform.OS !== "android") return () => undefined;
  const sub = DeviceEventEmitter.addListener("KvitbitSharedReceipts", onFiles);
  return () => sub.remove();
};
