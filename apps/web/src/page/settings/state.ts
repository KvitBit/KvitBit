import { UiSchema } from "@effect/ui";
import {
  ALL_SCOPES,
  ApiKeyCreated,
  ApiKeyId,
  ApiKeyView,
  BrandingView,
  ConnectedAppView,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  CurrencyCode,
  ImageRef,
  InvitationId,
  InvitationView,
  MemberView,
  NumberingSeriesId,
  NumberingSeriesView,
  RegistryResult,
  UserId,
} from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { Failure } from "../../app/api";
import { type PageContext, RouteCases } from "../../app/page";
import * as Remote from "../../app/remote";
import { BankAccount, WorkspaceDetail } from "./models";

export const Route = Schema.Union([RouteCases.Settings, RouteCases.More]);
export type Route = typeof Route.Type;
export type SettingsSection = ViewModels.SettingsSection;

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  "issuingEntity",
  "taxRegime",
  "bankAccounts",
  "branding",
  "numbering",
  "documentDefaults",
  "reminders",
  "team",
  "apiKeys",
  "connectedApps",
  "dangerZone",
];

// --- Form Sub-Schemas ---------------------------------------------------------------------------

const EntityForm = Schema.Struct({
  name: Schema.String,
  ico: Schema.String,
  dic: Schema.String,
  legalForm: Schema.String,
  registerEntry: Schema.String,
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  web: Schema.String,
  slug: Schema.String,
  lookingUpAres: Schema.Boolean,
  saving: Schema.Boolean,
});

const TaxRegimeForm = Schema.Struct({
  nextRegime: Schema.Literals(["vat_payer", "non_vat_payer", "identified_person"]),
  effectiveFrom: Schema.String,
  confirmOpen: Schema.Boolean,
  saving: Schema.Boolean,
});

const BankForm = Schema.Struct({
  editingId: Schema.NullOr(BankAccountId),
  name: Schema.String,
  iban: Schema.String,
  bic: Schema.String,
  currency: CurrencyCode,
  isDefault: Schema.Boolean,
  saving: Schema.Boolean,
  removingId: Schema.NullOr(BankAccountId),
  replacementId: Schema.String,
});

const BrandingForm = Schema.Struct({
  pdfTemplate: Schema.Literals(["classic", "modern_minimal"]),
  accentColor: Schema.String,
  footerText: Schema.String,
  themeChoice: Schema.String, // "" | ThemePresetId | "seed"
  themeSeed: Schema.String,
  previewLocale: Schema.Literals(["cs", "en"]),
  saving: Schema.Boolean,
  uploading: Schema.NullOr(Schema.Literals(["logo", "stamp"])),
  previewingPdf: Schema.Boolean,
});

const NumberingForm = Schema.Struct({
  editingId: Schema.NullOr(NumberingSeriesId),
  kind: Schema.Literals(["invoice", "proforma", "payment_tax_document", "credit_note"]),
  name: Schema.String,
  pattern: Schema.String,
  nextNumber: Schema.String,
  isDefault: Schema.Boolean,
  saving: Schema.Boolean,
});

const DefaultsForm = Schema.Struct({
  currency: CurrencyCode,
  language: Schema.Literals(["cs", "en"]),
  dueDays: Schema.String,
  paymentMethod: Schema.Literals(["bank_transfer", "cash", "card", "other"]),
  paymentRounding: Schema.Literals(["none", "whole_unit"]),
  defaultNote: Schema.String,
  paymentTaxDocumentAutoSend: Schema.Boolean,
  saving: Schema.Boolean,
});

const RemindersForm = Schema.Struct({
  enabled: Schema.Boolean,
  proformas: Schema.Boolean,
  offsetsDays: Schema.Array(Schema.Int),
  newOffset: Schema.String,
  paymentTaxDocumentAutoSend: Schema.Boolean,
  saving: Schema.Boolean,
});

const TeamForm = Schema.Struct({
  inviteEmail: Schema.String,
  inviteRole: Schema.Literals(["admin", "member", "accountant"]),
  inviting: Schema.Boolean,
  removingUserId: Schema.NullOr(UserId),
  confirmLeave: Schema.Boolean,
});

const ApiKeysForm = Schema.Struct({
  creating: Schema.Boolean,
  name: Schema.String,
  expiresOn: Schema.String,
  accessMode: Schema.Literals(["read", "read_write", "custom"]),
  selectedScopes: Schema.Array(Schema.Literals(ALL_SCOPES)),
  saving: Schema.Boolean,
  createdSecret: Schema.NullOr(Schema.String),
  createdKeyName: Schema.NullOr(Schema.String),
  revokingId: Schema.NullOr(ApiKeyId),
});

const ConnectedAppsForm = Schema.Struct({
  revokingGrantId: Schema.NullOr(Schema.String),
});

const DangerForm = Schema.Struct({
  exporting: Schema.Boolean,
  transferToUserId: Schema.String,
  confirmTransfer: Schema.Boolean,
  transferring: Schema.Boolean,
  closeConfirmName: Schema.String,
  closing: Schema.Boolean,
});

export const Model = Schema.Struct({
  route: Route,
  workspace: Remote.remoteSchema(WorkspaceDetail),
  bankAccounts: BankAccount.pipe(Schema.Array, Remote.remoteSchema),
  branding: Remote.remoteSchema(BrandingView),
  series: NumberingSeriesView.pipe(Schema.Array, Remote.remoteSchema),
  members: MemberView.pipe(Schema.Array, Remote.remoteSchema),
  invitations: InvitationView.pipe(Schema.Array, Remote.remoteSchema),
  apiKeys: ApiKeyView.pipe(Schema.Array, Remote.remoteSchema),
  connectedApps: ConnectedAppView.pipe(Schema.Array, Remote.remoteSchema),
  entityForm: EntityForm,
  taxForm: TaxRegimeForm,
  bankForm: BankForm,
  brandingForm: BrandingForm,
  numberingForm: NumberingForm,
  defaultsForm: DefaultsForm,
  remindersForm: RemindersForm,
  teamForm: TeamForm,
  apiKeysForm: ApiKeysForm,
  connectedAppsForm: ConnectedAppsForm,
  dangerForm: DangerForm,
  actionFailure: Schema.NullOr(Failure),
});
export type Model = typeof Model.Type;

// --- Messages -----------------------------------------------------------------------------------

export const Message = UiSchema.TaggedEnum({
  // Data loads
  GotWorkspace: { seq: Remote.Seq, data: WorkspaceDetail },
  FailedWorkspace: { seq: Remote.Seq, failure: Failure },
  GotBankAccounts: { seq: Remote.Seq, items: Schema.Array(BankAccount) },
  FailedBankAccounts: { seq: Remote.Seq, failure: Failure },
  GotBranding: { seq: Remote.Seq, data: BrandingView },
  FailedBranding: { seq: Remote.Seq, failure: Failure },
  GotSeries: { seq: Remote.Seq, items: Schema.Array(NumberingSeriesView) },
  FailedSeries: { seq: Remote.Seq, failure: Failure },
  GotMembers: { seq: Remote.Seq, items: Schema.Array(MemberView) },
  FailedMembers: { seq: Remote.Seq, failure: Failure },
  GotInvitations: { seq: Remote.Seq, items: Schema.Array(InvitationView) },
  FailedInvitations: { seq: Remote.Seq, failure: Failure },
  GotApiKeys: { seq: Remote.Seq, items: Schema.Array(ApiKeyView) },
  FailedApiKeys: { seq: Remote.Seq, failure: Failure },
  GotConnectedApps: { seq: Remote.Seq, items: Schema.Array(ConnectedAppView) },
  FailedConnectedApps: { seq: Remote.Seq, failure: Failure },

  // Issuing Entity
  ChangedEntityField: {
    field: Schema.Literals([
      "name",
      "ico",
      "dic",
      "legalForm",
      "registerEntry",
      "street",
      "city",
      "postalCode",
      "country",
      "email",
      "phone",
      "web",
      "slug",
    ]),
    value: Schema.String,
  },
  ClickedAresLookup: {},
  GotAresResult: { result: RegistryResult },
  ClickedSaveEntity: {},
  SavedWorkspace: { data: WorkspaceDetail },

  // Tax Regime
  ChangedTaxRegime: {
    regime: Schema.Literals(["vat_payer", "non_vat_payer", "identified_person"]),
  },
  ChangedTaxEffectiveFrom: { value: Schema.String },
  ClickedAskChangeTaxRegime: {},
  ClickedCancelTaxRegime: {},
  ClickedConfirmTaxRegime: {},

  // Bank Accounts
  ChangedBankField: {
    field: Schema.Literals(["name", "iban", "bic"]),
    value: Schema.String,
  },
  ChangedBankCurrency: { currency: CurrencyCode },
  ToggledBankDefault: { checked: Schema.Boolean },
  ClickedEditBank: { id: BankAccountId },
  ClickedResetBankForm: {},
  ClickedSaveBank: {},
  SavedBank: { item: BankAccount },
  ClickedMakeBankDefault: { id: BankAccountId },
  ClickedAskRemoveBank: { id: BankAccountId },
  ChangedBankReplacement: { value: Schema.String },
  ClickedCancelRemoveBank: {},
  ClickedConfirmRemoveBank: {},
  RemovedBank: { id: BankAccountId },

  // Branding
  SelectedPdfTemplate: { template: Schema.Literals(["classic", "modern_minimal"]) },
  ChangedAccentColor: { value: Schema.String },
  ChangedFooterText: { value: Schema.String },
  SelectedWorkspaceTheme: { choice: Schema.String },
  ChangedWorkspaceThemeSeed: { value: Schema.String },
  SelectedPreviewLocale: { locale: Schema.Literals(["cs", "en"]) },
  SelectedBrandingImage: {
    kind: Schema.Literals(["logo", "stamp"]),
    file: Schema.instanceOf(File),
  },
  UploadedBrandingImage: {
    kind: Schema.Literals(["logo", "stamp"]),
    ref: ImageRef,
  },
  ClickedRemoveBrandingImage: { kind: Schema.Literals(["logo", "stamp"]) },
  RemovedBrandingImage: { kind: Schema.Literals(["logo", "stamp"]) },
  ClickedSaveBranding: {},
  SavedBranding: { data: BrandingView },
  ClickedPreviewPdf: {},
  FinishedPreviewPdf: {},

  // Numbering Series
  ChangedSeriesKind: {
    kind: Schema.Literals(["invoice", "proforma", "payment_tax_document", "credit_note"]),
  },
  ChangedSeriesField: {
    field: Schema.Literals(["name", "pattern", "nextNumber"]),
    value: Schema.String,
  },
  ClickedInsertToken: { token: Schema.String },
  ToggledSeriesDefault: { checked: Schema.Boolean },
  ClickedEditSeries: { id: NumberingSeriesId },
  ClickedResetSeriesForm: {},
  ClickedSaveSeries: {},
  SavedSeries: { item: NumberingSeriesView },
  ClickedMakeSeriesDefault: { id: NumberingSeriesId },

  // Document Defaults
  ChangedDefaultCurrency: { currency: CurrencyCode },
  ChangedDefaultLanguage: { language: Schema.Literals(["cs", "en"]) },
  ChangedDefaultDueDays: { value: Schema.String },
  ChangedDefaultPaymentMethod: {
    method: Schema.Literals(["bank_transfer", "cash", "card", "other"]),
  },
  ChangedDefaultRounding: { rounding: Schema.Literals(["none", "whole_unit"]) },
  ChangedDefaultNote: { value: Schema.String },
  ToggledDefaultAutoSendPtd: { checked: Schema.Boolean },
  ClickedSaveDefaults: {},

  // Reminders
  ToggledRemindersEnabled: { checked: Schema.Boolean },
  ToggledRemindersProformas: { checked: Schema.Boolean },
  ChangedNewReminderOffset: { value: Schema.String },
  ClickedAddReminderOffset: {},
  ClickedRemoveReminderOffset: { day: Schema.Int },
  ToggledRemindersAutoSendPtd: { checked: Schema.Boolean },
  ClickedSaveReminders: {},

  // Team
  ChangedInviteEmail: { value: Schema.String },
  ChangedInviteRole: { role: Schema.Literals(["admin", "member", "accountant"]) },
  ClickedSendInvite: {},
  SentInvite: { item: InvitationView },
  ClickedResendInvite: { id: InvitationId },
  ResentInvite: {},
  ClickedRevokeInvite: { id: InvitationId },
  RevokedInvite: { id: InvitationId },
  ChangedMemberRole: {
    userId: UserId,
    role: Schema.Literals(["admin", "member", "accountant"]),
  },
  UpdatedMemberRole: {
    userId: UserId,
    role: Schema.Literals(["admin", "member", "accountant"]),
  },
  ClickedAskRemoveMember: { userId: UserId },
  ClickedCancelRemoveMember: {},
  ClickedConfirmRemoveMember: {},
  RemovedMember: { userId: UserId },
  ClickedAskLeave: {},
  ClickedCancelLeave: {},
  ClickedConfirmLeave: {},
  LeftWorkspace: {},

  // API Keys
  ClickedToggleCreateApiKey: {},
  ChangedApiKeyName: { value: Schema.String },
  ChangedApiKeyExpires: { value: Schema.String },
  SelectedApiKeyPreset: { preset: Schema.Literals(["read", "read_write"]) },
  SelectedApiKeyCustom: {},
  ToggledApiKeyScope: { scope: Schema.Literals(ALL_SCOPES) },
  ClickedCreateApiKey: {},
  CreatedApiKey: { created: ApiKeyCreated },
  ClickedCopyApiKeySecret: {},
  CopiedApiKeySecret: {},
  ClickedDismissApiKeySecret: {},
  ClickedAskRevokeApiKey: { id: ApiKeyId },
  ClickedCancelRevokeApiKey: {},
  ClickedConfirmRevokeApiKey: {},
  RevokedApiKey: { id: ApiKeyId },

  // Connected Apps
  ClickedAskRevokeApp: { grantId: Schema.String },
  ClickedCancelRevokeApp: {},
  ClickedConfirmRevokeApp: {},
  RevokedApp: { grantId: Schema.String },

  // Danger Zone
  ClickedStartExport: {},
  StartedExport: {},
  ChangedTransferTarget: { userId: Schema.String },
  ClickedAskTransfer: {},
  ClickedCancelTransfer: {},
  ClickedConfirmTransfer: {},
  TransferredOwnership: {},
  ChangedCloseConfirm: { value: Schema.String },
  ClickedCloseWorkspace: {},
  ClosedWorkspace: {},

  // Shared
  FailedAction: { failure: Failure },
  ClickedRetry: {},
});
export type Message = typeof Message.Type;

// --- Helpers ------------------------------------------------------------------------------------

export const canEditSettings = (ctx: PageContext): boolean => {
  if (ctx.workspace === null || ctx.workspace.closed) return false;
  return ctx.workspace.role === "owner" || ctx.workspace.role === "admin";
};

export const scopePickerFromModel: {
  (ctx: PageContext): (model: Model) => ViewModels.ScopePickerState;
  (model: Model, ctx: PageContext): ViewModels.ScopePickerState;
} = Fn.dual(2, (model: Model, ctx: PageContext): ViewModels.ScopePickerState => {
  const grantable = ViewModels.roleScopeCeiling(ctx.workspace?.role ?? "member");
  return {
    mode: model.apiKeysForm.accessMode,
    selected: new Set(model.apiKeysForm.selectedScopes),
    grantable,
  };
});
