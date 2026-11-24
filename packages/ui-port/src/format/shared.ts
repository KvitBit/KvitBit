import type { AnyIssueCode } from "../i18n/issues";

/** A failed validation: an issue code that has `issue.<code>` copy, with optional params. */
export interface FormatIssue {
  readonly code: AnyIssueCode;
  readonly params?: Readonly<Record<string, string>>;
}

export const issue = (
  code: AnyIssueCode,
  params?: Readonly<Record<string, string>>,
): FormatIssue => (params === undefined ? { code } : { code, params });

/** Removes spaces (incl. NBSP and thin spaces), dots, dashes and slashes users paste. */
export const compact = (input: string): string => input.replace(/[\s  .\-/]/g, "");
