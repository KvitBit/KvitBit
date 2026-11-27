import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Workspace Settings & Mobile More Hub (Screens 18–21, routes `Settings` | `More`).
 * Covers all 11 settings sections: issuingEntity, taxRegime, bankAccounts, branding, numbering,
 * documentDefaults, reminders, team, apiKeys, connectedApps, dangerZone, plus Mobile More hub.
 * Contract: src/app/page.ts.
 */
import {
  ALL_SCOPES,
  ApiKeyCreated,
  ApiKeyId,
  ApiKeyView,
  BrandingView,
  ConnectedAppView,
  READ_SCOPES,
  type Scope,
  type ThemePresetId,
  type ThemeSource,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  CurrencyCode,
  type DocumentKind,
  type ImageRef,
  InvitationId,
  InvitationView,
  type Locale,
  MemberView,
  NumberingSeriesId,
  NumberingSeriesView,
  type PaymentMethod,
  type PdfTemplate,
  RegistryResult,
  type Role,
  type TaxRegime,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain";
import { Api, Theme, ViewModels } from "@kvitbit/ui-port";
import { Effect, Option, Schema } from "effect";
import { type Client, Failure, failureFromUnknown, request, type WebServices } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { sCopy } from "./copy";
import {
  BankAccount,
  cmd,
  type PaymentRounding,
  parseBankAccount,
  parseBankAccounts,
  parseWorkspaceDetail,
  WorkspaceDetail,
} from "./models";
import { viewSettingsPage } from "./views";

export type Route = RouteOf<"Settings" | "More">;
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
  route: ViewModels.Route,
  workspace: Remote.remoteSchema(WorkspaceDetail),
  bankAccounts: Remote.remoteSchema(Schema.Array(BankAccount)),
  branding: Remote.remoteSchema(BrandingView),
  series: Remote.remoteSchema(Schema.Array(NumberingSeriesView)),
  members: Remote.remoteSchema(Schema.Array(MemberView)),
  invitations: Remote.remoteSchema(Schema.Array(InvitationView)),
  apiKeys: Remote.remoteSchema(Schema.Array(ApiKeyView)),
  connectedApps: Remote.remoteSchema(Schema.Array(ConnectedAppView)),
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
    file: Schema.Unknown,
  },
  UploadedBrandingImage: {
    kind: Schema.Literals(["logo", "stamp"]),
    ref: Schema.Unknown,
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

const workspaceIdOf = (ctx: PageContext): WorkspaceId | undefined =>
  ctx.workspace !== null ? WorkspaceId.make(ctx.workspace.id) : undefined;

const viewerRoleOf = (ctx: PageContext): Role => ctx.workspace?.role ?? "member";

export const canEditSettings = (ctx: PageContext): boolean => {
  if (ctx.workspace === null || ctx.workspace.closed) return false;
  return ctx.workspace.role === "owner" || ctx.workspace.role === "admin";
};

export const scopePickerFromModel = (
  model: Model,
  ctx: PageContext,
): ViewModels.ScopePickerState => {
  const grantable = ViewModels.roleScopeCeiling(viewerRoleOf(ctx));
  return {
    mode: model.apiKeysForm.accessMode,
    selected: new Set(model.apiKeysForm.selectedScopes),
    grantable,
  };
};

const syncFormsFromWorkspace = (model: Model, ws: WorkspaceDetail): Model => {
  const themeChoice =
    ws.branding.theme === null
      ? ""
      : ws.branding.theme._tag === "Preset"
        ? ws.branding.theme.id
        : "seed";
  const themeSeed =
    ws.branding.theme !== null && ws.branding.theme._tag === "Seed" ? ws.branding.theme.seed : "";

  return {
    ...model,
    entityForm: {
      ...model.entityForm,
      name: ws.issuingEntity.name,
      ico: ws.issuingEntity.ico ?? "",
      dic: ws.issuingEntity.dic ?? "",
      legalForm: ws.issuingEntity.legalForm ?? "",
      registerEntry: ws.issuingEntity.registerEntry ?? "",
      street: ws.issuingEntity.address.street,
      city: ws.issuingEntity.address.city,
      postalCode: ws.issuingEntity.address.postalCode,
      country: ws.issuingEntity.address.country,
      email: ws.issuingEntity.email ?? "",
      phone: ws.issuingEntity.phone ?? "",
      web: ws.issuingEntity.web ?? "",
      slug: ws.slug,
      saving: false,
    },
    taxForm: {
      ...model.taxForm,
      nextRegime: ws.taxRegime,
      confirmOpen: false,
      saving: false,
    },
    brandingForm: {
      ...model.brandingForm,
      pdfTemplate: ws.branding.pdfTemplate,
      accentColor: ws.branding.accentColor,
      footerText: ws.branding.footerText ?? "",
      themeChoice,
      themeSeed,
      saving: false,
    },
    defaultsForm: {
      ...model.defaultsForm,
      currency: ws.defaults.currency,
      language: ws.defaults.language,
      dueDays: String(ws.defaults.dueDays),
      paymentMethod: ws.defaults.paymentMethod,
      paymentRounding: ws.defaults.paymentRounding,
      defaultNote: ws.defaults.defaultNote ?? "",
      paymentTaxDocumentAutoSend: ws.defaults.paymentTaxDocumentAutoSend,
      saving: false,
    },
    remindersForm: {
      ...model.remindersForm,
      enabled: ws.reminderPolicy.enabled,
      proformas: ws.reminderPolicy.proformas,
      offsetsDays: [...ws.reminderPolicy.offsetsDays],
      paymentTaxDocumentAutoSend: ws.defaults.paymentTaxDocumentAutoSend,
      saving: false,
    },
  };
};

// --- Commands -----------------------------------------------------------------------------------

const req = <A, E>(
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => Message,
  onFailure: (f: Failure) => Message,
): Effect.Effect<Message, never, WebServices> => request<A, E, Message>(call, onSuccess, onFailure);

const cmdLoadWorkspace = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadWorkspace",
    req(
      (c) => c.workspace.current({ params: { workspaceId } }),
      (raw) =>
        Option.match(parseWorkspaceDetail(raw), {
          onSome: (data) => Message.GotWorkspace({ seq, data }),
          onNone: () =>
            Message.FailedWorkspace({
              seq,
              failure: failureFromUnknown(new Error("Invalid workspace payload")),
            }),
        }),
      (failure) => Message.FailedWorkspace({ seq, failure }),
    ),
  );

const cmdLoadBankAccounts = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadBankAccounts",
    req(
      (c) => c.workspace.listBankAccounts({ params: { workspaceId } }),
      (raw) => Message.GotBankAccounts({ seq, items: parseBankAccounts(raw) }),
      (failure) => Message.FailedBankAccounts({ seq, failure }),
    ),
  );

const cmdLoadBranding = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadBranding",
    req(
      (c) => c.branding.getBranding({ params: { workspaceId } }),
      (data) => Message.GotBranding({ seq, data }),
      (failure) => Message.FailedBranding({ seq, failure }),
    ),
  );

const cmdLoadSeries = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadSeries",
    req(
      (c) => c.workspace.listSeries({ params: { workspaceId } }),
      (items) => Message.GotSeries({ seq, items }),
      (failure) => Message.FailedSeries({ seq, failure }),
    ),
  );

const cmdLoadMembers = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadMembers",
    req(
      (c) => c.team.listMembers({ params: { workspaceId } }),
      (items) => Message.GotMembers({ seq, items }),
      (failure) => Message.FailedMembers({ seq, failure }),
    ),
  );

const cmdLoadInvitations = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadInvitations",
    req(
      (c) => c.team.listInvitations({ params: { workspaceId } }),
      (items) => Message.GotInvitations({ seq, items }),
      (failure) => Message.FailedInvitations({ seq, failure }),
    ),
  );

const cmdLoadApiKeys = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadApiKeys",
    req(
      (c) => c.apiKeys.listApiKeys({ params: { workspaceId } }),
      (items) => Message.GotApiKeys({ seq, items }),
      (failure) => Message.FailedApiKeys({ seq, failure }),
    ),
  );

const cmdLoadConnectedApps = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    "Settings.LoadConnectedApps",
    req(
      (c) => c.connectedApps.listConnectedApps({ params: { workspaceId } }),
      (items) => Message.GotConnectedApps({ seq, items }),
      (failure) => Message.FailedConnectedApps({ seq, failure }),
    ),
  );

const cmdLookupAres = (ico: string) =>
  cmd(
    "Settings.LookupAres",
    req(
      (c) => c.registry.lookupCompany({ params: { ico } }),
      (result) => Message.GotAresResult({ result }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdUpdateIssuingEntity = (
  workspaceId: WorkspaceId,
  revision: number,
  payload: Record<string, unknown>,
) =>
  cmd(
    "Settings.UpdateIssuingEntity",
    req(
      (c) =>
        c.workspace.updateIssuingEntity({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload: payload as never,
        }),
      (raw) =>
        Option.match(parseWorkspaceDetail(raw), {
          onSome: (data) => Message.SavedWorkspace({ data }),
          onNone: () =>
            Message.FailedAction({
              failure: failureFromUnknown(new Error("Invalid workspace response")),
            }),
        }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdUpdateSettings = (
  workspaceId: WorkspaceId,
  revision: number,
  payload: Record<string, unknown>,
) =>
  cmd(
    "Settings.UpdateSettings",
    req(
      (c) =>
        c.workspace.updateSettings({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload: payload as never,
        }),
      (raw) =>
        Option.match(parseWorkspaceDetail(raw), {
          onSome: (data) => Message.SavedWorkspace({ data }),
          onNone: () =>
            Message.FailedAction({
              failure: failureFromUnknown(new Error("Invalid workspace response")),
            }),
        }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdSaveBankAccount = (
  workspaceId: WorkspaceId,
  editingId: BankAccountId | null,
  payload: Record<string, unknown>,
) =>
  cmd(
    "Settings.SaveBankAccount",
    req(
      (c) =>
        editingId === null
          ? c.workspace.createBankAccount({
              params: { workspaceId },
              headers: Api.idempotencyHeaders(`bank-${Date.now()}`),
              payload: payload as never,
            })
          : c.workspace.updateBankAccount({
              params: { workspaceId, bankAccountId: editingId },
              payload: payload as never,
            }),
      (raw) =>
        Option.match(parseBankAccount(raw), {
          onSome: (item) => Message.SavedBank({ item }),
          onNone: () =>
            Message.FailedAction({
              failure: failureFromUnknown(new Error("Invalid bank account response")),
            }),
        }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRemoveBankAccount = (
  workspaceId: WorkspaceId,
  bankAccountId: BankAccountId,
  replacement: BankAccountId | undefined,
) =>
  cmd(
    "Settings.RemoveBankAccount",
    req(
      (c) =>
        c.workspace.removeBankAccount({
          params: { workspaceId, bankAccountId },
          query: replacement === undefined ? {} : { replacement },
        }),
      () => Message.RemovedBank({ id: bankAccountId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdUpdateBranding = (
  workspaceId: WorkspaceId,
  revision: number,
  payload: {
    readonly pdfTemplate: PdfTemplate;
    readonly accentColor: string;
    readonly footerText: string | null;
    readonly theme: ThemeSource | null;
  },
) =>
  cmd(
    "Settings.UpdateBranding",
    req(
      (c) =>
        c.branding.updateBranding({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload: payload as never,
        }),
      (data) => Message.SavedBranding({ data }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdUploadBrandingImage = (workspaceId: WorkspaceId, kind: "logo" | "stamp", file: unknown) =>
  cmd<Message>(
    "Settings.UploadBrandingImage",
    Effect.tryPromise({
      try: async () => {
        const fd = new FormData();
        if (file instanceof Blob) fd.append("file", file);
        const res = await fetch(`/api/v1/workspaces/${workspaceId}/branding/${kind}`, {
          method: "PUT",
          credentials: "same-origin",
          body: fd,
        });
        if (!res.ok) throw Object.assign(new Error(`upload ${res.status}`), { status: res.status });
        return (await res.json()) as ImageRef;
      },
      catch: (e) => e,
    }).pipe(
      Effect.map((ref): Message => Message.UploadedBrandingImage({ kind, ref })),
      Effect.catch((e) => Effect.succeed(Message.FailedAction({ failure: failureFromUnknown(e) }))),
    ),
  );

const cmdRemoveBrandingImage = (workspaceId: WorkspaceId, kind: "logo" | "stamp") =>
  cmd(
    "Settings.RemoveBrandingImage",
    req(
      (c) => c.branding.removeImage({ params: { workspaceId, image: kind } }),
      () => Message.RemovedBrandingImage({ kind }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdPreviewPdf = (
  workspaceId: WorkspaceId,
  pdfTemplate: PdfTemplate,
  accentColor: string,
  footerText: string | null,
  language: Locale,
) =>
  cmd(
    "Settings.PreviewPdf",
    req(
      (c) =>
        c.branding.previewPdf({
          params: { workspaceId },
          payload: {
            branding: { pdfTemplate, accentColor: accentColor as never, footerText },
            kind: "invoice",
            language,
          },
        }),
      () => Message.FinishedPreviewPdf(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdSaveSeries = (
  workspaceId: WorkspaceId,
  editingId: NumberingSeriesId | null,
  payload: {
    readonly kind: DocumentKind;
    readonly name: string;
    readonly pattern: string;
    readonly nextNumber?: number;
    readonly isDefault?: boolean;
  },
) =>
  cmd(
    "Settings.SaveSeries",
    req(
      (c) =>
        editingId === null
          ? c.workspace.createSeries({
              params: { workspaceId },
              headers: Api.idempotencyHeaders(`series-${Date.now()}`),
              payload: payload as never,
            })
          : c.workspace.updateSeries({
              params: { workspaceId, seriesId: editingId },
              payload: payload as never,
            }),
      (item) => Message.SavedSeries({ item }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdInviteMember = (workspaceId: WorkspaceId, email: string, role: Exclude<Role, "owner">) =>
  cmd(
    "Settings.InviteMember",
    req(
      (c) =>
        c.team.invite({
          params: { workspaceId },
          headers: Api.idempotencyHeaders(`invite-${Date.now()}`),
          payload: { email: email as never, role },
        }),
      (item) => Message.SentInvite({ item }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdResendInvite = (workspaceId: WorkspaceId, invitationId: InvitationId) =>
  cmd(
    "Settings.ResendInvite",
    req(
      (c) => c.team.resendInvitation({ params: { workspaceId, invitationId } }),
      () => Message.ResentInvite(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRevokeInvite = (workspaceId: WorkspaceId, invitationId: InvitationId) =>
  cmd(
    "Settings.RevokeInvite",
    req(
      (c) => c.team.revokeInvitation({ params: { workspaceId, invitationId } }),
      () => Message.RevokedInvite({ id: invitationId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdSetMemberRole = (workspaceId: WorkspaceId, userId: UserId, role: Exclude<Role, "owner">) =>
  cmd(
    "Settings.SetMemberRole",
    req(
      (c) => c.team.setRole({ params: { workspaceId, userId }, payload: { role } }),
      () => Message.UpdatedMemberRole({ userId, role }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRemoveMember = (workspaceId: WorkspaceId, userId: UserId) =>
  cmd(
    "Settings.RemoveMember",
    req(
      (c) => c.team.removeMember({ params: { workspaceId, userId } }),
      () => Message.RemovedMember({ userId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdLeaveWorkspace = (workspaceId: WorkspaceId) =>
  cmd(
    "Settings.LeaveWorkspace",
    req(
      (c) => c.team.leave({ params: { workspaceId } }),
      () => Message.LeftWorkspace(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdCreateApiKey = (
  workspaceId: WorkspaceId,
  name: string,
  expiresOn: string | undefined,
  access: ViewModels.ScopePickerState,
) => {
  const reqOpt = ViewModels.toAccessRequest(access);
  if (Option.isNone(reqOpt)) {
    return cmd<Message>(
      "Settings.CreateApiKey",
      Effect.succeed(
        Message.FailedAction({
          failure: failureFromUnknown(new Error("Select at least one scope")),
        }),
      ),
    );
  }
  const payload =
    reqOpt.value.access === "custom"
      ? {
          name: name as never,
          ...(expiresOn !== undefined ? { expiresOn: expiresOn as never } : {}),
          access: "custom" as const,
          scopes: reqOpt.value.scopes,
        }
      : {
          name: name as never,
          ...(expiresOn !== undefined ? { expiresOn: expiresOn as never } : {}),
          access: reqOpt.value.access,
        };
  return cmd(
    "Settings.CreateApiKey",
    req(
      (c) => c.apiKeys.createApiKey({ params: { workspaceId }, payload }),
      (created) => Message.CreatedApiKey({ created }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );
};

const cmdCopySecret = (secret: string) =>
  cmd<Message>(
    "Settings.CopyApiKeySecret",
    Effect.tryPromise({
      try: async () => {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(secret);
        }
      },
      catch: () => undefined,
    }).pipe(
      Effect.map((): Message => Message.CopiedApiKeySecret()),
      Effect.catch(() => Effect.succeed(Message.CopiedApiKeySecret())),
    ),
  );

const cmdRevokeApiKey = (workspaceId: WorkspaceId, keyId: ApiKeyId) =>
  cmd(
    "Settings.RevokeApiKey",
    req(
      (c) => c.apiKeys.revokeApiKey({ params: { workspaceId, keyId } }),
      () => Message.RevokedApiKey({ id: keyId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRevokeConnectedApp = (workspaceId: WorkspaceId, grantId: string) =>
  cmd(
    "Settings.RevokeConnectedApp",
    req(
      (c) => c.connectedApps.revokeConnectedApp({ params: { workspaceId, grantId } }),
      () => Message.RevokedApp({ grantId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdStartExport = (workspaceId: WorkspaceId) =>
  cmd(
    "Settings.StartExport",
    req(
      (c) =>
        c.reports.startExport({
          params: { workspaceId },
          headers: Api.idempotencyHeaders(`export-${Date.now()}`),
        }),
      () => Message.StartedExport(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdTransferOwnership = (workspaceId: WorkspaceId, to: UserId) =>
  cmd(
    "Settings.TransferOwnership",
    req(
      (c) => c.team.transferOwnership({ params: { workspaceId }, payload: { to } }),
      () => Message.TransferredOwnership(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdCloseWorkspace = (workspaceId: WorkspaceId, confirmName: string) =>
  cmd(
    "Settings.CloseWorkspace",
    req(
      (c) => c.workspace.close({ params: { workspaceId }, payload: { confirmName } }),
      () => Message.ClosedWorkspace(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

// --- Init ---------------------------------------------------------------------------------------

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const wsId = workspaceIdOf(ctx);
  const commands: Array<PageCommand<Message>> = [];

  let workspace: Remote.Remote<WorkspaceDetail> = Remote.idle;
  let bankAccounts: Remote.Remote<ReadonlyArray<BankAccount>> = Remote.idle;
  let branding: Remote.Remote<BrandingView> = Remote.idle;
  let series: Remote.Remote<ReadonlyArray<NumberingSeriesView>> = Remote.idle;
  let members: Remote.Remote<ReadonlyArray<MemberView>> = Remote.idle;
  let invitations: Remote.Remote<ReadonlyArray<InvitationView>> = Remote.idle;
  let apiKeys: Remote.Remote<ReadonlyArray<ApiKeyView>> = Remote.idle;
  let connectedApps: Remote.Remote<ReadonlyArray<ConnectedAppView>> = Remote.idle;

  if (route._tag === "Settings" && wsId !== undefined) {
    const s = route.section;
    if (
      s === "issuingEntity" ||
      s === "taxRegime" ||
      s === "documentDefaults" ||
      s === "reminders" ||
      s === "branding" ||
      s === "dangerZone"
    ) {
      workspace = Remote.load(workspace);
      commands.push(cmdLoadWorkspace(wsId, Remote.seqOf(workspace)));
    }
    if (s === "bankAccounts") {
      bankAccounts = Remote.load(bankAccounts);
      commands.push(cmdLoadBankAccounts(wsId, Remote.seqOf(bankAccounts)));
    }
    if (s === "branding") {
      branding = Remote.load(branding);
      commands.push(cmdLoadBranding(wsId, Remote.seqOf(branding)));
    }
    if (s === "numbering") {
      series = Remote.load(series);
      commands.push(cmdLoadSeries(wsId, Remote.seqOf(series)));
    }
    if (s === "team" || s === "dangerZone") {
      members = Remote.load(members);
      commands.push(cmdLoadMembers(wsId, Remote.seqOf(members)));
    }
    if (s === "team") {
      invitations = Remote.load(invitations);
      commands.push(cmdLoadInvitations(wsId, Remote.seqOf(invitations)));
    }
    if (s === "apiKeys") {
      apiKeys = Remote.load(apiKeys);
      commands.push(cmdLoadApiKeys(wsId, Remote.seqOf(apiKeys)));
    }
    if (s === "connectedApps") {
      connectedApps = Remote.load(connectedApps);
      commands.push(cmdLoadConnectedApps(wsId, Remote.seqOf(connectedApps)));
    }
  }

  return {
    model: {
      route,
      workspace,
      bankAccounts,
      branding,
      series,
      members,
      invitations,
      apiKeys,
      connectedApps,
      entityForm: {
        name: ctx.workspace?.name ?? "",
        ico: "",
        dic: "",
        legalForm: "",
        registerEntry: "",
        street: "",
        city: "",
        postalCode: "",
        country: "CZ",
        email: "",
        phone: "",
        web: "",
        slug: ctx.workspace?.slug ?? "",
        lookingUpAres: false,
        saving: false,
      },
      taxForm: {
        nextRegime: ctx.workspace?.taxRegime ?? "vat_payer",
        effectiveFrom: "2027-01-01",
        confirmOpen: false,
        saving: false,
      },
      bankForm: {
        editingId: null,
        name: "",
        iban: "",
        bic: "",
        currency: "CZK" as CurrencyCode,
        isDefault: false,
        saving: false,
        removingId: null,
        replacementId: "",
      },
      brandingForm: {
        pdfTemplate: "classic",
        accentColor: "#111111",
        footerText: "",
        themeChoice: "",
        themeSeed: "",
        previewLocale: ctx.locale,
        saving: false,
        uploading: null,
        previewingPdf: false,
      },
      numberingForm: {
        editingId: null,
        kind: "invoice",
        name: "",
        pattern: "YYYY-NNNN",
        nextNumber: "1",
        isDefault: false,
        saving: false,
      },
      defaultsForm: {
        currency: "CZK" as CurrencyCode,
        language: "cs",
        dueDays: "14",
        paymentMethod: "bank_transfer",
        paymentRounding: "whole_unit",
        defaultNote: "",
        paymentTaxDocumentAutoSend: true,
        saving: false,
      },
      remindersForm: {
        enabled: true,
        proformas: false,
        offsetsDays: [3, 10, 30],
        newOffset: "",
        paymentTaxDocumentAutoSend: true,
        saving: false,
      },
      teamForm: {
        inviteEmail: "",
        inviteRole: "member",
        inviting: false,
        removingUserId: null,
        confirmLeave: false,
      },
      apiKeysForm: {
        creating: false,
        name: "",
        expiresOn: "",
        accessMode: "read",
        selectedScopes: [...READ_SCOPES],
        saving: false,
        createdSecret: null,
        createdKeyName: null,
        revokingId: null,
      },
      connectedAppsForm: {
        revokingGrantId: null,
      },
      dangerForm: {
        exporting: false,
        transferToUserId: "",
        confirmTransfer: false,
        transferring: false,
        closeConfirmName: "",
        closing: false,
      },
      actionFailure: null,
    },
    commands,
  };
};

// --- Update -------------------------------------------------------------------------------------

const currentRevision = (model: Model): number =>
  Remote.dataOf(model.workspace)?.revision ?? Remote.dataOf(model.branding)?.revision ?? 1;

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const t = translator(ctx.locale);
  const wsId = workspaceIdOf(ctx);

  return Message.match(message, {
    // Loads
    GotWorkspace: ({ seq, data }) => {
      const next = Remote.succeed(model.workspace, seq, data);
      if (next._tag !== "Loaded" || next.seq !== seq)
        return { model: { ...model, workspace: next } };
      return { model: syncFormsFromWorkspace({ ...model, workspace: next }, data) };
    },
    FailedWorkspace: ({ seq, failure }) => ({
      model: { ...model, workspace: Remote.fail(model.workspace, seq, failure) },
    }),
    GotBankAccounts: ({ seq, items }) => ({
      model: { ...model, bankAccounts: Remote.succeed(model.bankAccounts, seq, items) },
    }),
    FailedBankAccounts: ({ seq, failure }) => ({
      model: { ...model, bankAccounts: Remote.fail(model.bankAccounts, seq, failure) },
    }),
    GotBranding: ({ seq, data }) => {
      const next = Remote.succeed(model.branding, seq, data);
      const themeChoice =
        data.theme === null ? "" : data.theme._tag === "Preset" ? data.theme.id : "seed";
      const themeSeed = data.theme !== null && data.theme._tag === "Seed" ? data.theme.seed : "";
      return {
        model: {
          ...model,
          branding: next,
          brandingForm: {
            ...model.brandingForm,
            pdfTemplate: data.pdfTemplate,
            accentColor: data.accentColor,
            footerText: data.footerText ?? "",
            themeChoice,
            themeSeed,
          },
        },
      };
    },
    FailedBranding: ({ seq, failure }) => ({
      model: { ...model, branding: Remote.fail(model.branding, seq, failure) },
    }),
    GotSeries: ({ seq, items }) => ({
      model: { ...model, series: Remote.succeed(model.series, seq, items) },
    }),
    FailedSeries: ({ seq, failure }) => ({
      model: { ...model, series: Remote.fail(model.series, seq, failure) },
    }),
    GotMembers: ({ seq, items }) => ({
      model: { ...model, members: Remote.succeed(model.members, seq, items) },
    }),
    FailedMembers: ({ seq, failure }) => ({
      model: { ...model, members: Remote.fail(model.members, seq, failure) },
    }),
    GotInvitations: ({ seq, items }) => ({
      model: { ...model, invitations: Remote.succeed(model.invitations, seq, items) },
    }),
    FailedInvitations: ({ seq, failure }) => ({
      model: { ...model, invitations: Remote.fail(model.invitations, seq, failure) },
    }),
    GotApiKeys: ({ seq, items }) => ({
      model: { ...model, apiKeys: Remote.succeed(model.apiKeys, seq, items) },
    }),
    FailedApiKeys: ({ seq, failure }) => ({
      model: { ...model, apiKeys: Remote.fail(model.apiKeys, seq, failure) },
    }),
    GotConnectedApps: ({ seq, items }) => ({
      model: { ...model, connectedApps: Remote.succeed(model.connectedApps, seq, items) },
    }),
    FailedConnectedApps: ({ seq, failure }) => ({
      model: { ...model, connectedApps: Remote.fail(model.connectedApps, seq, failure) },
    }),

    // Issuing Entity
    ChangedEntityField: ({ field, value }) => ({
      model: { ...model, entityForm: { ...model.entityForm, [field]: value } },
    }),
    ClickedAresLookup: () => {
      const ico = model.entityForm.ico.replace(/\s+/g, "");
      if (ico === "") return { model };
      return {
        model: {
          ...model,
          entityForm: { ...model.entityForm, lookingUpAres: true },
          actionFailure: null,
        },
        commands: [cmdLookupAres(ico)],
      };
    },
    GotAresResult: ({ result }) => ({
      model: {
        ...model,
        entityForm: {
          ...model.entityForm,
          lookingUpAres: false,
          name: result.name,
          ico: result.ico,
          dic: result.dic ?? "",
          legalForm: result.legalForm,
          registerEntry: result.registerEntry ?? "",
          street: result.address.street,
          city: result.address.city,
          postalCode: result.address.postalCode,
          country: result.address.country,
        },
      },
      outMessage: Intent_.toast(sCopy(ctx.locale, "entity.aresLoaded")),
    }),
    ClickedSaveEntity: () => {
      if (wsId === undefined) return { model };
      const f = model.entityForm;
      return {
        model: {
          ...model,
          entityForm: { ...f, saving: true },
          actionFailure: null,
        },
        commands: [
          cmdUpdateIssuingEntity(wsId, currentRevision(model), {
            name: f.name.trim(),
            ico: f.ico.trim() || null,
            dic: f.dic.trim() || null,
            legalForm: f.legalForm.trim() || null,
            registerEntry: f.registerEntry.trim() || null,
            address: {
              street: f.street.trim(),
              city: f.city.trim(),
              postalCode: f.postalCode.trim(),
              country: f.country.trim() || "CZ",
            },
            email: f.email.trim() || null,
            phone: f.phone.trim() || null,
            web: f.web.trim() || null,
          }),
        ],
      };
    },
    SavedWorkspace: ({ data }) => ({
      model: syncFormsFromWorkspace(
        {
          ...model,
          workspace: { _tag: "Loaded", seq: Remote.seqOf(model.workspace) + 1, data },
        },
        data,
      ),
      outMessage: Intent_.toast(t.t("common.toast.saved")),
    }),

    // Tax Regime
    ChangedTaxRegime: ({ regime }) => ({
      model: { ...model, taxForm: { ...model.taxForm, nextRegime: regime as TaxRegime } },
    }),
    ChangedTaxEffectiveFrom: ({ value }) => ({
      model: { ...model, taxForm: { ...model.taxForm, effectiveFrom: value } },
    }),
    ClickedAskChangeTaxRegime: () => ({
      model: { ...model, taxForm: { ...model.taxForm, confirmOpen: true } },
    }),
    ClickedCancelTaxRegime: () => ({
      model: { ...model, taxForm: { ...model.taxForm, confirmOpen: false } },
    }),
    ClickedConfirmTaxRegime: () => {
      if (wsId === undefined) return { model };
      return {
        model: {
          ...model,
          taxForm: { ...model.taxForm, confirmOpen: false, saving: true },
          actionFailure: null,
        },
        commands: [
          cmdUpdateIssuingEntity(wsId, currentRevision(model), {
            taxRegime: {
              regime: model.taxForm.nextRegime,
              effectiveFrom: model.taxForm.effectiveFrom,
            },
          }),
        ],
      };
    },

    // Bank Accounts
    ChangedBankField: ({ field, value }) => ({
      model: { ...model, bankForm: { ...model.bankForm, [field]: value } },
    }),
    ChangedBankCurrency: ({ currency }) => ({
      model: { ...model, bankForm: { ...model.bankForm, currency: currency as CurrencyCode } },
    }),
    ToggledBankDefault: ({ checked }) => ({
      model: { ...model, bankForm: { ...model.bankForm, isDefault: checked } },
    }),
    ClickedEditBank: ({ id }) => {
      const found = Remote.dataOf(model.bankAccounts)?.find((b) => b.id === id);
      if (found === undefined) return { model };
      return {
        model: {
          ...model,
          bankForm: {
            ...model.bankForm,
            editingId: found.id,
            name: found.name ?? "",
            iban: found.iban,
            bic: found.bic ?? "",
            currency: found.currency,
            isDefault: found.isDefault,
          },
        },
      };
    },
    ClickedResetBankForm: () => ({
      model: {
        ...model,
        bankForm: {
          ...model.bankForm,
          editingId: null,
          name: "",
          iban: "",
          bic: "",
          currency: "CZK" as CurrencyCode,
          isDefault: false,
        },
      },
    }),
    ClickedSaveBank: () => {
      if (wsId === undefined || model.bankForm.iban.trim() === "") return { model };
      const f = model.bankForm;
      return {
        model: { ...model, bankForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdSaveBankAccount(wsId, f.editingId, {
            name: f.name.trim() || null,
            iban: f.iban.replace(/\s+/g, "").toUpperCase(),
            bic: f.bic.trim() || null,
            currency: f.currency,
            isDefault: f.isDefault,
          }),
        ],
      };
    },
    SavedBank: ({ item }) => {
      const existing = Remote.dataOf(model.bankAccounts) ?? [];
      const exists = existing.some((b) => b.id === item.id);
      const next = exists
        ? existing.map((b) =>
            b.id === item.id
              ? item
              : item.isDefault && b.currency === item.currency
                ? { ...b, isDefault: false }
                : b,
          )
        : [
            ...(item.isDefault
              ? existing.map((b) => (b.currency === item.currency ? { ...b, isDefault: false } : b))
              : existing),
            item,
          ];
      return {
        model: {
          ...model,
          bankAccounts: { _tag: "Loaded", seq: Remote.seqOf(model.bankAccounts) + 1, data: next },
          bankForm: {
            ...model.bankForm,
            editingId: null,
            name: "",
            iban: "",
            bic: "",
            isDefault: false,
            saving: false,
          },
        },
        outMessage: Intent_.toast(t.t("common.toast.saved")),
      };
    },
    ClickedMakeBankDefault: ({ id }) => {
      if (wsId === undefined) return { model };
      const found = Remote.dataOf(model.bankAccounts)?.find((b) => b.id === id);
      if (found === undefined) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [
          cmdSaveBankAccount(wsId, found.id, {
            name: found.name,
            iban: found.iban,
            bic: found.bic,
            currency: found.currency,
            isDefault: true,
          }),
        ],
      };
    },
    ClickedAskRemoveBank: ({ id }) => ({
      model: { ...model, bankForm: { ...model.bankForm, removingId: id, replacementId: "" } },
    }),
    ChangedBankReplacement: ({ value }) => ({
      model: { ...model, bankForm: { ...model.bankForm, replacementId: value } },
    }),
    ClickedCancelRemoveBank: () => ({
      model: { ...model, bankForm: { ...model.bankForm, removingId: null, replacementId: "" } },
    }),
    ClickedConfirmRemoveBank: () => {
      if (wsId === undefined || model.bankForm.removingId === null) return { model };
      const replacement =
        model.bankForm.replacementId !== ""
          ? BankAccountId.make(model.bankForm.replacementId)
          : undefined;
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRemoveBankAccount(wsId, model.bankForm.removingId, replacement)],
      };
    },
    RemovedBank: ({ id }) => {
      const existing = Remote.dataOf(model.bankAccounts) ?? [];
      return {
        model: {
          ...model,
          bankAccounts: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.bankAccounts) + 1,
            data: existing.filter((b) => b.id !== id),
          },
          bankForm: { ...model.bankForm, removingId: null, replacementId: "" },
        },
        outMessage: Intent_.toast(t.t("common.toast.deleted")),
      };
    },

    // Branding
    SelectedPdfTemplate: ({ template }) => ({
      model: { ...model, brandingForm: { ...model.brandingForm, pdfTemplate: template } },
    }),
    ChangedAccentColor: ({ value }) => ({
      model: { ...model, brandingForm: { ...model.brandingForm, accentColor: value } },
    }),
    ChangedFooterText: ({ value }) => ({
      model: { ...model, brandingForm: { ...model.brandingForm, footerText: value } },
    }),
    SelectedWorkspaceTheme: ({ choice }) => ({
      model: { ...model, brandingForm: { ...model.brandingForm, themeChoice: choice } },
    }),
    ChangedWorkspaceThemeSeed: ({ value }) => ({
      model: {
        ...model,
        brandingForm: { ...model.brandingForm, themeChoice: "seed", themeSeed: value },
      },
    }),
    SelectedPreviewLocale: ({ locale }) => ({
      model: { ...model, brandingForm: { ...model.brandingForm, previewLocale: locale } },
    }),
    SelectedBrandingImage: ({ kind, file }) => {
      if (wsId === undefined) return { model };
      return {
        model: {
          ...model,
          brandingForm: { ...model.brandingForm, uploading: kind },
          actionFailure: null,
        },
        commands: [cmdUploadBrandingImage(wsId, kind, file)],
      };
    },
    UploadedBrandingImage: ({ kind, ref }) => {
      const current = Remote.dataOf(model.branding);
      return {
        model: {
          ...model,
          brandingForm: { ...model.brandingForm, uploading: null },
          ...(current !== undefined
            ? {
                branding: {
                  _tag: "Loaded" as const,
                  seq: Remote.seqOf(model.branding) + 1,
                  data: { ...current, [kind]: ref as ImageRef },
                },
              }
            : {}),
        },
        outMessage: Intent_.toast(
          sCopy(ctx.locale, kind === "logo" ? "branding.logoUploaded" : "branding.stampUploaded"),
        ),
      };
    },
    ClickedRemoveBrandingImage: ({ kind }) => {
      if (wsId === undefined) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRemoveBrandingImage(wsId, kind)],
      };
    },
    RemovedBrandingImage: ({ kind }) => {
      const current = Remote.dataOf(model.branding);
      return {
        model: {
          ...model,
          ...(current !== undefined
            ? {
                branding: {
                  _tag: "Loaded" as const,
                  seq: Remote.seqOf(model.branding) + 1,
                  data: { ...current, [kind]: null },
                },
              }
            : {}),
        },
        outMessage: Intent_.toast(t.t("common.toast.deleted")),
      };
    },
    ClickedSaveBranding: () => {
      if (wsId === undefined) return { model };
      const f = model.brandingForm;
      let theme: ThemeSource | null = null;
      if (f.themeChoice === "seed") {
        const hex = f.themeSeed.trim().toUpperCase();
        if (Theme.isHex(hex)) theme = { _tag: "Seed", seed: hex };
      } else if (Theme.PRESET_IDS.includes(f.themeChoice as ThemePresetId)) {
        theme = { _tag: "Preset", id: f.themeChoice as ThemePresetId };
      }
      const accent = Theme.isHex(f.accentColor.trim()) ? f.accentColor.trim() : "#111111";
      return {
        model: { ...model, brandingForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdUpdateBranding(wsId, currentRevision(model), {
            pdfTemplate: f.pdfTemplate,
            accentColor: accent,
            footerText: f.footerText.trim() || null,
            theme,
          }),
        ],
      };
    },
    SavedBranding: ({ data }) => ({
      model: {
        ...model,
        branding: { _tag: "Loaded", seq: Remote.seqOf(model.branding) + 1, data },
        brandingForm: { ...model.brandingForm, saving: false },
      },
      outMessage: Intent_.toast(t.t("common.toast.saved")),
    }),
    ClickedPreviewPdf: () => {
      if (wsId === undefined) return { model };
      const f = model.brandingForm;
      return {
        model: { ...model, brandingForm: { ...f, previewingPdf: true }, actionFailure: null },
        commands: [
          cmdPreviewPdf(
            wsId,
            f.pdfTemplate,
            Theme.isHex(f.accentColor.trim()) ? f.accentColor.trim() : "#111111",
            f.footerText.trim() || null,
            f.previewLocale,
          ),
        ],
      };
    },
    FinishedPreviewPdf: () => ({
      model: { ...model, brandingForm: { ...model.brandingForm, previewingPdf: false } },
      outMessage: Intent_.toast(sCopy(ctx.locale, "branding.previewReady")),
    }),

    // Numbering Series
    ChangedSeriesKind: ({ kind }) => ({
      model: { ...model, numberingForm: { ...model.numberingForm, kind: kind as DocumentKind } },
    }),
    ChangedSeriesField: ({ field, value }) => ({
      model: { ...model, numberingForm: { ...model.numberingForm, [field]: value } },
    }),
    ClickedInsertToken: ({ token }) => ({
      model: {
        ...model,
        numberingForm: {
          ...model.numberingForm,
          pattern: `${model.numberingForm.pattern}${token}`,
        },
      },
    }),
    ToggledSeriesDefault: ({ checked }) => ({
      model: { ...model, numberingForm: { ...model.numberingForm, isDefault: checked } },
    }),
    ClickedEditSeries: ({ id }) => {
      const found = Remote.dataOf(model.series)?.find((s) => s.id === id);
      if (found === undefined) return { model };
      return {
        model: {
          ...model,
          numberingForm: {
            ...model.numberingForm,
            editingId: found.id,
            kind: found.kind,
            name: found.name,
            pattern: found.pattern,
            nextNumber: String(found.nextCounter),
            isDefault: found.isDefault,
          },
        },
      };
    },
    ClickedResetSeriesForm: () => ({
      model: {
        ...model,
        numberingForm: {
          ...model.numberingForm,
          editingId: null,
          name: "",
          pattern: "YYYY-NNNN",
          nextNumber: "1",
          isDefault: false,
        },
      },
    }),
    ClickedSaveSeries: () => {
      if (wsId === undefined) return { model };
      const f = model.numberingForm;
      if (f.name.trim() === "" || f.pattern.trim() === "") return { model };
      const parsedNext = Number.parseInt(f.nextNumber, 10);
      return {
        model: { ...model, numberingForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdSaveSeries(wsId, f.editingId, {
            kind: f.kind,
            name: f.name.trim(),
            pattern: f.pattern.trim(),
            ...(Number.isInteger(parsedNext) && parsedNext >= 1 ? { nextNumber: parsedNext } : {}),
            isDefault: f.isDefault,
          }),
        ],
      };
    },
    SavedSeries: ({ item }) => {
      const existing = Remote.dataOf(model.series) ?? [];
      const exists = existing.some((s) => s.id === item.id);
      const next = exists
        ? existing.map((s) =>
            s.id === item.id
              ? item
              : item.isDefault && s.kind === item.kind
                ? { ...s, isDefault: false }
                : s,
          )
        : [
            ...(item.isDefault
              ? existing.map((s) => (s.kind === item.kind ? { ...s, isDefault: false } : s))
              : existing),
            item,
          ];
      return {
        model: {
          ...model,
          series: { _tag: "Loaded", seq: Remote.seqOf(model.series) + 1, data: next },
          numberingForm: {
            ...model.numberingForm,
            editingId: null,
            name: "",
            pattern: "YYYY-NNNN",
            nextNumber: "1",
            isDefault: false,
            saving: false,
          },
        },
        outMessage: Intent_.toast(t.t("common.toast.saved")),
      };
    },
    ClickedMakeSeriesDefault: ({ id }) => {
      if (wsId === undefined) return { model };
      const found = Remote.dataOf(model.series)?.find((s) => s.id === id);
      if (found === undefined) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [
          cmdSaveSeries(wsId, found.id, {
            kind: found.kind,
            name: found.name,
            pattern: found.pattern,
            isDefault: true,
          }),
        ],
      };
    },

    // Document Defaults
    ChangedDefaultCurrency: ({ currency }) => ({
      model: {
        ...model,
        defaultsForm: { ...model.defaultsForm, currency: currency as CurrencyCode },
      },
    }),
    ChangedDefaultLanguage: ({ language }) => ({
      model: { ...model, defaultsForm: { ...model.defaultsForm, language } },
    }),
    ChangedDefaultDueDays: ({ value }) => ({
      model: { ...model, defaultsForm: { ...model.defaultsForm, dueDays: value } },
    }),
    ChangedDefaultPaymentMethod: ({ method }) => ({
      model: {
        ...model,
        defaultsForm: { ...model.defaultsForm, paymentMethod: method as PaymentMethod },
      },
    }),
    ChangedDefaultRounding: ({ rounding }) => ({
      model: {
        ...model,
        defaultsForm: { ...model.defaultsForm, paymentRounding: rounding as PaymentRounding },
      },
    }),
    ChangedDefaultNote: ({ value }) => ({
      model: { ...model, defaultsForm: { ...model.defaultsForm, defaultNote: value } },
    }),
    ToggledDefaultAutoSendPtd: ({ checked }) => ({
      model: {
        ...model,
        defaultsForm: { ...model.defaultsForm, paymentTaxDocumentAutoSend: checked },
      },
    }),
    ClickedSaveDefaults: () => {
      if (wsId === undefined) return { model };
      const f = model.defaultsForm;
      const dueDays = Math.max(0, Math.min(365, Number.parseInt(f.dueDays, 10) || 14));
      return {
        model: { ...model, defaultsForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdUpdateSettings(wsId, currentRevision(model), {
            defaults: {
              currency: f.currency,
              language: f.language,
              dueDays,
              paymentMethod: f.paymentMethod,
              paymentRounding: f.paymentRounding,
              defaultNote: f.defaultNote.trim() || null,
              paymentTaxDocumentAutoSend: f.paymentTaxDocumentAutoSend,
            },
          }),
        ],
      };
    },

    // Reminders
    ToggledRemindersEnabled: ({ checked }) => ({
      model: { ...model, remindersForm: { ...model.remindersForm, enabled: checked } },
    }),
    ToggledRemindersProformas: ({ checked }) => ({
      model: { ...model, remindersForm: { ...model.remindersForm, proformas: checked } },
    }),
    ChangedNewReminderOffset: ({ value }) => ({
      model: { ...model, remindersForm: { ...model.remindersForm, newOffset: value } },
    }),
    ClickedAddReminderOffset: () => {
      const day = Number.parseInt(model.remindersForm.newOffset, 10);
      if (!Number.isInteger(day) || day < 1 || day > 365) return { model };
      if (model.remindersForm.offsetsDays.length >= 10) return { model };
      if (model.remindersForm.offsetsDays.includes(day)) {
        return { model: { ...model, remindersForm: { ...model.remindersForm, newOffset: "" } } };
      }
      const next = [...model.remindersForm.offsetsDays, day].sort((a, b) => a - b);
      return {
        model: {
          ...model,
          remindersForm: { ...model.remindersForm, offsetsDays: next, newOffset: "" },
        },
      };
    },
    ClickedRemoveReminderOffset: ({ day }) => ({
      model: {
        ...model,
        remindersForm: {
          ...model.remindersForm,
          offsetsDays: model.remindersForm.offsetsDays.filter((d) => d !== day),
        },
      },
    }),
    ToggledRemindersAutoSendPtd: ({ checked }) => ({
      model: {
        ...model,
        remindersForm: { ...model.remindersForm, paymentTaxDocumentAutoSend: checked },
      },
    }),
    ClickedSaveReminders: () => {
      if (wsId === undefined) return { model };
      const f = model.remindersForm;
      return {
        model: { ...model, remindersForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdUpdateSettings(wsId, currentRevision(model), {
            reminderPolicy: {
              enabled: f.enabled,
              proformas: f.proformas,
              offsetsDays: [...f.offsetsDays],
            },
            defaults: {
              paymentTaxDocumentAutoSend: f.paymentTaxDocumentAutoSend,
            },
          }),
        ],
      };
    },

    // Team
    ChangedInviteEmail: ({ value }) => ({
      model: { ...model, teamForm: { ...model.teamForm, inviteEmail: value } },
    }),
    ChangedInviteRole: ({ role }) => ({
      model: { ...model, teamForm: { ...model.teamForm, inviteRole: role } },
    }),
    ClickedSendInvite: () => {
      if (wsId === undefined || !model.teamForm.inviteEmail.includes("@")) return { model };
      return {
        model: {
          ...model,
          teamForm: { ...model.teamForm, inviting: true },
          actionFailure: null,
        },
        commands: [
          cmdInviteMember(wsId, model.teamForm.inviteEmail.trim(), model.teamForm.inviteRole),
        ],
      };
    },
    SentInvite: ({ item }) => {
      const existing = Remote.dataOf(model.invitations) ?? [];
      return {
        model: {
          ...model,
          invitations: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.invitations) + 1,
            data: [item, ...existing],
          },
          teamForm: { ...model.teamForm, inviting: false, inviteEmail: "" },
        },
        outMessage: Intent_.toast(t.t("settings.team.inviteSent", { email: item.email })),
      };
    },
    ClickedResendInvite: ({ id }) => {
      if (wsId === undefined) return { model };
      return { model: { ...model, actionFailure: null }, commands: [cmdResendInvite(wsId, id)] };
    },
    ResentInvite: () => ({
      model,
      outMessage: Intent_.toast(sCopy(ctx.locale, "team.invitationResent")),
    }),
    ClickedRevokeInvite: ({ id }) => {
      if (wsId === undefined) return { model };
      return { model: { ...model, actionFailure: null }, commands: [cmdRevokeInvite(wsId, id)] };
    },
    RevokedInvite: ({ id }) => {
      const existing = Remote.dataOf(model.invitations) ?? [];
      return {
        model: {
          ...model,
          invitations: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.invitations) + 1,
            data: existing.filter((i) => i.id !== id),
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "team.invitationRevoked")),
      };
    },
    ChangedMemberRole: ({ userId, role }) => {
      if (wsId === undefined) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdSetMemberRole(wsId, userId, role)],
      };
    },
    UpdatedMemberRole: ({ userId, role }) => {
      const existing = Remote.dataOf(model.members) ?? [];
      return {
        model: {
          ...model,
          members: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.members) + 1,
            data: existing.map((m) => (m.userId === userId ? { ...m, role } : m)),
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "team.roleChanged")),
      };
    },
    ClickedAskRemoveMember: ({ userId }) => ({
      model: { ...model, teamForm: { ...model.teamForm, removingUserId: userId } },
    }),
    ClickedCancelRemoveMember: () => ({
      model: { ...model, teamForm: { ...model.teamForm, removingUserId: null } },
    }),
    ClickedConfirmRemoveMember: () => {
      if (wsId === undefined || model.teamForm.removingUserId === null) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRemoveMember(wsId, model.teamForm.removingUserId)],
      };
    },
    RemovedMember: ({ userId }) => {
      const existing = Remote.dataOf(model.members) ?? [];
      return {
        model: {
          ...model,
          members: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.members) + 1,
            data: existing.filter((m) => m.userId !== userId),
          },
          teamForm: { ...model.teamForm, removingUserId: null },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "team.memberRemoved")),
      };
    },
    ClickedAskLeave: () => ({
      model: { ...model, teamForm: { ...model.teamForm, confirmLeave: true } },
    }),
    ClickedCancelLeave: () => ({
      model: { ...model, teamForm: { ...model.teamForm, confirmLeave: false } },
    }),
    ClickedConfirmLeave: () => {
      if (wsId === undefined) return { model };
      return {
        model: {
          ...model,
          teamForm: { ...model.teamForm, confirmLeave: false },
          actionFailure: null,
        },
        commands: [cmdLeaveWorkspace(wsId)],
      };
    },
    LeftWorkspace: () => ({
      model,
      outMessage: Intent_.reloadSession(),
    }),

    // API Keys + 10-area Granular Scope Matrix
    ClickedToggleCreateApiKey: () => ({
      model: {
        ...model,
        apiKeysForm: {
          ...model.apiKeysForm,
          creating: !model.apiKeysForm.creating,
          name: "",
          expiresOn: "",
        },
      },
    }),
    ChangedApiKeyName: ({ value }) => ({
      model: { ...model, apiKeysForm: { ...model.apiKeysForm, name: value } },
    }),
    ChangedApiKeyExpires: ({ value }) => ({
      model: { ...model, apiKeysForm: { ...model.apiKeysForm, expiresOn: value } },
    }),
    SelectedApiKeyPreset: ({ preset }) => {
      const next = ViewModels.ScopePicker.choosePreset(scopePickerFromModel(model, ctx), preset);
      return {
        model: {
          ...model,
          apiKeysForm: {
            ...model.apiKeysForm,
            accessMode: next.mode,
            selectedScopes: [...ViewModels.effectiveScopes(next)],
          },
        },
      };
    },
    SelectedApiKeyCustom: () => {
      const next = ViewModels.ScopePicker.chooseCustom(scopePickerFromModel(model, ctx));
      return {
        model: {
          ...model,
          apiKeysForm: {
            ...model.apiKeysForm,
            accessMode: next.mode,
            selectedScopes: [...ViewModels.effectiveScopes(next)],
          },
        },
      };
    },
    ToggledApiKeyScope: ({ scope }) => {
      const next = ViewModels.ScopePicker.toggle(scopePickerFromModel(model, ctx), scope as Scope);
      return {
        model: {
          ...model,
          apiKeysForm: {
            ...model.apiKeysForm,
            accessMode: next.mode,
            selectedScopes: [...ViewModels.effectiveScopes(next)],
          },
        },
      };
    },
    ClickedCreateApiKey: () => {
      if (wsId === undefined || model.apiKeysForm.name.trim() === "") return { model };
      const picker = scopePickerFromModel(model, ctx);
      if (Option.isNone(ViewModels.toAccessRequest(picker))) return { model };
      const expiresOn = model.apiKeysForm.expiresOn.trim() || undefined;
      return {
        model: {
          ...model,
          apiKeysForm: { ...model.apiKeysForm, saving: true },
          actionFailure: null,
        },
        commands: [cmdCreateApiKey(wsId, model.apiKeysForm.name.trim(), expiresOn, picker)],
      };
    },
    CreatedApiKey: ({ created }) => {
      const existing = Remote.dataOf(model.apiKeys) ?? [];
      return {
        model: {
          ...model,
          apiKeys: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.apiKeys) + 1,
            data: [created.key, ...existing],
          },
          apiKeysForm: {
            ...model.apiKeysForm,
            creating: false,
            saving: false,
            name: "",
            expiresOn: "",
            createdSecret: created.secret,
            createdKeyName: created.key.name,
          },
        },
      };
    },
    ClickedCopyApiKeySecret: () => {
      const secret = model.apiKeysForm.createdSecret;
      if (secret === null) return { model };
      return { model, commands: [cmdCopySecret(secret)] };
    },
    CopiedApiKeySecret: () => ({
      model,
      outMessage: Intent_.toast(sCopy(ctx.locale, "api.copied")),
    }),
    ClickedDismissApiKeySecret: () => ({
      model: {
        ...model,
        apiKeysForm: { ...model.apiKeysForm, createdSecret: null, createdKeyName: null },
      },
    }),
    ClickedAskRevokeApiKey: ({ id }) => ({
      model: { ...model, apiKeysForm: { ...model.apiKeysForm, revokingId: id } },
    }),
    ClickedCancelRevokeApiKey: () => ({
      model: { ...model, apiKeysForm: { ...model.apiKeysForm, revokingId: null } },
    }),
    ClickedConfirmRevokeApiKey: () => {
      if (wsId === undefined || model.apiKeysForm.revokingId === null) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRevokeApiKey(wsId, model.apiKeysForm.revokingId)],
      };
    },
    RevokedApiKey: ({ id }) => {
      const existing = Remote.dataOf(model.apiKeys) ?? [];
      return {
        model: {
          ...model,
          apiKeys: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.apiKeys) + 1,
            data: existing.filter((k) => k.id !== id),
          },
          apiKeysForm: { ...model.apiKeysForm, revokingId: null },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "api.revoked")),
      };
    },

    // Connected Apps
    ClickedAskRevokeApp: ({ grantId }) => ({
      model: { ...model, connectedAppsForm: { revokingGrantId: grantId } },
    }),
    ClickedCancelRevokeApp: () => ({
      model: { ...model, connectedAppsForm: { revokingGrantId: null } },
    }),
    ClickedConfirmRevokeApp: () => {
      if (wsId === undefined || model.connectedAppsForm.revokingGrantId === null) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRevokeConnectedApp(wsId, model.connectedAppsForm.revokingGrantId)],
      };
    },
    RevokedApp: ({ grantId }) => {
      const existing = Remote.dataOf(model.connectedApps) ?? [];
      return {
        model: {
          ...model,
          connectedApps: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.connectedApps) + 1,
            data: existing.filter((g) => g.grantId !== grantId),
          },
          connectedAppsForm: { revokingGrantId: null },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "mcp.revoked")),
      };
    },

    // Danger Zone
    ClickedStartExport: () => {
      if (wsId === undefined) return { model };
      return {
        model: {
          ...model,
          dangerForm: { ...model.dangerForm, exporting: true },
          actionFailure: null,
        },
        commands: [cmdStartExport(wsId)],
      };
    },
    StartedExport: () => ({
      model: { ...model, dangerForm: { ...model.dangerForm, exporting: false } },
      outMessage: Intent_.toast(sCopy(ctx.locale, "danger.exportStarted")),
    }),
    ChangedTransferTarget: ({ userId }) => ({
      model: { ...model, dangerForm: { ...model.dangerForm, transferToUserId: userId } },
    }),
    ClickedAskTransfer: () => ({
      model: { ...model, dangerForm: { ...model.dangerForm, confirmTransfer: true } },
    }),
    ClickedCancelTransfer: () => ({
      model: { ...model, dangerForm: { ...model.dangerForm, confirmTransfer: false } },
    }),
    ClickedConfirmTransfer: () => {
      if (wsId === undefined || model.dangerForm.transferToUserId === "") return { model };
      return {
        model: {
          ...model,
          dangerForm: { ...model.dangerForm, confirmTransfer: false, transferring: true },
          actionFailure: null,
        },
        commands: [cmdTransferOwnership(wsId, UserId.make(model.dangerForm.transferToUserId))],
      };
    },
    TransferredOwnership: () => ({
      model: {
        ...model,
        dangerForm: { ...model.dangerForm, transferring: false, transferToUserId: "" },
      },
      outMessage: Intent_.reloadSession(),
    }),
    ChangedCloseConfirm: ({ value }) => ({
      model: { ...model, dangerForm: { ...model.dangerForm, closeConfirmName: value } },
    }),
    ClickedCloseWorkspace: () => {
      if (wsId === undefined || ctx.workspace === null) return { model };
      if (model.dangerForm.closeConfirmName.trim() !== ctx.workspace.name) return { model };
      return {
        model: {
          ...model,
          dangerForm: { ...model.dangerForm, closing: true },
          actionFailure: null,
        },
        commands: [cmdCloseWorkspace(wsId, model.dangerForm.closeConfirmName.trim())],
      };
    },
    ClosedWorkspace: () => ({
      model: { ...model, dangerForm: { ...model.dangerForm, closing: false } },
      outMessage: Intent_.navigate(
        ctx.workspace !== null ? href({ _tag: "Dashboard", ws: ctx.workspace.slug }) : "/",
        true,
      ),
    }),

    // Shared
    FailedAction: ({ failure }) => ({
      model: {
        ...model,
        entityForm: { ...model.entityForm, lookingUpAres: false, saving: false },
        taxForm: { ...model.taxForm, saving: false },
        bankForm: { ...model.bankForm, saving: false },
        brandingForm: {
          ...model.brandingForm,
          saving: false,
          uploading: null,
          previewingPdf: false,
        },
        numberingForm: { ...model.numberingForm, saving: false },
        defaultsForm: { ...model.defaultsForm, saving: false },
        remindersForm: { ...model.remindersForm, saving: false },
        teamForm: { ...model.teamForm, inviting: false },
        apiKeysForm: { ...model.apiKeysForm, saving: false },
        dangerForm: { ...model.dangerForm, exporting: false, transferring: false, closing: false },
        actionFailure: failure,
      },
    }),

    ClickedRetry: () =>
      model.route._tag === "Settings" || model.route._tag === "More"
        ? init(model.route, ctx)
        : { model },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

// --- Title & View -------------------------------------------------------------------------------

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  if (model.route._tag === "More") return sCopy(ctx.locale, "more.title");
  if (model.route._tag === "Settings") {
    return `${t.t("settings.title")} · ${t.t(`settings.nav.${model.route.section}`)}`;
  }
  return t.t("settings.title");
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) =>
  viewSettingsPage(model, ctx, h);
