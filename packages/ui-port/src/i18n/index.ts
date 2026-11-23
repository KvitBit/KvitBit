/**
 * @kvitbit/ui-port/i18n: cs/en catalogs, the closed `MessageKey` union and the translator.
 * Presenters emit `Text` (see ../text.ts); adapters resolve it with `translate`.
 */
export {
  catalogs,
  cs,
  type EnCatalog,
  en,
  enSections,
  isMessageKey,
  MESSAGE_KEYS,
  type MessageKey,
} from "./catalog";
export {
  type AnyIssueCode,
  type IssueKey,
  issueKey,
  issueText,
  UI_ISSUE_CODES,
  type UiIssueCode,
} from "./issues";
export {
  type BadgeKind,
  type EnumKey,
  type EnumLabels,
  type EnumName,
  enumKey,
  enumText,
} from "./labels";
export {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  INTL_TAG,
  isLocale,
  LOCALES,
  type Locale,
  negotiateLocale,
  parseAcceptLanguage,
} from "./locale";
export {
  interpolate,
  type MessageParams,
  message,
  type ParamsArg,
  pluralCategory,
  type Translator,
  t,
  translate,
  translator,
} from "./translate";
export type {
  AnyMessage,
  CsMessage,
  CsPlural,
  CsSection,
  EnMessage,
  EnPlural,
  EnSection,
  Placeholders,
} from "./types";
