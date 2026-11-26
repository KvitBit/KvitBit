import type { ReadyUpdate } from "./ota-update";

/**
 * The reload the banner offers: into a downloaded update, or into the
 * build's embedded update after the server published a rollback.
 */
export type UpdatePrompt =
  | { readonly kind: "ota-update"; readonly updateId: string }
  | { readonly kind: "roll-back" };

/**
 * The prompt for the update a reload would launch. `runsEmbeddedUpdate` is
 * `Updates.isEmbeddedLaunch`: an app already on its embedded update gains
 * nothing from reloading after a rollback.
 */
export const selectUpdatePrompt = ({
  readyUpdate,
  runsEmbeddedUpdate,
}: {
  readonly readyUpdate: ReadyUpdate | undefined;
  readonly runsEmbeddedUpdate: boolean;
}): UpdatePrompt | undefined => {
  if (readyUpdate === undefined) return undefined;
  if (readyUpdate.kind === "embedded") {
    return runsEmbeddedUpdate ? undefined : { kind: "roll-back" };
  }
  return { kind: "ota-update", updateId: readyUpdate.updateId };
};

/**
 * The update state after a check. A downloaded update or rollback stays
 * ready until the reload, so a later empty or failed check keeps it, and a
 * newer one replaces it: a reload launches only the newest.
 */
export const nextReadyUpdate = (
  previous: ReadyUpdate | undefined,
  found: ReadyUpdate | undefined,
): ReadyUpdate | undefined => found ?? previous;
