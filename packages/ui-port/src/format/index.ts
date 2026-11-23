/**
 * @kvitbit/ui-port/format: Intl-only formatting (money, numbers, percent, dates) and Czech/EU
 * identifier helpers. Validators return `Result<value, FormatIssue>`; every `FormatIssue.code`
 * has `issue.<code>` copy in the i18n catalog.
 */
export {
  type CzechAccount,
  czechAccountToIban,
  formatCzechAccount,
  formatIban,
  ibanToCzechAccount,
  normalizeIban,
  parseCzechAccount,
  validateBic,
  validateIban,
} from "./bank";
export {
  BUSINESS_TIME_ZONE,
  type CalendarDate,
  type DateStyle,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatMonth,
  parseIsoDate,
} from "./date";
export {
  EU_VAT_FORMATS,
  isValidIco,
  normalizeIco,
  normalizeVatId,
  validateCzechDic,
  validateEuVatId,
  validateIco,
} from "./ids";
export {
  formatMoney,
  type MoneyDisplay,
  type MoneyInput,
  type MoneyOptions,
  moneyDisplay,
} from "./money";
export {
  type DecimalInput,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatVatRate,
  type NumberOptions,
  type Sign,
  signOf,
  toDecimalString,
} from "./number";
export { type FormatIssue, issue } from "./shared";
