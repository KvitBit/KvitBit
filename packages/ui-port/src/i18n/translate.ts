import * as Fn from "effect/Function";
import { formatExact, roundedDecimal } from "../format/number";
import type { Text, TextParam } from "../text";
import { catalogs, type EnCatalog, isMessageKey, type MessageKey } from "./catalog";
import { FALLBACK_LOCALE, INTL_TAG, type Locale } from "./locale";
import type { AnyMessage, ParamNames, ParamsOf } from "./types";

/** Typed params of a key: `{ name: TextParam }` per placeholder, `count: number` for plurals. */
type MessageParams<K extends MessageKey> = ParamsOf<EnCatalog[K]>;

/** Rest-args form: keys without placeholders take no params, others require them. */
export type ParamsArg<K extends MessageKey> = [ParamNames<EnCatalog[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

/** CLDR rules for the two UI locales, used where `Intl.PluralRules` is missing (older Hermes). */
const fallbackPlural = (locale: Locale, n: number): Intl.LDMLPluralRule => {
  if (!Number.isInteger(n)) return locale === "cs" ? "many" : "other";
  if (n === 1) return "one";
  if (locale === "cs" && n >= 2 && n <= 4) return "few";
  return "other";
};

const pluralRules = new Map<Locale, Intl.PluralRules | null>();

const rulesFor = (locale: Locale): Intl.PluralRules | null => {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = typeof Intl.PluralRules === "function" ? new Intl.PluralRules(INTL_TAG[locale]) : null;
    pluralRules.set(locale, rules);
  }
  return rules;
};

/** Fraction digits a number param is shown with; plurals select on the shown value. */
const PARAM_FRACTION_DIGITS = 3;

const shown = (n: number): number =>
  Number.isFinite(n) ? Number(roundedDecimal(n, 0, PARAM_FRACTION_DIGITS)) : n;

/** Plural category of `count` in `locale` (cs: one, few, many, other; en: one, other). */
export const pluralCategory: {
  (count: number): (locale: Locale) => Intl.LDMLPluralRule;
  (locale: Locale, count: number): Intl.LDMLPluralRule;
} = Fn.dual(2, (locale: Locale, count: number): Intl.LDMLPluralRule => {
  const n = Math.abs(shown(count));
  return rulesFor(locale)?.select(n) ?? fallbackPlural(locale, n);
});

/** Exported for tests: the fallback must agree with Intl where Intl exists. */
export const fallbackPluralCategory: {
  (count: number): (locale: Locale) => Intl.LDMLPluralRule;
  (locale: Locale, count: number): Intl.LDMLPluralRule;
} = Fn.dual(
  2,
  (locale: Locale, count: number): Intl.LDMLPluralRule =>
    fallbackPlural(locale, Math.abs(shown(count))),
);

/**
 * Number params: exact digits, up to 3 decimals, grouped only from five digits so years and
 * short counts stay compact (`2026`, `1234`, `12 345`), as Czech typography recommends.
 */
const formatParam = (locale: Locale, n: number): string =>
  formatExact(locale, n, {
    minimumFractionDigits: 0,
    maximumFractionDigits: PARAM_FRACTION_DIGITS,
    minGroupDigits: 2,
  });

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * ICU-lite interpolation: replaces `{name}` with the param. Numbers are formatted for the
 * locale (see `formatParam`); missing params leave the placeholder visible so gaps show in review.
 */
export const interpolate: {
  (template: string, params?: Readonly<Record<string, TextParam>>): (locale: Locale) => string;
  (locale: Locale, template: string, params?: Readonly<Record<string, TextParam>>): string;
} = Fn.dual(
  (args) => typeof args[1] === "string",
  (locale: Locale, template: string, params?: Readonly<Record<string, TextParam>>): string =>
    // Native replace supports callback replacements with capture groups.
    // @effect-diagnostics-next-line preferEffectString:off
    template.replace(PLACEHOLDER, (whole, name: string) => {
      const value = params?.[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? formatParam(locale, value) : value;
    }),
);

const selectForm = (
  locale: Locale,
  entry: AnyMessage,
  params?: Readonly<Record<string, TextParam>>,
): string => {
  if (typeof entry === "string") return entry;
  const count = params?.count;
  const n = typeof count === "number" ? count : Number(count);
  const category = Number.isFinite(n) ? pluralCategory(locale, n) : "other";
  return entry[category] ?? entry.other ?? "";
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
export const translate: {
  (text: Text): (locale: Locale) => string;
  (locale: Locale, text: Text): string;
} = Fn.dual(2, (locale: Locale, text: Text): string => {
  if (!isMessageKey(text.key)) return text.key;
  const found = lookup(locale, text.key);
  return interpolate(
    found.locale,
    selectForm(found.locale, found.message, text.params),
    text.params,
  );
});

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
