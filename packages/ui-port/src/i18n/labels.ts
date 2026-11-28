import type { AccessMode } from "@kvitbit/api-contract";
import type {
  DeliveryPurpose,
  DeliveryStatus,
  DocumentKind,
  DocumentRelation,
  DocumentSettlement,
  DocumentStatus,
  EntityKind,
  ExpenseStatus,
  ExportJobView,
  InvitationStatus as InvitationStatusSchema,
  Locale,
  PaymentMethod,
  PdfTemplate,
  RecurringRunView,
  ReportKind,
  ReportQuery,
  Role,
  ScopeArea,
  ScopeLevel,
  ShareViewEvent,
  TaxRegime,
  ThemeContrast,
  ThemeMode,
  ThemePresetId,
  ThemeStyle,
  VatTreatment,
} from "@kvitbit/domain/contract";
import type { Text } from "../text";
import type { MessageKey } from "./catalog";

type InvitationStatus = typeof InvitationStatusSchema.Type;

/** Badge kinds of the spec's `BadgeVM` (section 2.12). */
export type BadgeKind =
  | "draft"
  | "issued"
  | "sent"
  | "viewed"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "credited"
  | "cancelled"
  | "locked"
  | "proforma"
  | "incomplete"
  | "queued"
  | "failed";

/** Each labelled union and its values; `enum.<name>.<value>` exists for every pair. */
export interface EnumLabels {
  readonly documentKind: DocumentKind;
  readonly documentKindPlural: DocumentKind;
  readonly documentStatus: DocumentStatus;
  readonly settlement: DocumentSettlement;
  readonly documentRelation: DocumentRelation;
  readonly paymentMethod: PaymentMethod;
  readonly vatTreatment: VatTreatment;
  readonly taxRegime: TaxRegime;
  readonly taxRegimeHint: TaxRegime;
  readonly role: Role;
  readonly roleHint: Role;
  readonly invitationStatus: InvitationStatus;
  readonly scopeArea: ScopeArea;
  readonly scopeLevel: ScopeLevel | "none";
  readonly accessLevel: "none" | "read" | "write";
  readonly accessMode: AccessMode;
  readonly themePreset: ThemePresetId;
  readonly themeStyle: ThemeStyle;
  readonly themeStyleHint: ThemeStyle;
  readonly themeMode: ThemeMode;
  readonly themeContrast: ThemeContrast;
  readonly locale: Locale;
  readonly reportKind: ReportKind;
  readonly reportGroupBy: NonNullable<ReportQuery["groupBy"]>;
  readonly exportFormat: "csv" | "pdf";
  readonly exportStatus: ExportJobView["status"];
  readonly pdfTemplate: PdfTemplate;
  readonly deliveryStatus: DeliveryStatus;
  readonly deliveryPurpose: DeliveryPurpose;
  readonly expenseStatus: ExpenseStatus;
  readonly scheduleRunOutcome: RecurringRunView["outcome"];
  readonly scheduleState: "active" | "paused" | "ended";
  readonly cadenceUnit: "weeks" | "months" | "years";
  readonly issueAs: "invoice" | "proforma";
  readonly reminderMode: "inherit" | "disabled" | "custom";
  readonly settingSource: "document" | "contact" | "workspace" | "default";
  readonly contactRole: "customer" | "supplier";
  readonly fxSource: "cnb" | "manual";
  readonly qrFormat: "spayd" | "epc";
  readonly shareEvent: ShareViewEvent["kind"];
  readonly device: ShareViewEvent["device"];
  readonly brandingImage: "logo" | "stamp";
  readonly entity: EntityKind;
  readonly documentTab:
    | "all"
    | "drafts"
    | "invoices"
    | "proformas"
    | "tax_documents"
    | "credit_notes";
  readonly captureJob: "queued" | "uploading" | "submitting" | "blocked" | "failed" | "done";
  readonly badge: BadgeKind;
}

export type EnumName = keyof EnumLabels;

type KeysByEnum = { readonly [E in EnumName]: `enum.${E}.${EnumLabels[E]}` };

type EnumKeys = {
  readonly [E in EnumName]: { readonly [V in EnumLabels[E]]: `enum.${E}.${V}` };
};

// A new domain literal without a label fails the constraint here.
type Covered<_Keys extends MessageKey, Key> = Key;
export type EnumKey<E extends EnumName = EnumName> = Covered<
  KeysByEnum[EnumName],
  { readonly [N in E]: EnumKeys[N][EnumLabels[N]] }[E]
>;

const ENUM_KEYS: EnumKeys = {
  documentKind: {
    invoice: "enum.documentKind.invoice",
    proforma: "enum.documentKind.proforma",
    payment_tax_document: "enum.documentKind.payment_tax_document",
    credit_note: "enum.documentKind.credit_note",
  },
  documentKindPlural: {
    invoice: "enum.documentKindPlural.invoice",
    proforma: "enum.documentKindPlural.proforma",
    payment_tax_document: "enum.documentKindPlural.payment_tax_document",
    credit_note: "enum.documentKindPlural.credit_note",
  },
  documentStatus: {
    draft: "enum.documentStatus.draft",
    issued: "enum.documentStatus.issued",
    cancelled: "enum.documentStatus.cancelled",
  },
  settlement: {
    unpaid: "enum.settlement.unpaid",
    partially_paid: "enum.settlement.partially_paid",
    paid: "enum.settlement.paid",
    overpaid: "enum.settlement.overpaid",
    credited: "enum.settlement.credited",
  },
  documentRelation: {
    corrects: "enum.documentRelation.corrects",
    corrected_by: "enum.documentRelation.corrected_by",
    advance_of: "enum.documentRelation.advance_of",
    tax_document_for: "enum.documentRelation.tax_document_for",
    final_invoice_for: "enum.documentRelation.final_invoice_for",
    deducts: "enum.documentRelation.deducts",
  },
  paymentMethod: {
    bank_transfer: "enum.paymentMethod.bank_transfer",
    cash: "enum.paymentMethod.cash",
    card: "enum.paymentMethod.card",
    other: "enum.paymentMethod.other",
  },
  vatTreatment: {
    standard: "enum.vatTreatment.standard",
    reduced: "enum.vatTreatment.reduced",
    exempt_intra_eu_goods: "enum.vatTreatment.exempt_intra_eu_goods",
    reverse_charge: "enum.vatTreatment.reverse_charge",
    outside_scope: "enum.vatTreatment.outside_scope",
  },
  taxRegime: {
    non_vat_payer: "enum.taxRegime.non_vat_payer",
    vat_payer: "enum.taxRegime.vat_payer",
    identified_person: "enum.taxRegime.identified_person",
  },
  taxRegimeHint: {
    non_vat_payer: "enum.taxRegimeHint.non_vat_payer",
    vat_payer: "enum.taxRegimeHint.vat_payer",
    identified_person: "enum.taxRegimeHint.identified_person",
  },
  role: {
    owner: "enum.role.owner",
    admin: "enum.role.admin",
    member: "enum.role.member",
    accountant: "enum.role.accountant",
  },
  roleHint: {
    owner: "enum.roleHint.owner",
    admin: "enum.roleHint.admin",
    member: "enum.roleHint.member",
    accountant: "enum.roleHint.accountant",
  },
  invitationStatus: {
    pending: "enum.invitationStatus.pending",
    expired: "enum.invitationStatus.expired",
    revoked: "enum.invitationStatus.revoked",
    accepted: "enum.invitationStatus.accepted",
  },
  scopeArea: {
    workspace: "enum.scopeArea.workspace",
    members: "enum.scopeArea.members",
    contacts: "enum.scopeArea.contacts",
    catalog: "enum.scopeArea.catalog",
    documents: "enum.scopeArea.documents",
    payments: "enum.scopeArea.payments",
    expenses: "enum.scopeArea.expenses",
    templates: "enum.scopeArea.templates",
    reports: "enum.scopeArea.reports",
    share: "enum.scopeArea.share",
  },
  scopeLevel: {
    read: "enum.scopeLevel.read",
    write: "enum.scopeLevel.write",
    none: "enum.scopeLevel.none",
  },
  accessLevel: {
    none: "enum.accessLevel.none",
    read: "enum.accessLevel.read",
    write: "enum.accessLevel.write",
  },
  accessMode: {
    read: "enum.accessMode.read",
    read_write: "enum.accessMode.read_write",
    custom: "enum.accessMode.custom",
  },
  themePreset: {
    graphite_atelier: "enum.themePreset.graphite_atelier",
    forest: "enum.themePreset.forest",
    ocean: "enum.themePreset.ocean",
    plum: "enum.themePreset.plum",
    sand: "enum.themePreset.sand",
    graphite: "enum.themePreset.graphite",
  },
  themeStyle: {
    elegant: "enum.themeStyle.elegant",
    cozy: "enum.themeStyle.cozy",
  },
  themeStyleHint: {
    elegant: "enum.themeStyleHint.elegant",
    cozy: "enum.themeStyleHint.cozy",
  },
  themeMode: {
    system: "enum.themeMode.system",
    light: "enum.themeMode.light",
    dark: "enum.themeMode.dark",
  },
  themeContrast: {
    standard: "enum.themeContrast.standard",
    medium: "enum.themeContrast.medium",
    high: "enum.themeContrast.high",
  },
  locale: {
    cs: "enum.locale.cs",
    en: "enum.locale.en",
  },
  reportKind: {
    revenue: "enum.reportKind.revenue",
    vat_summary: "enum.reportKind.vat_summary",
    receivables: "enum.reportKind.receivables",
    expenses: "enum.reportKind.expenses",
    profit: "enum.reportKind.profit",
    cashflow: "enum.reportKind.cashflow",
  },
  reportGroupBy: {
    month: "enum.reportGroupBy.month",
    contact: "enum.reportGroupBy.contact",
    currency: "enum.reportGroupBy.currency",
    category: "enum.reportGroupBy.category",
  },
  exportFormat: {
    csv: "enum.exportFormat.csv",
    pdf: "enum.exportFormat.pdf",
  },
  exportStatus: {
    running: "enum.exportStatus.running",
    ready: "enum.exportStatus.ready",
    failed: "enum.exportStatus.failed",
  },
  pdfTemplate: {
    classic: "enum.pdfTemplate.classic",
    modern_minimal: "enum.pdfTemplate.modern_minimal",
  },
  deliveryStatus: {
    queued: "enum.deliveryStatus.queued",
    sending: "enum.deliveryStatus.sending",
    sent: "enum.deliveryStatus.sent",
    failed: "enum.deliveryStatus.failed",
    skipped: "enum.deliveryStatus.skipped",
  },
  deliveryPurpose: {
    document: "enum.deliveryPurpose.document",
    reminder: "enum.deliveryPurpose.reminder",
  },
  expenseStatus: {
    complete: "enum.expenseStatus.complete",
    incomplete: "enum.expenseStatus.incomplete",
  },
  scheduleRunOutcome: {
    issued: "enum.scheduleRunOutcome.issued",
    failed: "enum.scheduleRunOutcome.failed",
    skipped_missed: "enum.scheduleRunOutcome.skipped_missed",
  },
  scheduleState: {
    active: "enum.scheduleState.active",
    paused: "enum.scheduleState.paused",
    ended: "enum.scheduleState.ended",
  },
  cadenceUnit: {
    weeks: "enum.cadenceUnit.weeks",
    months: "enum.cadenceUnit.months",
    years: "enum.cadenceUnit.years",
  },
  issueAs: {
    invoice: "enum.issueAs.invoice",
    proforma: "enum.issueAs.proforma",
  },
  reminderMode: {
    inherit: "enum.reminderMode.inherit",
    disabled: "enum.reminderMode.disabled",
    custom: "enum.reminderMode.custom",
  },
  settingSource: {
    document: "enum.settingSource.document",
    contact: "enum.settingSource.contact",
    workspace: "enum.settingSource.workspace",
    default: "enum.settingSource.default",
  },
  contactRole: {
    customer: "enum.contactRole.customer",
    supplier: "enum.contactRole.supplier",
  },
  fxSource: {
    cnb: "enum.fxSource.cnb",
    manual: "enum.fxSource.manual",
  },
  qrFormat: {
    spayd: "enum.qrFormat.spayd",
    epc: "enum.qrFormat.epc",
  },
  shareEvent: {
    view: "enum.shareEvent.view",
    download: "enum.shareEvent.download",
  },
  device: {
    desktop: "enum.device.desktop",
    mobile: "enum.device.mobile",
    tablet: "enum.device.tablet",
    unknown: "enum.device.unknown",
  },
  brandingImage: {
    logo: "enum.brandingImage.logo",
    stamp: "enum.brandingImage.stamp",
  },
  entity: {
    Workspace: "enum.entity.Workspace",
    Member: "enum.entity.Member",
    Invitation: "enum.entity.Invitation",
    Contact: "enum.entity.Contact",
    PriceListItem: "enum.entity.PriceListItem",
    Document: "enum.entity.Document",
    Payment: "enum.entity.Payment",
    Expense: "enum.entity.Expense",
    Attachment: "enum.entity.Attachment",
    Template: "enum.entity.Template",
    Schedule: "enum.entity.Schedule",
    NumberingSeries: "enum.entity.NumberingSeries",
    BankAccount: "enum.entity.BankAccount",
    ShareLink: "enum.entity.ShareLink",
    BrandingImage: "enum.entity.BrandingImage",
    Export: "enum.entity.Export",
    ApiKey: "enum.entity.ApiKey",
    McpGrant: "enum.entity.McpGrant",
  },
  documentTab: {
    all: "enum.documentTab.all",
    drafts: "enum.documentTab.drafts",
    invoices: "enum.documentTab.invoices",
    proformas: "enum.documentTab.proformas",
    tax_documents: "enum.documentTab.tax_documents",
    credit_notes: "enum.documentTab.credit_notes",
  },
  captureJob: {
    queued: "enum.captureJob.queued",
    uploading: "enum.captureJob.uploading",
    submitting: "enum.captureJob.submitting",
    blocked: "enum.captureJob.blocked",
    failed: "enum.captureJob.failed",
    done: "enum.captureJob.done",
  },
  badge: {
    draft: "enum.badge.draft",
    issued: "enum.badge.issued",
    sent: "enum.badge.sent",
    viewed: "enum.badge.viewed",
    partially_paid: "enum.badge.partially_paid",
    paid: "enum.badge.paid",
    overdue: "enum.badge.overdue",
    credited: "enum.badge.credited",
    cancelled: "enum.badge.cancelled",
    locked: "enum.badge.locked",
    proforma: "enum.badge.proforma",
    incomplete: "enum.badge.incomplete",
    queued: "enum.badge.queued",
    failed: "enum.badge.failed",
  },
};

interface EnumLabel<E extends EnumName> {
  readonly name: E;
  readonly value: EnumLabels[E];
}

export const enumKey = <E extends EnumName>({ name, value }: EnumLabel<E>): EnumKey<E> =>
  ENUM_KEYS[name][value];

/** Text label for a domain enum value. */
export const enumText = <E extends EnumName>(label: EnumLabel<E>): Text<EnumKey<E>> => ({
  key: enumKey(label),
});
