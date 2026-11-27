import type { Locale } from "@kvitbit/ui-port/i18n";
import * as Effect from "effect/Effect";
import type { ReactNode } from "react";
import { I18nProvider } from "../i18n/i18n-provider";
import { ThemeProvider } from "../theme/theme-provider";
import { type Overlay, OverlayContextProvider } from "../ui/overlay";

/** Records what a component under test asked the overlay for. */
export interface RecordedOverlay extends Overlay {
  readonly toasts: string[];
  /** Answer for the next confirmations (default true). */
  answer: boolean;
}

// biome-ignore lint/style/useComponentExportOnlyModules: Test helpers are outside the Fast Refresh module graph.
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

/**
 * Theme, i18n and a recording overlay for component tests. Renders no host elements, so it also
 * works as `hostTree`'s `within`.
 */
export function TestProviders(props: {
  readonly children: ReactNode;
  readonly locale?: Locale;
  readonly overlay?: Overlay;
}) {
  return (
    <I18nProvider initialLocale={props.locale ?? "en"}>
      <ThemeProvider>
        <OverlayContextProvider value={props.overlay ?? recordedOverlay()}>
          {props.children}
        </OverlayContextProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
