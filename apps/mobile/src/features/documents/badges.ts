/**
 * Status/settlement badge mapping and role-aware lifecycle action gating for Documents.
 */
import type {
  DeliveryStatus,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  DocumentView,
  Role,
} from "@kvitbit/domain/contract";
import { enumKey, type Translator } from "@kvitbit/ui-port/i18n";
import type { BadgeTone } from "../../ui";

export interface BadgeDescriptor {
  readonly label: string;
  readonly tone: BadgeTone;
}

export const documentStatusBadge = (
  status: DocumentStatus,
  t: Translator["t"],
): BadgeDescriptor => {
  switch (status) {
    case "draft":
      return { label: t(enumKey("documentStatus", "draft")), tone: "draft" };
    case "issued":
      return { label: t(enumKey("documentStatus", "issued")), tone: "info" };
    case "cancelled":
      return { label: t(enumKey("documentStatus", "cancelled")), tone: "danger" };
  }
};

export const settlementBadge = (
  settlement: DocumentSettlement,
  overdue: boolean,
  t: Translator["t"],
): BadgeDescriptor => {
  if (overdue && (settlement === "unpaid" || settlement === "partially_paid")) {
    return { label: t("enum.badge.overdue"), tone: "warning" };
  }
  switch (settlement) {
    case "paid":
      return { label: t(enumKey("settlement", "paid")), tone: "success" };
    case "partially_paid":
      return { label: t(enumKey("settlement", "partially_paid")), tone: "info" };
    case "overpaid":
      return { label: t(enumKey("settlement", "overpaid")), tone: "warning" };
    case "credited":
      return { label: t(enumKey("settlement", "credited")), tone: "neutral" };
    case "unpaid":
      return { label: t(enumKey("settlement", "unpaid")), tone: "neutral" };
  }
};

export const kindBadge = (kind: DocumentKind, t: Translator["t"]): BadgeDescriptor => ({
  label: t(enumKey("documentKind", kind)),
  tone: kind === "proforma" ? "proforma" : "neutral",
});

export const deliveryStatusTone = (status: DeliveryStatus): BadgeTone => {
  switch (status) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    case "queued":
    case "sending":
      return "info";
    case "skipped":
      return "neutral";
  }
};

export interface DocumentActionFlags {
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
  readonly canEdit: boolean;
  readonly canIssue: boolean;
  readonly canDiscard: boolean;
  readonly canLock: boolean;
  readonly canUnlock: boolean;
  readonly canCancel: boolean;
  readonly canRecordPayment: boolean;
  readonly canRemovePayment: boolean;
  readonly canIssueFinalInvoice: boolean;
  readonly canCreateCreditNote: boolean;
  readonly canSendEmail: boolean;
  readonly canManageShareLink: boolean;
  readonly canDuplicate: boolean;
  readonly canDownloadPdf: boolean;
}

/**
 * Computes which lifecycle actions are valid for a document and caller role
 * (docs/design/user-flows.md section 4 & core-ports 2.3).
 */
export const documentActions = (doc: DocumentView, role: Role): DocumentActionFlags => {
  const canWrite = role !== "accountant";
  const canAdmin = role === "owner" || role === "admin";
  const isDraft = doc.status === "draft";
  const isIssued = doc.status === "issued";
  const isProforma = doc.kind === "proforma";
  const isPtd = doc.kind === "payment_tax_document";
  const isCreditNote = doc.kind === "credit_note";
  const hasFinalInvoice = doc.related.some(
    (rel) => rel.relation === "advance_of" || rel.relation === "final_invoice_for",
  );
  const proformaHasPayment =
    doc.settlement === "paid" ||
    doc.settlement === "partially_paid" ||
    doc.settlement === "overpaid";

  return {
    canWrite,
    canAdmin,
    canEdit: canWrite && !doc.locked && (isDraft || isIssued),
    canIssue: canWrite && isDraft,
    canDiscard: canWrite && isDraft,
    canLock: canWrite && isIssued && !doc.locked,
    canUnlock: canAdmin && isIssued && doc.locked,
    canCancel: canWrite && isIssued,
    canRecordPayment: canWrite && isIssued && !isPtd,
    canRemovePayment: canWrite && isIssued,
    canIssueFinalInvoice:
      canWrite && isIssued && isProforma && proformaHasPayment && !hasFinalInvoice,
    canCreateCreditNote: canWrite && isIssued && !isProforma && !isCreditNote,
    canSendEmail: canWrite && isIssued,
    canManageShareLink: canWrite && isIssued,
    canDuplicate: canWrite && (doc.kind === "invoice" || doc.kind === "proforma"),
    canDownloadPdf: true,
  };
};
