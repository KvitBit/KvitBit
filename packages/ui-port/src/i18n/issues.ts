import type { ThemeWarning, UnauthorizedReason } from "@kvitbit/api-contract";
import type {
  ConflictReason,
  EntityKind,
  IssueCode,
  UnavailableDependency,
} from "@kvitbit/domain/contract";
import type { Text, TextParam } from "../text";
import type { MessageKey } from "./catalog";

/** UI-only field issue codes (spec rule F1 `form.*`) and auth adapter codes (`auth.*`). */
export const UI_ISSUE_CODES = [
  "form.required",
  "form.invalid",
  "form.decimal_invalid",
  "form.integer_invalid",
  "form.email_invalid",
  "form.date_invalid",
  "form.date_range_invalid",
  "form.url_invalid",
  "form.too_long",
  "form.min_value",
  "form.max_value",
  "form.positive_required",
  "form.ico_format",
  "form.dic_invalid",
  "form.vat_id_invalid",
  "form.vat_id_country_unknown",
  "form.iban_invalid",
  "form.bic_invalid",
  "form.bank_account_invalid",
  "form.hex_color_invalid",
  "form.password_mismatch",
  "form.password_too_short",
  "form.terms_required",
  "form.confirmation_mismatch",
  "form.file_too_large",
  "form.file_type_rejected",
  "form.scopes_required",
  "form.vat_sum_mismatch",
  "auth.invalid_credentials",
  "auth.email_not_verified",
  "auth.email_taken",
  "auth.password_weak",
  "auth.password_breached",
  "auth.password_wrong",
  "auth.bot_proof_required",
  "auth.link_expired",
  "auth.passkey_failed",
  "auth.passkey_unsupported",
  "auth.last_sign_in_method",
  "auth.sole_owner",
  "auth.email_unchanged",
] as const;
type UiIssueCode = (typeof UI_ISSUE_CODES)[number];

/** Every code a field issue can carry: core's closed `IssueCode` plus the UI-only codes. */
export type AnyIssueCode = IssueCode | UiIssueCode;

export type IssueKey<C extends AnyIssueCode = AnyIssueCode> = `issue.${C}`;

// Compile-time seam: a new core IssueCode without catalog copy fails type checking here.
type Covered<K extends string> = [Exclude<K, MessageKey>] extends [never]
  ? true
  : Exclude<K, MessageKey>;
const issueKeysCovered: Covered<IssueKey> = true;
const errorKeysCovered: Covered<
  | `error.conflict.${ConflictReason}`
  | `error.unavailable.${UnavailableDependency}`
  | `enum.entity.${EntityKind}`
  | `error.unauthorized.${UnauthorizedReason}`
  | `issue.${ThemeWarning}`
> = true;
// biome-ignore lint/complexity/noVoid: Keep the compile-time issue coverage check.
void issueKeysCovered;
// biome-ignore lint/complexity/noVoid: Keep the compile-time error coverage check.
void errorKeysCovered;

export const issueKey = <C extends AnyIssueCode>(code: C): IssueKey<C> => `issue.${code}`;

/** `Text` for an issue; server params (string record) pass through unchanged. */
export const issueText = (issue: {
  readonly code: AnyIssueCode;
  readonly params?: Readonly<Record<string, TextParam>> | undefined;
}): Text<MessageKey> =>
  issue.params === undefined
    ? { key: issueKey(issue.code) }
    : { key: issueKey(issue.code), params: issue.params };
