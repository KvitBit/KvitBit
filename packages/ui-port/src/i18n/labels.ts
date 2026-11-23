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
  InvitationStatus as InvitationStatusSchema,
  Locale,
  PaymentMethod,
  PdfTemplate,
  ReportKind,
  Role,
  ScopeArea,
  ScopeLevel,
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
  readonly reportGroupBy: "month" | "contact" | "currency" | "category";
  readonly exportFormat: "csv" | "pdf";
  readonly exportStatus: "running" | "ready" | "failed";
  readonly pdfTemplate: PdfTemplate;
  readonly deliveryStatus: DeliveryStatus;
  readonly deliveryPurpose: DeliveryPurpose;
  readonly expenseStatus: ExpenseStatus;
  readonly scheduleRunOutcome: "issued" | "failed" | "skipped_missed";
  readonly scheduleState: "active" | "paused" | "ended";
  readonly cadenceUnit: "weeks" | "months" | "years";
  readonly issueAs: "invoice" | "proforma";
  readonly reminderMode: "inherit" | "disabled" | "custom";
  readonly settingSource: "document" | "contact" | "workspace" | "default";
  readonly contactRole: "customer" | "supplier";
  readonly fxSource: "cnb" | "manual";
  readonly qrFormat: "spayd" | "epc";
  readonly shareEvent: "view" | "download";
  readonly device: "desktop" | "mobile" | "tablet" | "unknown";
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

export type EnumKey<E extends EnumName = EnumName> = E extends EnumName
  ? `enum.${E}.${EnumLabels[E]}`
  : never;

// Compile-time seam: a new domain literal without a label fails type checking here.
const enumKeysCovered: [Exclude<EnumKey, MessageKey>] extends [never]
  ? true
  : Exclude<EnumKey, MessageKey> = true;
void enumKeysCovered;

export const enumKey = <E extends EnumName>(name: E, value: EnumLabels[E]): EnumKey<E> =>
  `enum.${name}.${value}` as EnumKey<E>;

/** `Text` label for an enum value, e.g. `enumText("documentKind", "proforma")`. */
export const enumText = <E extends EnumName>(name: E, value: EnumLabels[E]): Text<EnumKey<E>> => ({
  key: enumKey(name, value),
});
