import type { EnSection } from "../../types";

/** Generic `UiError` copy (banners, toasts, error pages). */
export const errors = {
  "error.network": "Cannot reach Kvitbit. Check your connection and try again.",
  "error.offline": "You are offline.",
  "error.timeout": "The server took too long to answer. Please try again.",
  "error.cancelled": "The request was cancelled.",
  "error.unknown": "Something went wrong on our side. Please try again.",
  "error.unknownWithId": "Something went wrong on our side. Request ID: {requestId}",
  "error.invalid": "Some fields need your attention.",
  "error.notFound": "This item does not exist or was removed.",
  "error.forbidden": "Your role does not allow this action.",
  "error.unauthorized.missing": "Please sign in to continue.",
  "error.unauthorized.invalid": "Your session is no longer valid. Please sign in again.",
  "error.unauthorized.expired": "Your session has expired. Please sign in again.",
  "error.unauthorized.credential_not_allowed": "This credential cannot be used for this action.",
  "error.unauthorized.reauthentication_required": "For your security, please sign in again.",
  "error.invalidBotProof": "The human check expired. Please try again.",
  "error.originRejected": "The request came from an untrusted page and was blocked.",
  "error.preconditionFailed": "Someone else changed this in the meantime.",
  "error.preconditionRequired": "The app is out of date. Reload the page and try again.",
  "error.payloadTooLarge": "The upload is too large. The limit is {megabytes} MB.",
  "error.rateLimited": "Too many attempts. Try again in {seconds} s.",
  "error.conflict.revision_changed":
    "Someone else changed this in the meantime. Reload to see the latest version.",
  "error.conflict.document_locked": "This document is locked against edits.",
  "error.conflict.illegal_transition": "This action is not possible in the current state.",
  "error.conflict.duplicate": "This already exists.",
  "error.conflict.idempotency_mismatch":
    "This request was already sent with different data. Reload and try again.",
  "error.unavailable.company_registry":
    "The ARES company registry is not responding. You can fill in the details manually.",
  "error.unavailable.exchange_rates": "CNB exchange rates are not available right now.",
  "error.unavailable.blob_storage": "File storage is not available right now. Try again later.",
  "error.unavailable.database": "Kvitbit is temporarily unavailable. Try again in a moment.",
  "error.unavailable.retryIn": "Try again in {seconds} s.",
  "error.staleRevision.title": "This page is out of date",
  "error.staleRevision.body":
    "Someone else saved changes. Reload to continue from the latest version, then reapply your edits.",
} as const satisfies EnSection;
