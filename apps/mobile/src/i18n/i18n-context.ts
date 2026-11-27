import type { Text } from "@kvitbit/ui-port";
import { type Locale, type Translator, translate, translator } from "@kvitbit/ui-port/i18n";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { createContext, useContext } from "react";

/** A string the shared catalogues lack (mobile-only chrome), given in both locales. */
interface LocalCopy {
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

export const I18nContext = createContext<I18n | null>(null);

export const makeI18n: {
  (setLocale: (next: Locale) => void): (locale: Locale) => I18n;
  (locale: Locale, setLocale: (next: Locale) => void): I18n;
} = Fn.dual(
  2,
  (locale: Locale, setLocale: (next: Locale) => void): I18n => ({
    ...translator(locale),
    locale,
    setLocale,
    text: (text) => translate(locale, text),
    local: (copy) => copy[locale],
  }),
);

export const useI18n = (): I18n => {
  const value = useContext(I18nContext);
  return Option.getOrThrowWith(
    Option.fromNullOr(value),
    () => new Error("useI18n needs an I18nProvider"),
  );
};
