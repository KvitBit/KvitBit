import { DEFAULT_LOCALE, type Locale, negotiateLocale } from "@kvitbit/ui-port/i18n";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { getLocales } from "expo-localization";
import { type ReactNode, useMemo, useState } from "react";
import { runMobileSync } from "../runtime/request-intent";
import { I18nContext, makeI18n } from "./i18n-context";

const deviceLocale = (): Locale =>
  runMobileSync(
    Effect.try({
      try: () => negotiateLocale(Arr.map(getLocales(), (locale) => locale.languageTag)),
      catch: () => "DeviceLocaleUnavailable" as const,
    }).pipe(Effect.orElseSucceed(() => DEFAULT_LOCALE)),
  );

export function I18nProvider(props: {
  readonly children: ReactNode;
  readonly initialLocale?: Locale;
  readonly onLocaleChange?: (next: Locale) => void;
}) {
  const [locale, setLocaleState] = useState<Locale>(props.initialLocale ?? deviceLocale);
  const { onLocaleChange } = props;
  const value = useMemo(
    () =>
      makeI18n(locale, (next) => {
        setLocaleState(next);
        onLocaleChange?.(next);
      }),
    [locale, onLocaleChange],
  );
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}
