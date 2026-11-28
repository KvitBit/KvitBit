import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
/**
 * Text resolution for views. Catalog keys come from @kvitbit/ui-port/i18n; web-only copy that the
 * shared catalog does not carry lives next to the page that uses it as a `Copy` table.
 */

import { I18n, type Text } from "@kvitbit/ui-port";
import * as Str from "effect/String";
import type { Locale } from "./prefs";

export type Translator = I18n.Translator;
export const translator = (locale: Locale): Translator => I18n.translator(locale);

/** A bilingual copy table: same keys in both locales, checked by the type. */
export type Copy<K extends string> = Readonly<Record<Locale, Readonly<Record<K, string>>>>;

const copyToken = /(\{\w+\})/;

export const copy =
  <K extends string>(table: Copy<K>) =>
  (locale: Locale, key: K, params?: Readonly<Record<string, string | number>>): string => {
    const raw = table[locale][key];
    if (params === undefined) return raw;
    const tokens = Str.split(raw, copyToken);
    return Arr.join(
      Arr.map(tokens, (token, index) => {
        if (index % 2 === 0) return token;
        const value = params[Str.slice(1, -1)(token)];
        return value === undefined ? token : String(value);
      }),
      "",
    );
  };

const textOfImpl = (t: Translator, text: Text): string => t.translate(text);

export const textOf: {
  (text: Text): (t: Translator) => string;
  (t: Translator, text: Text): string;
} = Fn.dual(2, textOfImpl);
