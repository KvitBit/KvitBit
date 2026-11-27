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

export type EnumKey<E extends EnumName = EnumName> = E extends EnumName
  ? `enum.${E}.${EnumLabels[E]}`
  : never;

// Compile-time seam: a new domain literal without a label fails type checking here.
const enumKeysCovered: [Exclude<EnumKey, MessageKey>] extends [never]
  ? true
  : Exclude<EnumKey, MessageKey> = true;
// biome-ignore lint/complexity/noVoid: Keep the compile-time catalog coverage check.
void enumKeysCovered;

// Mobile translation calls rely on the original generic inference for the enum name.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const enumKey = <E extends EnumName>(name: E, value: EnumLabels[E]): EnumKey<E> =>
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: The enum name and value are tied by EnumLabels[E].
  `enum.${name}.${value}` as EnumKey<E>;

/** `Text` label for an enum value, e.g. `enumText("documentKind", "proforma")`. */
// Match the original generic signature of enumKey.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const enumText = <E extends EnumName>(name: E, value: EnumLabels[E]): Text<EnumKey<E>> => ({
  key: enumKey(name, value),
});
