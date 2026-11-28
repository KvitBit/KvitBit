/**
 * Blob access for web transfers. Android files are `file://` URIs read by `expo-file-system`,
 * so there is no Blob store on native; the web build resolves `blob-store.web.ts`.
 */
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed } from "../platform-effect";

export const blobOf = (_ref: string): Promise<Blob | null> => runMobileEffect(Effect.succeed(null));

export const putBlob: {
  (_blob: Blob): (_key: string) => Promise<string>;
  (_key: string, _blob: Blob): Promise<string>;
} = Fn.dual(
  2,
  (_key: string, _blob: Blob): Promise<string> =>
    PlatformOperationFailed.make({ cause: "blob-store is web only" }).pipe(
      Effect.fail,
      runMobileEffect,
    ),
);

export const deleteBlob = (_ref: string): Promise<void> => runMobileEffect(Effect.void);
