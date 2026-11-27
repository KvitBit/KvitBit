/**
 * Text resolution for views. Catalog keys come from @kvitbit/ui-port/i18n; web-only copy that the
 * shared catalog does not carry lives next to the page that uses it as a `Copy` table.
 */
import { I18n, type Text } from "@kvitbit/ui-port";
import type { Locale } from "./prefs";

export type Translator = I18n.Translator;
export const translator = (locale: Locale): Translator => I18n.translator(locale);

/** A bilingual copy table: same keys in both locales, checked by the type. */
export type Copy<K extends string> = Readonly<Record<Locale, Readonly<Record<K, string>>>>;

export const copy =
  <K extends string>(table: Copy<K>) =>
  (locale: Locale, key: K, params?: Readonly<Record<string, string | number>>): string => {
    const raw = table[locale][key];
    return params === undefined
      ? raw
      : raw.replace(/\{(\w+)\}/g, (m, name: string) => {
          const v = params[name];
          return v === undefined ? m : String(v);
        });
  };

export const textOf = (t: Translator, text: Text): string => t.translate(text);
