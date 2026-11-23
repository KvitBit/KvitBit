/**
 * Pure engines (`@kvitbit/core/engines`, core-ports section 5): VatMath, Fx, Numbering,
 * StatutoryText, Schedules (+ reminder date math) and Prague calendar helpers. No services, no
 * I/O; browser safe. PaymentQr is not implemented in this package yet.
 */
export * from "./calendar";
export type { FxRate } from "./fx";
export { Fx } from "./fx";
export type { NumberPattern, PatternError, PatternToken } from "./numbering";
export { MAX_NUMBER_LENGTH, Numbering } from "./numbering";
export type { ReminderStep, ScheduleRule } from "./schedules";
export { MAX_EVERY, Reminders, Schedules } from "./schedules";
export type { StatutoryCodeValue, StatutoryNote } from "./statutory";
export { STATUTORY_CODES, StatutoryText } from "./statutory";
export type { VatBreakdown, VatBucket, VatInput, VatInputLine } from "./vat";
export { TREATMENTS, VAT_RATE_TABLE, VatMath } from "./vat";
