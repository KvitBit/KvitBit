import {
  describeError,
  type FieldIssue,
  type IssuePath,
  issuesAt,
  type UiError,
} from "@kvitbit/ui-port/api";
import type { I18n } from "../../i18n/i18n-provider";
import {
  isRequestIntentExpired,
  requestIntentReconciliationCopy,
} from "../../runtime/request-intent";

export interface FormErrorState {
  readonly banner: string | null;
  readonly staleRevision: boolean;
  readonly issues: ReadonlyArray<FieldIssue>;
}

export const noFormError: FormErrorState = {
  banner: null,
  staleRevision: false,
  issues: [],
};

export const formErrorFrom = (error: UiError, i18n: I18n): FormErrorState => {
  if (isRequestIntentExpired(error)) {
    return { ...noFormError, banner: i18n.local(requestIntentReconciliationCopy) };
  }
  const view = describeError(error);
  return {
    banner: view.surface === "silent" ? null : i18n.text(view.text),
    staleRevision: view.staleRevision,
    issues: view.issues,
  };
};

export const fieldErrorText = (
  state: FormErrorState,
  path: IssuePath,
  i18n: I18n,
): string | null => {
  const matched = issuesAt(state.issues, path)[0];
  return matched === undefined ? null : i18n.text(matched.text);
};
