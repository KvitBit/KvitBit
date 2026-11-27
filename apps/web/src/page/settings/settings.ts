/**
 * Workspace Settings & Mobile More Hub (Screens 18–21, routes `Settings` | `More`).
 * Covers all 11 settings sections: issuingEntity, taxRegime, bankAccounts, branding, numbering,
 * documentDefaults, reminders, team, apiKeys, connectedApps, dangerZone, plus Mobile More hub.
 * Contract: src/app/page.ts.
 */
import {
  type ApiKeyId,
  type ApiKeyView,
  type BrandingView,
  type ConnectedAppView,
  READ_SCOPES,
  ThemePresetId,
  type ThemeSource,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  BankAccountInput,
  CurrencyCode,
  type DocumentKind,
  ImageRef,
  type InvitationId,
  type InvitationView,
  IsoDate,
  IssuingEntityPatch,
  type Locale,
  type MemberView,
  type NumberingSeriesId,
  type NumberingSeriesView,
  type PdfTemplate,
  type Role,
  UserId,
  WorkspaceId,
  type WorkspaceSettingsPatch,
} from "@kvitbit/domain";
import { Api, Theme, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  type Client,
  type Failure,
  failureFromUnknown,
  request,
  type WebServices,
} from "../../app/api";
import { browserOrigin, fetchBrowserOk, writeClipboard } from "../../app/browser";
import type { PageCommand } from "../../app/commands";
import { apiCommand as cmd } from "../../app/commands";
import { translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { sCopy } from "./copy";
import { BankAccount, WorkspaceDetail } from "./models";

import { Message, type Model, type Route, scopePickerFromModel } from "./state";

export { Message, Model, Route, SETTINGS_SECTIONS, scopePickerFromModel } from "./state";
export { viewSettingsPage as view } from "./views";

const parseWorkspaceDetail = Schema.decodeUnknownOption(WorkspaceDetail);
const parseBankAccount = Schema.decodeUnknownOption(BankAccount);
const parseBankAccounts = Fn.compose(
  BankAccount.pipe(Schema.Array, Schema.decodeUnknownOption),
  Option.getOrElse(() => []),
);

const workspaceIdOf = (ctx: PageContext): WorkspaceId | undefined =>
  ctx.workspace !== null ? WorkspaceId.make(ctx.workspace.id) : undefined;

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
    Message,
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
    Message,
    "Settings.LoadBankAccounts",
    req(
      (c) => c.workspace.listBankAccounts({ params: { workspaceId } }),
      (raw) => Message.GotBankAccounts({ seq, items: parseBankAccounts(raw) }),
      (failure) => Message.FailedBankAccounts({ seq, failure }),
    ),
  );

const cmdLoadBranding = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadBranding",
    req(
      (c) => c.branding.getBranding({ params: { workspaceId } }),
      (data) => Message.GotBranding({ seq, data }),
      (failure) => Message.FailedBranding({ seq, failure }),
    ),
  );

const cmdLoadSeries = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadSeries",
    req(
      (c) => c.workspace.listSeries({ params: { workspaceId } }),
      (items) => Message.GotSeries({ seq, items }),
      (failure) => Message.FailedSeries({ seq, failure }),
    ),
  );

const cmdLoadMembers = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadMembers",
    req(
      (c) => c.team.listMembers({ params: { workspaceId } }),
      (items) => Message.GotMembers({ seq, items }),
      (failure) => Message.FailedMembers({ seq, failure }),
    ),
  );

const cmdLoadInvitations = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadInvitations",
    req(
      (c) => c.team.listInvitations({ params: { workspaceId } }),
      (items) => Message.GotInvitations({ seq, items }),
      (failure) => Message.FailedInvitations({ seq, failure }),
    ),
  );

const cmdLoadApiKeys = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadApiKeys",
    req(
      (c) => c.apiKeys.listApiKeys({ params: { workspaceId } }),
      (items) => Message.GotApiKeys({ seq, items }),
      (failure) => Message.FailedApiKeys({ seq, failure }),
    ),
  );

const cmdLoadConnectedApps = (workspaceId: WorkspaceId, seq: number) =>
  cmd(
    Message,
    "Settings.LoadConnectedApps",
    req(
      (c) => c.connectedApps.listConnectedApps({ params: { workspaceId } }),
      (items) => Message.GotConnectedApps({ seq, items }),
      (failure) => Message.FailedConnectedApps({ seq, failure }),
    ),
  );

const cmdLookupAres = (ico: string) =>
  cmd(
    Message,
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
  payload: Schema.JsonObject,
) =>
  cmd(
    Message,
    "Settings.UpdateIssuingEntity",
    req(
      (c) =>
        c.workspace.updateIssuingEntity({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload: IssuingEntityPatch.make(payload),
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
  payload: WorkspaceSettingsPatch,
) =>
  cmd(
    Message,
    "Settings.UpdateSettings",
    req(
      (c) =>
        c.workspace.updateSettings({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload,
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
  payload: Schema.JsonObject,
) =>
  cmd(
    Message,
    "Settings.SaveBankAccount",
    req(
      (c) =>
        editingId === null
          ? Effect.flatMap(Api.uuidV7, (key) =>
              c.workspace.createBankAccount({
                params: { workspaceId },
                headers: Api.idempotencyHeaders(key),
                payload: BankAccountInput.make(payload),
              }),
            )
          : c.workspace.updateBankAccount({
              params: { workspaceId, bankAccountId: editingId },
              payload: BankAccountInput.make(payload),
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
    Message,
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
    Message,
    "Settings.UpdateBranding",
    req(
      (c) =>
        c.branding.updateBranding({
          params: { workspaceId },
          headers: Api.ifMatchHeaders(revision),
          payload,
        }),
      (data) => Message.SavedBranding({ data }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const decodeImage = HttpClientResponse.schemaBodyJson(ImageRef);

const cmdUploadBrandingImage = (workspaceId: WorkspaceId, kind: "logo" | "stamp", file: File) =>
  cmd(
    Message,
    "Settings.UploadBrandingImage",
    Effect.suspend(() => {
      const form = new FormData();
      form.append("file", file);
      const url = `${browserOrigin()}/api/v1/workspaces/${workspaceId}/branding/${kind}`;
      return fetchBrowserOk(
        HttpClientRequest.put(url).pipe(HttpClientRequest.bodyFormData(form)),
      ).pipe(
        Effect.flatMap(decodeImage),
        Effect.match({
          onSuccess: (ref) => Message.UploadedBrandingImage({ kind, ref }),
          onFailure: (error) => Message.FailedAction({ failure: failureFromUnknown(error) }),
        }),
      );
    }),
  );

const cmdRemoveBrandingImage = (workspaceId: WorkspaceId, kind: "logo" | "stamp") =>
  cmd(
    Message,
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
    Message,
    "Settings.PreviewPdf",
    req(
      (c) =>
        c.branding.previewPdf({
          params: { workspaceId },
          payload: {
            branding: { pdfTemplate, accentColor, footerText },
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
    Message,
    "Settings.SaveSeries",
    req(
      (c) =>
        editingId === null
          ? Effect.flatMap(Api.uuidV7, (key) =>
              c.workspace.createSeries({
                params: { workspaceId },
                headers: Api.idempotencyHeaders(key),
                payload,
              }),
            )
          : c.workspace.updateSeries({
              params: { workspaceId, seriesId: editingId },
              payload,
            }),
      (item) => Message.SavedSeries({ item }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdInviteMember = (workspaceId: WorkspaceId, email: string, role: Exclude<Role, "owner">) =>
  cmd(
    Message,
    "Settings.InviteMember",
    req(
      (c) =>
        Effect.flatMap(Api.uuidV7, (key) =>
          c.team.invite({
            params: { workspaceId },
            headers: Api.idempotencyHeaders(key),
            payload: { email, role },
          }),
        ),
      (item) => Message.SentInvite({ item }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdResendInvite = (workspaceId: WorkspaceId, invitationId: InvitationId) =>
  cmd(
    Message,
    "Settings.ResendInvite",
    req(
      (c) => c.team.resendInvitation({ params: { workspaceId, invitationId } }),
      () => Message.ResentInvite(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRevokeInvite = (workspaceId: WorkspaceId, invitationId: InvitationId) =>
  cmd(
    Message,
    "Settings.RevokeInvite",
    req(
      (c) => c.team.revokeInvitation({ params: { workspaceId, invitationId } }),
      () => Message.RevokedInvite({ id: invitationId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdSetMemberRole = (workspaceId: WorkspaceId, userId: UserId, role: Exclude<Role, "owner">) =>
  cmd(
    Message,
    "Settings.SetMemberRole",
    req(
      (c) => c.team.setRole({ params: { workspaceId, userId }, payload: { role } }),
      () => Message.UpdatedMemberRole({ userId, role }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRemoveMember = (workspaceId: WorkspaceId, userId: UserId) =>
  cmd(
    Message,
    "Settings.RemoveMember",
    req(
      (c) => c.team.removeMember({ params: { workspaceId, userId } }),
      () => Message.RemovedMember({ userId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdLeaveWorkspace = (workspaceId: WorkspaceId) =>
  cmd(
    Message,
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
    return cmd(
      Message,
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
          name,
          expiresOn: expiresOn === undefined ? undefined : IsoDate.make(expiresOn),
          access: "custom" as const,
          scopes: reqOpt.value.scopes,
        }
      : {
          name,
          expiresOn: expiresOn === undefined ? undefined : IsoDate.make(expiresOn),
          access: reqOpt.value.access,
        };
  return cmd(
    Message,
    "Settings.CreateApiKey",
    req(
      (c) => c.apiKeys.createApiKey({ params: { workspaceId }, payload }),
      (created) => Message.CreatedApiKey({ created }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );
};

const cmdCopySecret = (secret: string) =>
  cmd(
    Message,
    "Settings.CopyCredential",
    writeClipboard(secret).pipe(Effect.as(Message.CopiedApiKeySecret())),
  );

const cmdRevokeApiKey = (workspaceId: WorkspaceId, keyId: ApiKeyId) =>
  cmd(
    Message,
    "Settings.RevokeApiKey",
    req(
      (c) => c.apiKeys.revokeApiKey({ params: { workspaceId, keyId } }),
      () => Message.RevokedApiKey({ id: keyId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdRevokeConnectedApp = (workspaceId: WorkspaceId, grantId: string) =>
  cmd(
    Message,
    "Settings.RevokeConnectedApp",
    req(
      (c) => c.connectedApps.revokeConnectedApp({ params: { workspaceId, grantId } }),
      () => Message.RevokedApp({ grantId }),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdStartExport = (workspaceId: WorkspaceId) =>
  cmd(
    Message,
    "Settings.StartExport",
    req(
      (c) =>
        Effect.flatMap(Api.uuidV7, (key) =>
          c.reports.startExport({
            params: { workspaceId },
            headers: Api.idempotencyHeaders(key),
          }),
        ),
      () => Message.StartedExport(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdTransferOwnership = (workspaceId: WorkspaceId, to: UserId) =>
  cmd(
    Message,
    "Settings.TransferOwnership",
    req(
      (c) => c.team.transferOwnership({ params: { workspaceId }, payload: { to } }),
      () => Message.TransferredOwnership(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

const cmdCloseWorkspace = (workspaceId: WorkspaceId, confirmName: string) =>
  cmd(
    Message,
    "Settings.CloseWorkspace",
    req(
      (c) => c.workspace.close({ params: { workspaceId }, payload: { confirmName } }),
      () => Message.ClosedWorkspace(),
      (failure) => Message.FailedAction({ failure }),
    ),
  );

// --- Init ---------------------------------------------------------------------------------------

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
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
        currency: CurrencyCode.make("CZK"),
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
        currency: CurrencyCode.make("CZK"),
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
});

// --- Update -------------------------------------------------------------------------------------

const currentRevision = (model: Model): number =>
  Remote.dataOf(model.workspace)?.revision ?? Remote.dataOf(model.branding)?.revision ?? 1;

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> => {
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
      const ico = Str.replace(/\s+/g, "")(model.entityForm.ico);
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
            name: Str.trim(f.name),
            ico: Str.trim(f.ico) || null,
            dic: Str.trim(f.dic) || null,
            legalForm: Str.trim(f.legalForm) || null,
            registerEntry: Str.trim(f.registerEntry) || null,
            address: {
              street: Str.trim(f.street),
              city: Str.trim(f.city),
              postalCode: Str.trim(f.postalCode),
              country: Str.trim(f.country) || "CZ",
            },
            email: Str.trim(f.email) || null,
            phone: Str.trim(f.phone) || null,
            web: Str.trim(f.web) || null,
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
      model: { ...model, taxForm: { ...model.taxForm, nextRegime: regime } },
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
      model: { ...model, bankForm: { ...model.bankForm, currency } },
    }),
    ToggledBankDefault: ({ checked }) => ({
      model: { ...model, bankForm: { ...model.bankForm, isDefault: checked } },
    }),
    ClickedEditBank: ({ id }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(Remote.dataOf(model.bankAccounts) ?? [], (b) => b.id === id),
      );
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
          currency: CurrencyCode.make("CZK"),
          isDefault: false,
        },
      },
    }),
    ClickedSaveBank: () => {
      if (wsId === undefined || Str.trim(model.bankForm.iban) === "") return { model };
      const f = model.bankForm;
      return {
        model: { ...model, bankForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdSaveBankAccount(wsId, f.editingId, {
            name: Str.trim(f.name) || null,
            iban: Str.toUpperCase(Str.replace(/\s+/g, "")(f.iban)),
            bic: Str.trim(f.bic) || null,
            currency: f.currency,
            isDefault: f.isDefault,
          }),
        ],
      };
    },
    SavedBank: ({ item }) => {
      const existing = Remote.dataOf(model.bankAccounts) ?? [];
      const exists = Arr.some(existing, (b) => b.id === item.id);
      const next = exists
        ? Arr.map(existing, (b) =>
            b.id === item.id
              ? item
              : item.isDefault && b.currency === item.currency
                ? { ...b, isDefault: false }
                : b,
          )
        : [
            ...(item.isDefault
              ? Arr.map(existing, (b) =>
                  b.currency === item.currency ? { ...b, isDefault: false } : b,
                )
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
      const found = Option.getOrUndefined(
        Arr.findFirst(Remote.dataOf(model.bankAccounts) ?? [], (b) => b.id === id),
      );
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
            data: Arr.filter(existing, (b) => b.id !== id),
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
          branding:
            current === undefined
              ? model.branding
              : {
                  _tag: "Loaded",
                  seq: Remote.seqOf(model.branding) + 1,
                  data: { ...current, [kind]: ref },
                },
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
          branding:
            current === undefined
              ? model.branding
              : {
                  _tag: "Loaded",
                  seq: Remote.seqOf(model.branding) + 1,
                  data: { ...current, [kind]: null },
                },
        },
        outMessage: Intent_.toast(t.t("common.toast.deleted")),
      };
    },
    ClickedSaveBranding: () => {
      if (wsId === undefined) return { model };
      const f = model.brandingForm;
      let theme: ThemeSource | null = null;
      if (f.themeChoice === "seed") {
        const hex = Str.toUpperCase(Str.trim(f.themeSeed));
        if (Theme.isHex(hex)) theme = { _tag: "Seed", seed: hex };
      } else if (Schema.is(ThemePresetId)(f.themeChoice)) {
        theme = { _tag: "Preset", id: f.themeChoice };
      }
      const accent = Theme.isHex(Str.trim(f.accentColor)) ? Str.trim(f.accentColor) : "#111111";
      return {
        model: { ...model, brandingForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdUpdateBranding(wsId, currentRevision(model), {
            pdfTemplate: f.pdfTemplate,
            accentColor: accent,
            footerText: Str.trim(f.footerText) || null,
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
            Theme.isHex(Str.trim(f.accentColor)) ? Str.trim(f.accentColor) : "#111111",
            Str.trim(f.footerText) || null,
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
      model: { ...model, numberingForm: { ...model.numberingForm, kind } },
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
      const found = Option.getOrUndefined(
        Arr.findFirst(Remote.dataOf(model.series) ?? [], (s) => s.id === id),
      );
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
      if (Str.trim(f.name) === "" || Str.trim(f.pattern) === "") return { model };
      const parsedNext = Number.parseInt(f.nextNumber, 10);
      const nextNumber =
        Number.isInteger(parsedNext) && parsedNext >= 1 ? { nextNumber: parsedNext } : undefined;
      return {
        model: { ...model, numberingForm: { ...f, saving: true }, actionFailure: null },
        commands: [
          cmdSaveSeries(wsId, f.editingId, {
            kind: f.kind,
            name: Str.trim(f.name),
            pattern: Str.trim(f.pattern),
            ...nextNumber,
            isDefault: f.isDefault,
          }),
        ],
      };
    },
    SavedSeries: ({ item }) => {
      const existing = Remote.dataOf(model.series) ?? [];
      const exists = Arr.some(existing, (s) => s.id === item.id);
      const next = exists
        ? Arr.map(existing, (s) =>
            s.id === item.id
              ? item
              : item.isDefault && s.kind === item.kind
                ? { ...s, isDefault: false }
                : s,
          )
        : [
            ...(item.isDefault
              ? Arr.map(existing, (s) => (s.kind === item.kind ? { ...s, isDefault: false } : s))
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
      const found = Option.getOrUndefined(
        Arr.findFirst(Remote.dataOf(model.series) ?? [], (s) => s.id === id),
      );
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
        defaultsForm: { ...model.defaultsForm, currency },
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
        defaultsForm: { ...model.defaultsForm, paymentMethod: method },
      },
    }),
    ChangedDefaultRounding: ({ rounding }) => ({
      model: {
        ...model,
        defaultsForm: { ...model.defaultsForm, paymentRounding: rounding },
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
              defaultNote: Str.trim(f.defaultNote) || null,
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
          offsetsDays: Arr.filter(model.remindersForm.offsetsDays, (d) => d !== day),
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
      if (wsId === undefined || !Str.includes("@")(model.teamForm.inviteEmail)) return { model };
      return {
        model: {
          ...model,
          teamForm: { ...model.teamForm, inviting: true },
          actionFailure: null,
        },
        commands: [
          cmdInviteMember(wsId, Str.trim(model.teamForm.inviteEmail), model.teamForm.inviteRole),
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
            data: Arr.filter(existing, (i) => i.id !== id),
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
            data: Arr.map(existing, (m) => (m.userId === userId ? { ...m, role } : m)),
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
            data: Arr.filter(existing, (m) => m.userId !== userId),
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
      const next = ViewModels.ScopePicker.toggle(scopePickerFromModel(model, ctx), scope);
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
      if (wsId === undefined || Str.trim(model.apiKeysForm.name) === "") return { model };
      const picker = scopePickerFromModel(model, ctx);
      if (Option.isNone(ViewModels.toAccessRequest(picker))) return { model };
      const expiresOn = Str.trim(model.apiKeysForm.expiresOn) || undefined;
      return {
        model: {
          ...model,
          apiKeysForm: { ...model.apiKeysForm, saving: true },
          actionFailure: null,
        },
        commands: [cmdCreateApiKey(wsId, Str.trim(model.apiKeysForm.name), expiresOn, picker)],
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
            data: Arr.filter(existing, (k) => k.id !== id),
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
            data: Arr.filter(existing, (g) => g.grantId !== grantId),
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
      if (Str.trim(model.dangerForm.closeConfirmName) !== ctx.workspace.name) return { model };
      return {
        model: {
          ...model,
          dangerForm: { ...model.dangerForm, closing: true },
          actionFailure: null,
        },
        commands: [cmdCloseWorkspace(wsId, Str.trim(model.dangerForm.closeConfirmName))],
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
});

// --- Title & View -------------------------------------------------------------------------------

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  if (model.route._tag === "More") return sCopy(ctx.locale, "more.title");
  if (model.route._tag === "Settings") {
    return `${t.t("settings.title")} · ${t.t(`settings.nav.${model.route.section}`)}`;
  }
  return t.t("settings.title");
});
