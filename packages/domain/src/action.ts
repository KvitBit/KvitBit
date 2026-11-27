/**
 * Closed unions shared by the policy table and the error vocabulary
 * (core-ports sections 2.3 and 3). The pure `can(caller, action)` policy belongs to the core
 * package and is not implemented here.
 */
import * as Schema from "effect/Schema";

/** Every permission the policy table (core-ports 2.3) names. */
export const Action = Schema.Literals([
  // Reads (any Member role, and System)
  "workspace.read",
  "member.read",
  "contact.read",
  "priceList.read",
  "document.read",
  "document.pdf",
  "document.history",
  "payment.read",
  "expense.read",
  "expense.attachment.read",
  "template.read",
  "share.read",
  "report.run",
  "report.export",
  // Writes open to member
  "contact.write",
  "priceList.write",
  "template.write",
  "schedule.write",
  "expense.write",
  "document.draft",
  "document.issue",
  "document.edit",
  "document.cancel",
  "document.correct",
  "document.finalInvoice",
  "document.send",
  "document.lock",
  "share.write",
  "payment.write",
  // owner and admin
  "document.unlock",
  "document.overrideNumber",
  "workspace.settings",
  "member.invite",
  "member.setRole",
  "invitation.read",
  "apiKey.manage",
  "grant.read.all",
  "grant.revoke.all",
  // owner only
  "member.manageAdmins",
  "workspace.transferOwnership",
  "workspace.close",
  // admin, member, accountant
  "member.leave",
  // any Member role (session only, rule R1d)
  "grant.create",
  "grant.read.own",
  "grant.revoke.own",
  // Account caller
  "workspace.create",
  "workspace.listMine",
  "workspace.enter",
  "invitation.accept",
  "registry.lookup",
  // ShareLinkVisitor caller
  "share.open",
  "share.pdf",
  "share.logo",
  // InvitationHolder caller
  "invitation.peek",
]);
export type Action = typeof Action.Type;

/** Stable i18n keys for validation issues and conflict details, grouped by prefix. */
export const IssueCode = Schema.Literals([
  "ico.checksum",
  "vat.not_allowed_for_regime",
  "document.buyer_vat_id_required",
  "document.lines_required",
  "document.due_before_issue",
  "credit_note.exceeds_original",
  "final_invoice.proforma_unpaid",
  "payment.currency_mismatch",
  "payment.has_tax_document",
  "numbering.pattern_invalid",
  "qr.field_too_long",
  "fx.rate_missing",
  "fx.manual_rate_invalid",
  "fx.manual_not_allowed_for_czk",
  "attachment.too_large",
  "attachment.type_rejected",
  "schedule.cadence_invalid",
  "schedule.missed_occurrences",
  "workspace.slug_invalid",
  "workspace.slug_taken",
  "member.owner_cannot_leave",
  "invitation.not_pending",
  "bank_account.in_use",
  "bank_account.replacement_invalid",
  "branding.image_too_large",
  "branding.image_type_rejected",
  "branding.accent_invalid",
  "theme.json_invalid",
  "theme.too_large",
  "theme.seed_invalid",
  "theme.low_contrast",
  "reminder.document_settled",
  "expense.incomplete",
  "export.not_ready",
  "page.cursor_mismatch",
  "request.malformed",
  "mcp.confirmation_invalid",
  "mcp.confirmation_mismatch",
  "mcp.confirmation_expired",
  "mcp.confirmation_required",
]);
export type IssueCode = typeof IssueCode.Type;
