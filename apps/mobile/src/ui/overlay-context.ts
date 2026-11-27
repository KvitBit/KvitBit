import * as Option from "effect/Option";
import { createContext, useContext } from "react";

export interface ConfirmRequest {
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive?: boolean;
}

export interface Overlay {
  readonly toast: (
    text: string,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => void;
  /** Resolves true when the user confirms. */
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
}

export const OverlayContext = createContext<Overlay | null>(null);

/** The bare context, for tests that record toasts and answer confirmations. */
export const OverlayContextProvider = OverlayContext.Provider;

export const useOverlay = (): Overlay => {
  const value = useContext(OverlayContext);
  return Option.getOrThrowWith(
    Option.fromNullOr(value),
    () => new Error("useOverlay needs an OverlayProvider"),
  );
};
