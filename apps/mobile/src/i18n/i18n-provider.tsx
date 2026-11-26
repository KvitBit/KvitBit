import type { Text } from "@kvitbit/ui-port";
import {
  DEFAULT_LOCALE,
  type Locale,
  negotiateLocale,
  type Translator,
  translate,
  translator,
} from "@kvitbit/ui-port/i18n";
import { getLocales } from "expo-localization";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/** A string the shared catalogues lack (mobile-only chrome), given in both locales. */
export interface LocalCopy {
  readonly cs: string;
  readonly en: string;
}

export interface I18n extends Translator {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  /** Resolves a presenter `Text` descriptor. */
  readonly text: (text: Text) => string;
  /** Picks the current locale's copy of a mobile-only string. */
  readonly local: (copy: LocalCopy) => string;
}

const I18nContext = createContext<I18n | null>(null);

/** The device's preferred locale, negotiated against cs/en (cs default). */
export const deviceLocale = (): Locale => {
  try {
    return negotiateLocale(getLocales().map((l) => l.languageTag));
  } catch {
    return DEFAULT_LOCALE;
  }
};

export const makeI18n = (locale: Locale, setLocale: (next: Locale) => void): I18n => ({
  ...translator(locale),
  locale,
  setLocale,
  text: (text) => translate(locale, text),
  local: (copy) => copy[locale],
});

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

export const useI18n = (): I18n => {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n needs an I18nProvider");
  return value;
};
