import type { Locale as DomainLocale } from "@kvitbit/domain/contract";

/** UI language. Same literals as the domain `Locale` (documents and emails use it too). */
export type Locale = DomainLocale;

export const LOCALES: ReadonlyArray<Locale> = ["cs", "en"];

/** The product's home language: used when nothing about the user is known. */
export const DEFAULT_LOCALE: Locale = "cs";

/** The catalog every other locale falls back to; `en` is the source of truth for keys. */
export const FALLBACK_LOCALE: Locale = "en";

/** BCP 47 tag each locale formats with (en-GB: day-first dates, as on Czech invoices). */
export const INTL_TAG: Readonly<Record<Locale, string>> = { cs: "cs-CZ", en: "en-GB" };

export const isLocale = (value: unknown): value is Locale => value === "cs" || value === "en";

const fromTag = (tag: string): Locale | undefined => {
  const language = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (language === "cs" || language === "sk") return "cs"; // Slovak readers get Czech copy
  if (language === "en") return "en";
  return undefined;
};

/**
 * Picks a UI locale from preference tags in priority order (navigator.languages, a stored
 * preference, `Accept-Language` entries). Unknown languages are skipped; when none match,
 * `fallback` (default `DEFAULT_LOCALE`) is returned.
 */
export const negotiateLocale = (
  candidates: ReadonlyArray<string | null | undefined>,
  fallback: Locale = DEFAULT_LOCALE,
): Locale => {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const locale = fromTag(candidate);
    if (locale !== undefined) return locale;
  }
  return fallback;
};

/** Parses an `Accept-Language` header into tags ordered by quality (q=0 entries dropped). */
export const parseAcceptLanguage = (header: string | null | undefined): ReadonlyArray<string> => {
  if (header === null || header === undefined) return [];
  return header
    .split(",")
    .map((entry, order) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q === undefined ? 1 : Number.parseFloat(q.slice(2));
      return { tag: tag.trim(), quality, order };
    })
    .filter((e) => e.tag !== "" && e.tag !== "*" && Number.isFinite(e.quality) && e.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.order - b.order)
    .map((e) => e.tag);
};
