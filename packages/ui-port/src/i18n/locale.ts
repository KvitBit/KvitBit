import { Locale as DomainLocale } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const LANGUAGE_SUBTAG_SEPARATOR = /[-_]/;

/** UI language. Same literals as the domain `Locale` (documents and emails use it too). */
export type Locale = DomainLocale;

export const LOCALES: ReadonlyArray<Locale> = ["cs", "en"];

/** The product's home language: used when nothing about the user is known. */
export const DEFAULT_LOCALE: Locale = "cs";

/** The catalog every other locale falls back to; `en` is the source of truth for keys. */
export const FALLBACK_LOCALE: Locale = "en";

/** BCP 47 tag each locale formats with (en-GB: day-first dates, as on Czech invoices). */
export const INTL_TAG: Readonly<Record<Locale, string>> = { cs: "cs-CZ", en: "en-GB" };

export const isLocale = Schema.is(DomainLocale);

const fromTag = (tag: string): Locale | undefined => {
  const language = Str.split(Str.toLowerCase(Str.trim(tag)), LANGUAGE_SUBTAG_SEPARATOR)[0];
  if (language === "cs" || language === "sk") return "cs"; // Slovak readers get Czech copy
  if (language === "en") return "en";
  return undefined;
};

/**
 * Picks a UI locale from preference tags in priority order (navigator.languages, a stored
 * preference, `Accept-Language` entries). Unknown languages are skipped; when none match,
 * `fallback` (default `DEFAULT_LOCALE`) is returned.
 */
export const negotiateLocale: {
  (fallback?: Locale): (candidates: ReadonlyArray<string | null | undefined>) => Locale;
  (candidates: ReadonlyArray<string | null | undefined>, fallback?: Locale): Locale;
} = Fn.dual(
  (args) => Arr.isArray(args[0]),
  (
    candidates: ReadonlyArray<string | null | undefined>,
    fallback: Locale = DEFAULT_LOCALE,
  ): Locale => {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      const locale = fromTag(candidate);
      if (locale !== undefined) return locale;
    }
    return fallback;
  },
);

/** Parses an `Accept-Language` header into tags ordered by quality (q=0 entries dropped). */
export const parseAcceptLanguage = (header: string | null | undefined): ReadonlyArray<string> => {
  if (header === null || header === undefined) return [];
  return Arr.map(
    Arr.filter(
      Arr.map(Str.split(header, ","), (entry, order) => {
        const [tag = "", ...params] = Str.split(Str.trim(entry), ";");
        const q = Option.getOrUndefined(
          Arr.findFirst(Arr.map(params, Str.trim), Str.startsWith("q=")),
        );
        const quality = q === undefined ? 1 : Number.parseFloat(Fn.pipe(q, Str.slice(2)));
        return { tag: Str.trim(tag), quality, order };
      }),
      (e) => e.tag !== "" && e.tag !== "*" && Number.isFinite(e.quality) && e.quality > 0,
    ).sort((a, b) => b.quality - a.quality || a.order - b.order),
    (e) => e.tag,
  );
};
