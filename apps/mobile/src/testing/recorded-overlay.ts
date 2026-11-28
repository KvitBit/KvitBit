import * as Effect from "effect/Effect";
import type { Overlay } from "../ui/overlay";

/** Records what a component under test asked the overlay for. */
export interface RecordedOverlay extends Overlay {
  readonly toasts: string[];
  /** Answer for the next confirmations (default true). */
  answer: boolean;
}

export const recordedOverlay = (): RecordedOverlay => {
  const toasts: string[] = [];
  const overlay: RecordedOverlay = {
    toasts,
    answer: true,
    toast: (text) => {
      toasts.push(text);
    },
    confirm: () => Effect.runPromise(Effect.sync(() => overlay.answer)),
  };
  return overlay;
};
