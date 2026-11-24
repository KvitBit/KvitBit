import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Literal tuples copied from the spec unions, in spec order. Each tuple backs one Postgres enum.
 * `@kvitbit/domain` will own the canonical unions; a cross-package equality test pins them together.
 * Citations are `docs/design/<file>:<line>`.
 */

/** core-ports.md:75 `Role`. */
export const roleValues = ["owner", "admin", "member", "accountant"] as const;
/** core-ports.md:536,544 invitation role (`Role` without "owner"). */
export const invitationRoleValues = ["admin", "member", "accountant"] as const;
/** core-ports.md:537,546 invitation status. */
export const invitationStatusValues = ["pending", "expired", "revoked", "accepted"] as const;
/** core-ports.md:76 `TaxRegime`. */
export const taxRegimeValues = ["non_vat_payer", "vat_payer", "identified_person"] as const;
/** core-ports.md:77 `Locale`. */
export const localeValues = ["cs", "en"] as const;
/** core-ports.md:78 `DocumentKind`. */
export const documentKindValues = [
  "invoice",
  "proforma",
  "payment_tax_document",
  "credit_note",
] as const;
/** core-ports.md:652 `DocumentInput.kind`; also Schedule `issueAs` (core-ports.md:943). */
export const draftableKindValues = ["invoice", "proforma"] as const;
/** core-ports.md:684-685 document status. */
export const documentStatusValues = ["draft", "issued", "cancelled"] as const;
/** core-ports.md:80 `PaymentMethod`. */
export const paymentMethodValues = ["bank_transfer", "cash", "card", "other"] as const;
/** core-ports.md:91-98 `VatTreatment`. */
export const vatTreatmentValues = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
] as const;
/** core-ports.md:700 document relation. */
export const documentRelationValues = [
  "corrects",
  "corrected_by",
  "advance_of",
  "tax_document_for",
  "final_invoice_for",
  "deducts",
] as const;
/** core-ports.md:697 FX source. */
export const fxSourceValues = ["cnb", "manual"] as const;
/** core-ports.md:702 delivery purpose. */
export const deliveryPurposeValues = ["document", "reminder"] as const;
/** core-ports.md:702,763 delivery status. */
export const deliveryStatusValues = ["queued", "sending", "sent", "failed", "skipped"] as const;
/** core-ports.md:779 `PdfTemplate`. */
export const pdfTemplateValues = ["classic", "modern_minimal"] as const;
/** core-ports.md:1085 payment rounding. */
export const paymentRoundingValues = ["none", "whole_unit"] as const;
/** core-ports.md:591,597 Contact role. */
export const contactRoleValues = ["customer", "supplier"] as const;
/** core-ports.md:607-610 `ReminderPolicy.mode`. */
export const reminderPolicyModeValues = ["inherit", "disabled", "custom"] as const;
/** core-ports.md:824-826 `documents.reminders_choice`. */
export const remindersChoiceValues = ["on", "off", "inherit"] as const;
/** core-ports.md:888-890 share event kind. */
export const shareEventKindValues = ["view", "download"] as const;
/** core-ports.md:888-890 share event device. */
export const shareDeviceValues = ["desktop", "mobile", "tablet", "unknown"] as const;
/** core-ports.md:919-923 expense status. */
export const expenseStatusValues = ["complete", "incomplete"] as const;
/** core-ports.md:939-943,1190-1194 `ScheduleRule.every` keys (structural union in the spec). */
export const cadenceUnitValues = ["weeks", "months", "years"] as const;
/** core-ports.md:963-966 recurring run outcome. */
export const recurringOutcomeValues = ["issued", "failed", "skipped_missed"] as const;
/** The send half of an issued run, `RunSend` in packages/core/src/modules/recurring/repo.ts. */
export const recurringSendStateValues = ["none", "pending", "queued", "failed"] as const;
/** core-ports.md:1014-1018 export status. */
export const exportStatusValues = ["running", "ready", "failed"] as const;
/** core-ports.md:165 `Channel`. */
export const channelValues = ["web", "mobile", "api", "mcp"] as const;
/** core-ports.md:126 `ClientRef.kind`. */
export const clientKindValues = ["api_key", "mcp"] as const;
/** core-ports.md:222-226 System caller job tags. */
export const systemJobValues = [
  "RecurringIssuance",
  "PaymentReminders",
  "DocumentDelivery",
  "DataExport",
] as const;
/** core-ports.md:313-316 `EntityKind`. */
export const entityKindValues = [
  "Workspace",
  "Member",
  "Invitation",
  "Contact",
  "PriceListItem",
  "Document",
  "Payment",
  "Expense",
  "Attachment",
  "Template",
  "Schedule",
  "NumberingSeries",
  "BankAccount",
  "ShareLink",
  "BrandingImage",
  "Export",
  "ApiKey",
  "McpGrant",
] as const;
/** core-ports.md:168-170 `ScopeArea`. Stored scopes are `${ScopeArea}:${"read" | "write"}` text. */
export const scopeAreaValues = [
  "workspace",
  "members",
  "contacts",
  "catalog",
  "documents",
  "payments",
  "expenses",
  "templates",
  "reports",
  "share",
] as const;
/** http-mcp-contracts.md:98 `AccessMode`. */
export const accessModeValues = ["read", "read_write", "custom"] as const;
/** core-ports.md:1266 `BotScope`. */
export const botScopeValues = [
  "sign_up",
  "sign_in",
  "magic_link",
  "password_reset",
  "invitation_accept",
] as const;
/** core-ports.md:144, http-mcp-contracts.md:640 `ThemePresetId`. */
export const themePresetIdValues = [
  "graphite_atelier",
  "forest",
  "ocean",
  "plum",
  "sand",
  "graphite",
] as const;
/** http-mcp-contracts.md:643 `ThemeMode`. */
export const themeModeValues = ["system", "light", "dark"] as const;
/** http-mcp-contracts.md:645 `ThemeStyle`; default "elegant" (core-ports.md:151). */
export const themeStyleValues = ["elegant", "cozy"] as const;
/** http-mcp-contracts.md:642 `ThemeContrast`. */
export const themeContrastValues = ["standard", "medium", "high"] as const;

export const role = pgEnum("role", roleValues);
export const invitationRole = pgEnum("invitation_role", invitationRoleValues);
export const invitationStatus = pgEnum("invitation_status", invitationStatusValues);
export const taxRegime = pgEnum("tax_regime", taxRegimeValues);
export const locale = pgEnum("locale", localeValues);
export const documentKind = pgEnum("document_kind", documentKindValues);
export const draftableKind = pgEnum("draftable_kind", draftableKindValues);
export const documentStatus = pgEnum("document_status", documentStatusValues);
export const paymentMethod = pgEnum("payment_method", paymentMethodValues);
export const vatTreatment = pgEnum("vat_treatment", vatTreatmentValues);
export const documentRelation = pgEnum("document_relation", documentRelationValues);
export const fxSource = pgEnum("fx_source", fxSourceValues);
export const deliveryPurpose = pgEnum("delivery_purpose", deliveryPurposeValues);
export const deliveryStatus = pgEnum("delivery_status", deliveryStatusValues);
export const pdfTemplate = pgEnum("pdf_template", pdfTemplateValues);
export const paymentRounding = pgEnum("payment_rounding", paymentRoundingValues);
export const contactRole = pgEnum("contact_role", contactRoleValues);
export const reminderPolicyMode = pgEnum("reminder_policy_mode", reminderPolicyModeValues);
export const remindersChoice = pgEnum("reminders_choice", remindersChoiceValues);
export const shareEventKind = pgEnum("share_event_kind", shareEventKindValues);
export const shareDevice = pgEnum("share_device", shareDeviceValues);
export const expenseStatus = pgEnum("expense_status", expenseStatusValues);
export const cadenceUnit = pgEnum("cadence_unit", cadenceUnitValues);
export const recurringOutcome = pgEnum("recurring_outcome", recurringOutcomeValues);
export const recurringSendState = pgEnum("recurring_send_state", recurringSendStateValues);
export const exportStatus = pgEnum("export_status", exportStatusValues);
export const channel = pgEnum("channel", channelValues);
export const clientKind = pgEnum("client_kind", clientKindValues);
export const systemJob = pgEnum("system_job", systemJobValues);
export const entityKind = pgEnum("entity_kind", entityKindValues);
export const accessMode = pgEnum("access_mode", accessModeValues);
export const botScope = pgEnum("bot_scope", botScopeValues);
export const themeMode = pgEnum("theme_mode", themeModeValues);
export const themeStyle = pgEnum("theme_style", themeStyleValues);
export const themeContrast = pgEnum("theme_contrast", themeContrastValues);
