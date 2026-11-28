import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { AnyIssueCode } from "../i18n/issues";

/** A failed validation: an issue code that has `issue.<code>` copy, with optional params. */
export interface FormatIssue {
  readonly code: AnyIssueCode;
  readonly params?: Readonly<Record<string, string>>;
}

export const issue: {
  (params?: Readonly<Record<string, string>>): (code: AnyIssueCode) => FormatIssue;
  (code: AnyIssueCode, params?: Readonly<Record<string, string>>): FormatIssue;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (code: AnyIssueCode, params?: Readonly<Record<string, string>>): FormatIssue =>
    params === undefined ? { code } : { code, params },
);

/** Removes spaces (incl. NBSP and thin spaces), dots, dashes and slashes users paste. */
export const compact = (input: string): string => Fn.pipe(input, Str.replace(/[\s  .\-/]/g, ""));
