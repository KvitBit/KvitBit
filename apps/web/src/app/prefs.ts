/**
 * Viewer preferences that shape every screen: UI language, style profile, colour mode, contrast and
 * the Material 3 theme source (preset or custom seed). Persisted in localStorage and mirrored in a
 * cookie so a server render can pick the same values (DESIGN.md "Selectable Styles").
 */
import {
  DEFAULT_THEME_PRESET,
  Hex,
  ThemeContrast,
  ThemeMode,
  ThemePresetId,
  ThemeStyle,
} from "@kvitbit/domain";
import { I18n } from "@kvitbit/ui-port";
import { Effect, Option, Schema } from "effect";

export const Locale = Schema.Literals(I18n.LOCALES);
export type Locale = typeof Locale.Type;

export const ThemeChoice = Schema.Union([
  Schema.TaggedStruct("Preset", { id: ThemePresetId }),
  Schema.TaggedStruct("Seed", { hex: Hex }),
]);
export type ThemeChoice = typeof ThemeChoice.Type;

export const Prefs = Schema.Struct({
  locale: Locale,
  style: ThemeStyle,
  mode: ThemeMode,
  contrast: ThemeContrast,
  theme: ThemeChoice,
});
export type Prefs = typeof Prefs.Type;

export const defaultPrefs = (locale: Locale = I18n.DEFAULT_LOCALE): Prefs => ({
  locale,
  style: "elegant",
  mode: "system",
  contrast: "standard",
  theme: { _tag: "Preset", id: DEFAULT_THEME_PRESET },
});

export const PREFS_STORAGE_KEY = "kvitbit.prefs";
export const PREFS_COOKIE = "kb_prefs";

const PrefsJson = Schema.fromJsonString(Prefs);
const decodePrefs = Schema.decodeUnknownOption(PrefsJson);
const encodePrefs = Schema.encodeSync(PrefsJson);

/** Decodes a stored or cookie value; anything malformed falls back to None. */
export const parsePrefs = (raw: string | null | undefined): Option.Option<Prefs> =>
  raw === null || raw === undefined || raw === "" ? Option.none() : decodePrefs(raw);

export const serializePrefs = (prefs: Prefs): string => encodePrefs(prefs);

/** Reads a cookie value from a `Cookie` header (server render) or `document.cookie`. */
export const readCookie = (header: string, name: string): string | undefined => {
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
};

/** Browser-only: persists prefs to localStorage and the cookie. Never fails. */
export const persistPrefs = (prefs: Prefs): Effect.Effect<void> =>
  Effect.sync(() => {
    const json = serializePrefs(prefs);
    try {
      globalThis.localStorage?.setItem(PREFS_STORAGE_KEY, json);
    } catch {
      // storage may be blocked (private mode); the cookie still carries the value
    }
    if (typeof document !== "undefined") {
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not available in every supported browser
      document.cookie = `${PREFS_COOKIE}=${encodeURIComponent(json)}; path=/; max-age=31536000; samesite=lax`;
    }
  });

/** Browser-only: stored prefs, else the browser language, else Czech. */
export const loadBrowserPrefs = (): Prefs => {
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(PREFS_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const fromCookie =
    typeof document === "undefined" ? undefined : readCookie(document.cookie, PREFS_COOKIE);
  return parsePrefs(stored).pipe(
    Option.orElse(() => parsePrefs(fromCookie)),
    Option.getOrElse(() =>
      defaultPrefs(
        typeof navigator === "undefined"
          ? I18n.DEFAULT_LOCALE
          : I18n.negotiateLocale(navigator.languages ?? [navigator.language]),
      ),
    ),
  );
};
