/** Clipboard helper over expo-clipboard with web navigator fallback. */
import * as Effect from "effect/Effect";
import * as Clipboard from "expo-clipboard";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";

export const copyText = Effect.fn("copyText")(
  (value: string) =>
    fromMobilePromise(() => Clipboard.setStringAsync(value)).pipe(
      Effect.as(true),
      Effect.catch(() => {
        const clipboard = globalThis.navigator?.clipboard;
        return clipboard?.writeText === undefined
          ? Effect.succeed(false)
          : fromMobilePromise(() => clipboard.writeText(value)).pipe(Effect.as(true));
      }),
      Effect.orElseSucceed(() => false),
    ),
  runFeatureEffect,
);
