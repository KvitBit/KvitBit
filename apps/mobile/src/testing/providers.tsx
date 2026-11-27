import type { Locale } from "@kvitbit/ui-port/i18n";
import type { ReactNode } from "react";
import { I18nProvider } from "../i18n/i18n-provider";
import { useSession } from "../session/session-provider";
import { ThemeProvider } from "../theme/theme-provider";
import { type Overlay, OverlayContextProvider } from "../ui/overlay";
import { recordedOverlay } from "./recorded-overlay";

export function SignedInFixture({ children }: { readonly children: ReactNode }) {
  return useSession().state.status === "signed-in" ? children : null;
}

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
