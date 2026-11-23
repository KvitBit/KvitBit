import type { Text, TextParam } from "../text";
import { catalogs, type EnCatalog, isMessageKey, type MessageKey } from "./catalog";
import { FALLBACK_LOCALE, INTL_TAG, type Locale } from "./locale";
import type { AnyMessage, ParamNames, ParamsOf } from "./types";

/** Typed params of a key: `{ name: TextParam }` per placeholder, `count: number` for plurals. */
export type MessageParams<K extends MessageKey> = ParamsOf<EnCatalog[K]>;

/** Rest-args form: keys without placeholders take no params, others require them. */
export type ParamsArg<K extends MessageKey> = [ParamNames<EnCatalog[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

const rulesFor = (locale: Locale): Intl.PluralRules => {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(INTL_TAG[locale]);
    pluralRules.set(locale, rules);
  }
  return rules;
};

const numberFormatFor = (locale: Locale): Intl.NumberFormat => {
  let format = numberFormats.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(INTL_TAG[locale], { maximumFractionDigits: 20 });
    numberFormats.set(locale, format);
  }
  return format;
};

/** Plural category of `count` in `locale` (cs: one, few, many, other; en: one, other). */
export const pluralCategory = (locale: Locale, count: number): Intl.LDMLPluralRule =>
  rulesFor(locale).select(count);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * ICU-lite interpolation: replaces `{name}` with the param. Numbers are formatted for the
 * locale (`1 234` in cs); missing params leave the placeholder visible so gaps show in review.
 */
export const interpolate = (
  locale: Locale,
  template: string,
  params?: Readonly<Record<string, TextParam>>,
): string =>
  template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params?.[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? numberFormatFor(locale).format(value) : value;
  });

const selectForm = (
  locale: Locale,
  message: AnyMessage,
  params?: Readonly<Record<string, TextParam>>,
): string => {
  if (typeof message === "string") return message;
  const count = params?.count;
  const n = typeof count === "number" ? count : Number(count);
  const category = Number.isFinite(n) ? pluralCategory(locale, n) : "other";
  return message[category] ?? message.other ?? "";
};

/** Raw message for a key in a locale, falling back to `FALLBACK_LOCALE` (en). */
const lookup = (locale: Locale, key: MessageKey): { message: AnyMessage; locale: Locale } => {
  const own = catalogs[locale][key];
  if (own !== undefined) return { message: own, locale };
  return { message: catalogs[FALLBACK_LOCALE][key], locale: FALLBACK_LOCALE };
};

/**
 * Resolves a `Text` descriptor. Unknown keys (a sibling emitted a key the catalog lacks)
 * render as the key itself so the gap is visible instead of blank.
 */
export const translate = (locale: Locale, text: Text): string => {
  if (!isMessageKey(text.key)) return text.key;
  const found = lookup(locale, text.key);
  return interpolate(
    found.locale,
    selectForm(found.locale, found.message, text.params),
    text.params,
  );
};

/** Typed translation of one key. */
export const t = <K extends MessageKey>(locale: Locale, key: K, ...params: ParamsArg<K>): string =>
  translate(locale, params[0] === undefined ? { key } : { key, params: params[0] });

/** Typed `Text` constructor: presenters use it instead of `text()` to get key and param checks. */
export const message = <K extends MessageKey>(key: K, ...params: ParamsArg<K>): Text<K> =>
  params[0] === undefined ? { key } : { key, params: params[0] };

/** A translator bound to one locale (adapters create one per render or per locale change). */
export interface Translator {
  readonly locale: Locale;
  readonly translate: (text: Text) => string;
  readonly t: <K extends MessageKey>(key: K, ...params: ParamsArg<K>) => string;
}

export const translator = (locale: Locale): Translator => ({
  locale,
  translate: (text) => translate(locale, text),
  t: (key, ...params) => t(locale, key, ...params),
});
