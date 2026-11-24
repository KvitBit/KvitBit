import type { EnSection } from "../../types";

/** `issue.<code>`: every domain IssueCode plus the UI-only `form.*` and `auth.*` codes. */
export const issues = {
  // domain IssueCode (@kvitbit/domain action.ts)
  "issue.ico.checksum": "This IČO is not valid. Check the digits.",
  "issue.vat.not_allowed_for_regime": "This VAT treatment is not available for your tax regime.",
  "issue.document.buyer_vat_id_required":
    "The customer's VAT ID is required for this VAT treatment.",
  "issue.document.lines_required": "Add at least one line item.",
  "issue.document.due_before_issue": "The due date cannot be before the issue date.",
  "issue.credit_note.exceeds_original": "The credit note cannot exceed the original document.",
  "issue.final_invoice.proforma_unpaid": "The proforma invoice has not been paid yet.",
  "issue.payment.currency_mismatch": "The payment currency must match the document currency.",
  "issue.payment.has_tax_document":
    "A payment tax document was issued for this payment. Cancel it with a credit note first.",
  "issue.numbering.pattern_invalid":
    "The number pattern is not valid. It needs a counter such as NNNN, for example YYYY-NNNN.",
  "issue.qr.field_too_long": "A payment detail is too long for the QR code.",
  "issue.fx.rate_missing": "No exchange rate is available for this date.",
  "issue.fx.manual_rate_invalid": "Enter a positive exchange rate and quantity.",
  "issue.fx.manual_not_allowed_for_czk": "A manual exchange rate cannot be set for CZK.",
  "issue.attachment.too_large": "The file is too large.",
  "issue.attachment.type_rejected": "This file type is not supported.",
  "issue.schedule.cadence_invalid": "The repeat interval is not valid.",
  "issue.schedule.missed_occurrences":
    "The schedule was paused because several occurrences were missed.",
  "issue.workspace.slug_invalid": "Use lowercase letters, digits and hyphens only.",
  "issue.workspace.slug_taken": "This address is already taken.",
  "issue.member.owner_cannot_leave": "The owner cannot leave. Transfer ownership first.",
  "issue.invitation.not_pending": "This invitation is no longer pending.",
  "issue.bank_account.in_use": "This bank account is used by documents or as a default.",
  "issue.bank_account.replacement_invalid":
    "Choose another account in the same currency as the replacement.",
  "issue.branding.image_too_large": "The image is too large. The limit is 2 MB.",
  "issue.branding.image_type_rejected": "Use a PNG or JPEG image.",
  "issue.branding.accent_invalid": "Enter a colour as #RRGGBB.",
  "issue.theme.json_invalid": "This file is not a valid Material Theme Builder export.",
  "issue.theme.too_large": "The theme file is too large. The limit is 64 KB.",
  "issue.theme.seed_invalid": "Enter a seed colour as #RRGGBB.",
  "issue.theme.low_contrast": "Some colours in this theme have low contrast.",
  "issue.reminder.document_settled": "The document is already settled, so no reminder was sent.",
  "issue.expense.incomplete": "The expense is missing required details.",
  "issue.export.not_ready": "The export is still being prepared.",
  "issue.page.cursor_mismatch": "The list changed. Reload it from the start.",
  "issue.request.malformed": "The request was not understood.",
  "issue.mcp.confirmation_invalid": "The confirmation is not valid.",
  "issue.mcp.confirmation_mismatch": "The confirmation does not match the requested action.",
  "issue.mcp.confirmation_expired": "The confirmation expired. Ask again.",
  "issue.mcp.confirmation_required": "This action needs your confirmation.",

  // UI-only form codes (spec rule F1)
  "issue.form.required": "This field is required.",
  "issue.form.invalid": "Check this value.",
  "issue.form.decimal_invalid": "Enter a number, for example 1 234,50.",
  "issue.form.integer_invalid": "Enter a whole number.",
  "issue.form.email_invalid": "Enter a valid email address.",
  "issue.form.date_invalid": "Enter a valid date.",
  "issue.form.date_range_invalid": "The end date must not be before the start date.",
  "issue.form.url_invalid": "Enter a valid web address.",
  "issue.form.too_long": "Use at most {max} characters.",
  "issue.form.min_value": "The value must be at least {min}.",
  "issue.form.max_value": "The value must be at most {max}.",
  "issue.form.positive_required": "The value must be greater than zero.",
  "issue.form.ico_format": "IČO has 8 digits.",
  "issue.form.dic_invalid": "Enter a Czech VAT ID as CZ followed by 8 to 10 digits.",
  "issue.form.vat_id_invalid": "This VAT ID does not match the format used in {country}.",
  "issue.form.vat_id_country_unknown":
    "Start the VAT ID with an EU country code, for example CZ or DE.",
  "issue.form.iban_invalid": "Enter a valid IBAN.",
  "issue.form.bic_invalid": "Enter a valid BIC (8 or 11 characters).",
  "issue.form.bank_account_invalid":
    "Enter a valid Czech account number, for example 19-2000145399/0800.",
  "issue.form.hex_color_invalid": "Enter a colour as #RRGGBB.",
  "issue.form.password_mismatch": "The passwords do not match.",
  "issue.form.password_too_short": "Use at least {min} characters.",
  "issue.form.terms_required": "Please accept the terms to continue.",
  "issue.form.confirmation_mismatch": "The text does not match.",
  "issue.form.file_too_large": "The file is larger than {megabytes} MB.",
  "issue.form.file_type_rejected": "This file type is not supported.",
  "issue.form.scopes_required": "Choose at least one permission.",
  "issue.form.vat_sum_mismatch":
    "The VAT breakdown does not add up to the total. Difference: {difference}.",

  // Better Auth outcomes mapped by the auth adapter (spec 5)
  "issue.auth.invalid_credentials": "The email or password is not correct.",
  "issue.auth.email_not_verified": "Confirm your email address first. We sent you a link.",
  "issue.auth.email_taken": "An account with this email already exists. Sign in instead.",
  "issue.auth.password_weak":
    "Choose a stronger password: at least 10 characters, not easy to guess.",
  "issue.auth.password_breached":
    "This password appeared in a data breach. Choose a different one.",
  "issue.auth.password_wrong": "The current password is not correct.",
  "issue.auth.bot_proof_required": "Please complete the human check.",
  "issue.auth.link_expired": "This link has expired or was already used.",
  "issue.auth.passkey_failed":
    "The passkey could not be used. Try again or use another sign-in method.",
  "issue.auth.passkey_unsupported": "This device or browser does not support passkeys.",
  "issue.auth.last_sign_in_method": "You cannot remove your only sign-in method.",
  "issue.auth.sole_owner":
    "You are the only owner of a workspace. Transfer ownership or close it first.",
  "issue.auth.email_unchanged": "This is already your email address.",
} as const satisfies EnSection;
