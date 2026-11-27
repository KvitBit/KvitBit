import * as Effect from "effect/Effect";
import { fromMobilePromise } from "../runtime/request-intent";

/** The update information the foreground check uses. */
export interface OtaUpdateSource {
  readonly checkForUpdateAsync: () => Promise<{
    readonly isAvailable: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly fetchUpdateAsync: () => Promise<
    | { readonly isNew: false; readonly isRollBackToEmbedded: boolean }
    | {
        readonly isNew: true;
        readonly isRollBackToEmbedded: false;
        readonly manifest: { readonly id: string };
      }
  >;
}

/**
 * What a restart launches once a check has fetched it: a downloaded update,
 * or the build's embedded update after the server published a rollback.
 */
export type ReadyUpdate =
  | { readonly kind: "update"; readonly updateId: string }
  | { readonly kind: "embedded" };

/**
 * Asks the update server for a JS update and downloads it. Resolves what a
 * restart would launch once a new update is ready, and `undefined`
 * otherwise. `expo-updates` reports a rollback as no update available with
 * `isRollBackToEmbedded`; fetching it records the rollback, so the embedded
 * update launches on the next start instead of any downloaded one. An
 * offline device, a rejected signature or a disabled updates module only
 * skips this check.
 */
export const findReadyUpdate = (updates: OtaUpdateSource): Effect.Effect<ReadyUpdate | undefined> =>
  Effect.gen(function* () {
    const check = yield* fromMobilePromise(() => updates.checkForUpdateAsync());
    if (!(check.isAvailable || check.isRollBackToEmbedded)) {
      return;
    }
    const fetched = yield* fromMobilePromise(() => updates.fetchUpdateAsync());
    if (fetched.isRollBackToEmbedded) {
      return { kind: "embedded" } as const;
    }
    return fetched.isNew ? ({ kind: "update", updateId: fetched.manifest.id } as const) : undefined;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Over-the-air update check failed", error).pipe(Effect.as(undefined)),
    ),
  );
