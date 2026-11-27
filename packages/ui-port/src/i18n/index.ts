/**
 * @kvitbit/ui-port/i18n: cs/en catalogs, the closed `MessageKey` union and the translator.
 * Presenters emit `Text` (see ../text.ts); adapters resolve it with `translate`.
 */
export { cs, en, enSections, isMessageKey, MESSAGE_KEYS } from "./catalog";
export { issueKey, issueText, UI_ISSUE_CODES } from "./issues";
export { type EnumKey, type EnumLabels, type EnumName, enumKey, enumText } from "./labels";
export {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  negotiateLocale,
  parseAcceptLanguage,
} from "./locale";
export {
  fallbackPluralCategory,
  interpolate,
  message,
  pluralCategory,
  type Translator,
  t,
  translate,
  translator,
} from "./translate";
