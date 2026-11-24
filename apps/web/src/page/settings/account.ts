/**
 * Account & Security Settings page (Screen 22, route `Account`).
 * Tabs: profile, appearance, security (passkeys + password), sessions, danger (soft-delete).
 * Contract: src/app/page.ts.
 */
import {
  AccountPreferences,
  type AccountPreferencesPatch,
  type ThemeContrast,
  type ThemeMode,
  type ThemePresetId,
  type ThemeSource,
  type ThemeStyle,
} from "@kvitbit/api-contract";
import { Api, I18n, Theme, ViewModels } from "@kvitbit/ui-port";
import { Option, Schema } from "effect";
import { type Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { authFetch, Failure, request, type WebServices } from "../../app/api";
import { textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import type { Locale, Prefs, ThemeChoice } from "../../app/prefs";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  dialog,
  emptyState,
  page,
  pageHeader,
  segmented,
  skeleton,
  table,
  tabs,
  textField,
} from "../../ui/kit";
import { sCopy } from "./copy";
import { cmd, PasskeyItem, SessionItem } from "./models";

export type Route = RouteOf<"Account">;
export type AccountTab = Route["tab"];

const ACCOUNT_TABS: ReadonlyArray<AccountTab> = [
  "profile",
  "appearance",
  "security",
  "sessions",
  "danger",
];

const ProfileForm = Schema.Struct({
  name: Schema.String,
  newEmail: Schema.String,
  savingProfile: Schema.Boolean,
  savingEmail: Schema.Boolean,
  emailSentTo: Schema.NullOr(Schema.String),
});

const AppearanceState = Schema.Struct({
  seedInput: Schema.String,
  seedError: Schema.NullOr(Schema.String),
  saving: Schema.Boolean,
  dirty: Schema.Boolean,
});

const SecurityState = Schema.Struct({
  passkeys: Remote.remoteSchema(Schema.Array(PasskeyItem)),
  newPasskeyName: Schema.String,
  addingPasskey: Schema.Boolean,
  renamingId: Schema.NullOr(Schema.String),
  renameValue: Schema.String,
  removingId: Schema.NullOr(Schema.String),
  currentPassword: Schema.String,
  newPassword: Schema.String,
  confirmPassword: Schema.String,
  signOutOthers: Schema.Boolean,
  passwordError: Schema.NullOr(Schema.String),
  savingPassword: Schema.Boolean,
  hasPassword: Schema.Boolean,
});

const SessionsState = Schema.Struct({
  list: Remote.remoteSchema(Schema.Array(SessionItem)),
  revokingId: Schema.NullOr(Schema.String),
  revokingOthers: Schema.Boolean,
});

const DangerState = Schema.Struct({
  confirmText: Schema.String,
  deleting: Schema.Boolean,
});

export const Model = Schema.Struct({
  route: ViewModels.Route,
  preferences: Remote.remoteSchema(AccountPreferences),
  profile: ProfileForm,
  appearance: AppearanceState,
  security: SecurityState,
  sessions: SessionsState,
  danger: DangerState,
  actionFailure: Schema.NullOr(Failure),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  // Preferences
  GotPreferences: { seq: Remote.Seq, data: AccountPreferences },
  FailedPreferences: { seq: Remote.Seq, failure: Failure },
  ClickedSaveAppearance: {},
  SavedPreferences: { data: AccountPreferences },
  FailedSavePreferences: { failure: Failure },
  // Profile
  ChangedName: { value: Schema.String },
  ChangedLocale: { locale: Schema.Literals(["cs", "en"]) },
  ClickedSaveProfile: {},
  SavedProfile: {},
  FailedAction: { failure: Failure },
  ChangedNewEmail: { value: Schema.String },
  ClickedChangeEmail: {},
  SentEmailChange: { email: Schema.String },
  // Appearance
  SelectedPreset: { preset: Schema.Literals(Theme.PRESET_IDS) },
  ChangedSeedInput: { value: Schema.String },
  ClickedApplySeed: {},
  SelectedStyle: { style: Schema.Literals(["elegant", "cozy"]) },
  SelectedMode: { mode: Schema.Literals(["system", "light", "dark"]) },
  SelectedContrast: { contrast: Schema.Literals(["standard", "medium", "high"]) },
  // Security: Passkeys
  GotPasskeys: { seq: Remote.Seq, items: Schema.Array(PasskeyItem) },
  FailedPasskeys: { seq: Remote.Seq, failure: Failure },
  ChangedNewPasskeyName: { value: Schema.String },
  ClickedAddPasskey: {},
  AddedPasskey: { item: PasskeyItem },
  ClickedStartRenamePasskey: { id: Schema.String, currentName: Schema.String },
  ChangedRenamePasskey: { value: Schema.String },
  ClickedConfirmRenamePasskey: {},
  ClickedCancelRenamePasskey: {},
  RenamedPasskey: { id: Schema.String, name: Schema.String },
  ClickedAskRemovePasskey: { id: Schema.String },
  ClickedCancelRemovePasskey: {},
  ClickedConfirmRemovePasskey: {},
  RemovedPasskey: { id: Schema.String },
  // Security: Password
  ChangedCurrentPassword: { value: Schema.String },
  ChangedNewPassword: { value: Schema.String },
  ChangedConfirmPassword: { value: Schema.String },
  ToggledSignOutOthers: { checked: Schema.Boolean },
  ClickedChangePassword: {},
  ChangedPasswordOk: {},
  // Sessions
  GotSessions: { seq: Remote.Seq, items: Schema.Array(SessionItem) },
  FailedSessions: { seq: Remote.Seq, failure: Failure },
  ClickedRevokeSession: { id: Schema.String },
  RevokedSession: { id: Schema.String },
  ClickedRevokeOtherSessions: {},
  RevokedOtherSessions: {},
  // Danger
  ChangedDeleteConfirm: { value: Schema.String },
  ClickedDeleteAccount: {},
  DeletedAccount: {},
  // Common
  ClickedRetry: {},
});
export type Message = typeof Message.Type;

// --- Commands -----------------------------------------------------------------------------------

const cmdLoadPreferences = (seq: number) =>
  cmd(
    "Account.LoadPreferences",
    request(
      (c) => c.me.getPreferences(),
      (data): Message => Message.GotPreferences({ seq, data }),
      (failure): Message => Message.FailedPreferences({ seq, failure }),
    ),
  );

const toThemeSource = (choice: ThemeChoice): ThemeSource =>
  choice._tag === "Preset" ? { _tag: "Preset", id: choice.id } : { _tag: "Seed", seed: choice.hex };

const cmdSavePreferences = (prefs: Prefs, revision: number) => {
  const payload: AccountPreferencesPatch = {
    locale: prefs.locale,
    theme: {
      mode: prefs.mode,
      style: prefs.style,
      contrast: prefs.contrast,
      dynamicColor: false,
      source: toThemeSource(prefs.theme),
    },
  };
  return cmd(
    "Account.SavePreferences",
    request(
      (c) => c.me.updatePreferences({ headers: Api.ifMatchHeaders(revision), payload }),
      (data): Message => Message.SavedPreferences({ data }),
      (failure): Message => Message.FailedSavePreferences({ failure }),
    ),
  );
};

const decodePasskeys = Schema.decodeUnknownOption(Schema.Array(PasskeyItem));
const decodePasskey = Schema.decodeUnknownOption(PasskeyItem);
const decodeSessions = Schema.decodeUnknownOption(Schema.Array(SessionItem));

const cmdLoadPasskeys = (seq: number) =>
  cmd(
    "Account.LoadPasskeys",
    authFetch(
      "/passkey/list-user-passkeys",
      { method: "GET" },
      (json): Message => {
        const raw =
          typeof json === "object" && json !== null && "passkeys" in json
            ? (json as { passkeys: unknown }).passkeys
            : json;
        return Message.GotPasskeys({
          seq,
          items: Option.getOrElse(decodePasskeys(raw), () => []),
        });
      },
      (failure): Message => Message.FailedPasskeys({ seq, failure }),
    ),
  );

const cmdAddPasskey = (name: string) =>
  cmd(
    "Account.AddPasskey",
    authFetch(
      "/passkey/add-passkey",
      { method: "POST", body: { name } },
      (json): Message => {
        const parsed = Option.getOrElse(decodePasskey(json), () => ({
          id: `pk-${Date.now()}`,
          name,
          createdAt: new Date().toISOString().slice(0, 10),
          deviceType: "platform",
        }));
        return Message.AddedPasskey({ item: parsed });
      },
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdRenamePasskey = (id: string, name: string) =>
  cmd(
    "Account.RenamePasskey",
    authFetch(
      "/passkey/update-passkey",
      { method: "POST", body: { id, name } },
      (): Message => Message.RenamedPasskey({ id, name }),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdDeletePasskey = (id: string) =>
  cmd(
    "Account.DeletePasskey",
    authFetch(
      "/passkey/delete-passkey",
      { method: "POST", body: { id } },
      (): Message => Message.RemovedPasskey({ id }),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdUpdateProfile = (name: string) =>
  cmd(
    "Account.UpdateProfile",
    authFetch(
      "/update-user",
      { method: "POST", body: { name } },
      (): Message => Message.SavedProfile(),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdChangeEmail = (newEmail: string) =>
  cmd(
    "Account.ChangeEmail",
    authFetch(
      "/change-email",
      { method: "POST", body: { newEmail } },
      (): Message => Message.SentEmailChange({ email: newEmail }),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdChangePassword = (
  currentPassword: string,
  newPassword: string,
  revokeOtherSessions: boolean,
) =>
  cmd(
    "Account.ChangePassword",
    authFetch(
      "/change-password",
      { method: "POST", body: { currentPassword, newPassword, revokeOtherSessions } },
      (): Message => Message.ChangedPasswordOk(),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdLoadSessions = (seq: number) =>
  cmd(
    "Account.LoadSessions",
    authFetch(
      "/list-sessions",
      { method: "GET" },
      (json): Message => {
        const raw =
          typeof json === "object" && json !== null && "sessions" in json
            ? (json as { sessions: unknown }).sessions
            : json;
        return Message.GotSessions({
          seq,
          items: Option.getOrElse(decodeSessions(raw), () => []),
        });
      },
      (failure): Message => Message.FailedSessions({ seq, failure }),
    ),
  );

const cmdRevokeSession = (id: string) =>
  cmd(
    "Account.RevokeSession",
    authFetch(
      "/revoke-session",
      { method: "POST", body: { id } },
      (): Message => Message.RevokedSession({ id }),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdRevokeOtherSessions = () =>
  cmd(
    "Account.RevokeOtherSessions",
    authFetch(
      "/revoke-other-sessions",
      { method: "POST", body: {} },
      (): Message => Message.RevokedOtherSessions(),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

const cmdDeleteAccount = () =>
  cmd(
    "Account.DeleteAccount",
    authFetch(
      "/delete-user",
      { method: "POST", body: {} },
      (): Message => Message.DeletedAccount(),
      (failure): Message => Message.FailedAction({ failure }),
    ),
  );

// --- Init ---------------------------------------------------------------------------------------

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const userName = ctx.session._tag === "SignedIn" ? ctx.session.user.name : "";
  const seedInput = ctx.prefs.theme._tag === "Seed" ? ctx.prefs.theme.hex : "";
  const commands: Array<Command.Command<Message, never, WebServices>> = [];

  let preferences: Remote.Remote<AccountPreferences> = Remote.idle;
  let passkeys: Remote.Remote<ReadonlyArray<PasskeyItem>> = Remote.idle;
  let sessions: Remote.Remote<ReadonlyArray<SessionItem>> = Remote.idle;

  if (route.tab === "profile" || route.tab === "appearance") {
    preferences = Remote.load(preferences);
    commands.push(cmdLoadPreferences(Remote.seqOf(preferences)));
  } else if (route.tab === "security") {
    passkeys = Remote.load(passkeys);
    commands.push(cmdLoadPasskeys(Remote.seqOf(passkeys)));
  } else if (route.tab === "sessions") {
    sessions = Remote.load(sessions);
    commands.push(cmdLoadSessions(Remote.seqOf(sessions)));
  }

  return {
    model: {
      route,
      preferences,
      profile: {
        name: userName,
        newEmail: "",
        savingProfile: false,
        savingEmail: false,
        emailSentTo: null,
      },
      appearance: {
        seedInput,
        seedError: null,
        saving: false,
        dirty: false,
      },
      security: {
        passkeys,
        newPasskeyName: "",
        addingPasskey: false,
        renamingId: null,
        renameValue: "",
        removingId: null,
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
        signOutOthers: true,
        passwordError: null,
        savingPassword: false,
        hasPassword: true,
      },
      sessions: {
        list: sessions,
        revokingId: null,
        revokingOthers: false,
      },
      danger: {
        confirmText: "",
        deleting: false,
      },
      actionFailure: null,
    },
    commands,
  };
};

// --- Update -------------------------------------------------------------------------------------

const currentRevision = (model: Model): number => Remote.dataOf(model.preferences)?.revision ?? 1;

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const t = translator(ctx.locale);

  return Message.match<PageReturn<Model, Message>>(message, {
    GotPreferences: ({ seq, data }) => ({
      model: { ...model, preferences: Remote.succeed(model.preferences, seq, data) },
    }),
    FailedPreferences: ({ seq, failure }) => ({
      model: { ...model, preferences: Remote.fail(model.preferences, seq, failure) },
    }),
    ClickedSaveAppearance: () => ({
      model: {
        ...model,
        appearance: { ...model.appearance, saving: true },
        actionFailure: null,
      },
      commands: [cmdSavePreferences(ctx.prefs, currentRevision(model))],
    }),
    SavedPreferences: ({ data }) => ({
      model: {
        ...model,
        preferences: { _tag: "Loaded", seq: Remote.seqOf(model.preferences) + 1, data },
        appearance: { ...model.appearance, saving: false, dirty: false },
      },
      outMessage: Intent_.toast(sCopy(ctx.locale, "account.appearance.saved")),
    }),
    FailedSavePreferences: ({ failure }) => ({
      model: {
        ...model,
        appearance: { ...model.appearance, saving: false },
        actionFailure: failure,
      },
    }),

    // Profile
    ChangedName: ({ value }) => ({
      model: { ...model, profile: { ...model.profile, name: value } },
    }),
    ChangedLocale: ({ locale }) => {
      const nextPrefs: Prefs = { ...ctx.prefs, locale };
      return {
        model,
        commands: [cmdSavePreferences(nextPrefs, currentRevision(model))],
        outMessage: Intent_.setPrefs(nextPrefs),
      };
    },
    ClickedSaveProfile: () => {
      const trimmed = model.profile.name.trim();
      if (trimmed === "") return { model };
      return {
        model: {
          ...model,
          profile: { ...model.profile, savingProfile: true },
          actionFailure: null,
        },
        commands: [cmdUpdateProfile(trimmed)],
      };
    },
    SavedProfile: () => ({
      model: { ...model, profile: { ...model.profile, savingProfile: false } },
      outMessage: Intent_.reloadSession(),
    }),
    ChangedNewEmail: ({ value }) => ({
      model: { ...model, profile: { ...model.profile, newEmail: value } },
    }),
    ClickedChangeEmail: () => {
      const trimmed = model.profile.newEmail.trim();
      if (!trimmed.includes("@")) return { model };
      return {
        model: {
          ...model,
          profile: { ...model.profile, savingEmail: true },
          actionFailure: null,
        },
        commands: [cmdChangeEmail(trimmed)],
      };
    },
    SentEmailChange: ({ email }) => ({
      model: {
        ...model,
        profile: { ...model.profile, savingEmail: false, newEmail: "", emailSentTo: email },
      },
      outMessage: Intent_.toast(t.t("account.profile.emailChangeSent", { email })),
    }),

    // Appearance (live preview via Intent_.setPrefs)
    SelectedPreset: ({ preset }) => {
      const nextPrefs: Prefs = {
        ...ctx.prefs,
        theme: { _tag: "Preset", id: preset as ThemePresetId },
      };
      return {
        model: {
          ...model,
          appearance: { ...model.appearance, seedError: null, dirty: true },
        },
        outMessage: Intent_.setPrefs(nextPrefs),
      };
    },
    ChangedSeedInput: ({ value }) => ({
      model: {
        ...model,
        appearance: { ...model.appearance, seedInput: value, seedError: null },
      },
    }),
    ClickedApplySeed: () => {
      const raw = model.appearance.seedInput.trim();
      const normalized = raw.startsWith("#") ? raw.toUpperCase() : `#${raw.toUpperCase()}`;
      if (!Theme.isHex(normalized)) {
        return {
          model: {
            ...model,
            appearance: {
              ...model.appearance,
              seedError: sCopy(ctx.locale, "account.appearance.seedInvalid"),
            },
          },
        };
      }
      const nextPrefs: Prefs = {
        ...ctx.prefs,
        theme: { _tag: "Seed", hex: normalized },
      };
      return {
        model: {
          ...model,
          appearance: {
            ...model.appearance,
            seedInput: normalized,
            seedError: null,
            dirty: true,
          },
        },
        outMessage: Intent_.setPrefs(nextPrefs),
      };
    },
    SelectedStyle: ({ style }) => ({
      model: { ...model, appearance: { ...model.appearance, dirty: true } },
      outMessage: Intent_.setPrefs({ ...ctx.prefs, style: style as ThemeStyle }),
    }),
    SelectedMode: ({ mode }) => ({
      model: { ...model, appearance: { ...model.appearance, dirty: true } },
      outMessage: Intent_.setPrefs({ ...ctx.prefs, mode: mode as ThemeMode }),
    }),
    SelectedContrast: ({ contrast }) => ({
      model: { ...model, appearance: { ...model.appearance, dirty: true } },
      outMessage: Intent_.setPrefs({ ...ctx.prefs, contrast: contrast as ThemeContrast }),
    }),

    // Security: Passkeys
    GotPasskeys: ({ seq, items }) => ({
      model: {
        ...model,
        security: {
          ...model.security,
          passkeys: Remote.succeed(model.security.passkeys, seq, items),
        },
      },
    }),
    FailedPasskeys: ({ seq, failure }) => ({
      model: {
        ...model,
        security: {
          ...model.security,
          passkeys: Remote.fail(model.security.passkeys, seq, failure),
        },
      },
    }),
    ChangedNewPasskeyName: ({ value }) => ({
      model: { ...model, security: { ...model.security, newPasskeyName: value } },
    }),
    ClickedAddPasskey: () => {
      const name = model.security.newPasskeyName.trim() || "Passkey";
      return {
        model: {
          ...model,
          security: { ...model.security, addingPasskey: true },
          actionFailure: null,
        },
        commands: [cmdAddPasskey(name)],
      };
    },
    AddedPasskey: ({ item }) => {
      const existing = Remote.dataOf(model.security.passkeys) ?? [];
      return {
        model: {
          ...model,
          security: {
            ...model.security,
            addingPasskey: false,
            newPasskeyName: "",
            passkeys: {
              _tag: "Loaded",
              seq: Remote.seqOf(model.security.passkeys) + 1,
              data: [...existing, item],
            },
          },
        },
        outMessage: Intent_.toast(t.t("account.security.passkeyAdded")),
      };
    },
    ClickedStartRenamePasskey: ({ id, currentName }) => ({
      model: {
        ...model,
        security: { ...model.security, renamingId: id, renameValue: currentName },
      },
    }),
    ChangedRenamePasskey: ({ value }) => ({
      model: { ...model, security: { ...model.security, renameValue: value } },
    }),
    ClickedCancelRenamePasskey: () => ({
      model: { ...model, security: { ...model.security, renamingId: null, renameValue: "" } },
    }),
    ClickedConfirmRenamePasskey: () => {
      const id = model.security.renamingId;
      const name = model.security.renameValue.trim();
      if (id === null || name === "") return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdRenamePasskey(id, name)],
      };
    },
    RenamedPasskey: ({ id, name }) => {
      const existing = Remote.dataOf(model.security.passkeys) ?? [];
      return {
        model: {
          ...model,
          security: {
            ...model.security,
            renamingId: null,
            renameValue: "",
            passkeys: {
              _tag: "Loaded",
              seq: Remote.seqOf(model.security.passkeys) + 1,
              data: existing.map((p) => (p.id === id ? { ...p, name } : p)),
            },
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.security.passkeyRenamed")),
      };
    },
    ClickedAskRemovePasskey: ({ id }) => ({
      model: { ...model, security: { ...model.security, removingId: id } },
    }),
    ClickedCancelRemovePasskey: () => ({
      model: { ...model, security: { ...model.security, removingId: null } },
    }),
    ClickedConfirmRemovePasskey: () => {
      const id = model.security.removingId;
      if (id === null) return { model };
      return {
        model: { ...model, actionFailure: null },
        commands: [cmdDeletePasskey(id)],
      };
    },
    RemovedPasskey: ({ id }) => {
      const existing = Remote.dataOf(model.security.passkeys) ?? [];
      return {
        model: {
          ...model,
          security: {
            ...model.security,
            removingId: null,
            passkeys: {
              _tag: "Loaded",
              seq: Remote.seqOf(model.security.passkeys) + 1,
              data: existing.filter((p) => p.id !== id),
            },
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.security.passkeyRemoved")),
      };
    },

    // Security: Password
    ChangedCurrentPassword: ({ value }) => ({
      model: {
        ...model,
        security: { ...model.security, currentPassword: value, passwordError: null },
      },
    }),
    ChangedNewPassword: ({ value }) => ({
      model: {
        ...model,
        security: { ...model.security, newPassword: value, passwordError: null },
      },
    }),
    ChangedConfirmPassword: ({ value }) => ({
      model: {
        ...model,
        security: { ...model.security, confirmPassword: value, passwordError: null },
      },
    }),
    ToggledSignOutOthers: ({ checked }) => ({
      model: { ...model, security: { ...model.security, signOutOthers: checked } },
    }),
    ClickedChangePassword: () => {
      if (model.security.newPassword.length < 12) {
        return {
          model: {
            ...model,
            security: {
              ...model.security,
              passwordError: sCopy(ctx.locale, "account.security.passwordTooShort"),
            },
          },
        };
      }
      if (model.security.newPassword !== model.security.confirmPassword) {
        return {
          model: {
            ...model,
            security: {
              ...model.security,
              passwordError: sCopy(ctx.locale, "account.security.passwordMismatch"),
            },
          },
        };
      }
      return {
        model: {
          ...model,
          security: { ...model.security, savingPassword: true, passwordError: null },
          actionFailure: null,
        },
        commands: [
          cmdChangePassword(
            model.security.currentPassword,
            model.security.newPassword,
            model.security.signOutOthers,
          ),
        ],
      };
    },
    ChangedPasswordOk: () => ({
      model: {
        ...model,
        security: {
          ...model.security,
          savingPassword: false,
          currentPassword: "",
          newPassword: "",
          confirmPassword: "",
          hasPassword: true,
        },
      },
      outMessage: Intent_.toast(t.t("account.security.passwordChanged")),
    }),

    // Sessions
    GotSessions: ({ seq, items }) => ({
      model: {
        ...model,
        sessions: { ...model.sessions, list: Remote.succeed(model.sessions.list, seq, items) },
      },
    }),
    FailedSessions: ({ seq, failure }) => ({
      model: {
        ...model,
        sessions: { ...model.sessions, list: Remote.fail(model.sessions.list, seq, failure) },
      },
    }),
    ClickedRevokeSession: ({ id }) => ({
      model: {
        ...model,
        sessions: { ...model.sessions, revokingId: id },
        actionFailure: null,
      },
      commands: [cmdRevokeSession(id)],
    }),
    RevokedSession: ({ id }) => {
      const existing = Remote.dataOf(model.sessions.list) ?? [];
      return {
        model: {
          ...model,
          sessions: {
            ...model.sessions,
            revokingId: null,
            list: {
              _tag: "Loaded",
              seq: Remote.seqOf(model.sessions.list) + 1,
              data: existing.filter((s) => s.id !== id),
            },
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.sessions.revoked")),
      };
    },
    ClickedRevokeOtherSessions: () => ({
      model: {
        ...model,
        sessions: { ...model.sessions, revokingOthers: true },
        actionFailure: null,
      },
      commands: [cmdRevokeOtherSessions()],
    }),
    RevokedOtherSessions: () => {
      const existing = Remote.dataOf(model.sessions.list) ?? [];
      return {
        model: {
          ...model,
          sessions: {
            ...model.sessions,
            revokingOthers: false,
            list: {
              _tag: "Loaded",
              seq: Remote.seqOf(model.sessions.list) + 1,
              data: existing.filter((s) => s.current),
            },
          },
        },
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.sessions.othersRevoked")),
      };
    },

    // Danger
    ChangedDeleteConfirm: ({ value }) => ({
      model: { ...model, danger: { ...model.danger, confirmText: value } },
    }),
    ClickedDeleteAccount: () => {
      const phrase = t.t("account.danger.confirmPhrase");
      if (model.danger.confirmText.trim() !== phrase) return { model };
      return {
        model: {
          ...model,
          danger: { ...model.danger, deleting: true },
          actionFailure: null,
        },
        commands: [cmdDeleteAccount()],
      };
    },
    DeletedAccount: () => ({
      model: { ...model, danger: { ...model.danger, deleting: false } },
      outMessage: Intent_.signedOut(),
    }),

    FailedAction: ({ failure }) => ({
      model: {
        ...model,
        profile: { ...model.profile, savingProfile: false, savingEmail: false },
        security: { ...model.security, addingPasskey: false, savingPassword: false },
        sessions: { ...model.sessions, revokingId: null, revokingOthers: false },
        danger: { ...model.danger, deleting: false },
        actionFailure: failure,
      },
    }),

    ClickedRetry: () => (model.route._tag === "Account" ? init(model.route, ctx) : { model }),
  });
};

// --- Title --------------------------------------------------------------------------------------

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  if (model.route._tag !== "Account") return t.t("account.title");
  return `${t.t("account.title")} · ${sCopy(ctx.locale, `account.nav.${model.route.tab}`)}`;
};

// --- View ---------------------------------------------------------------------------------------

const tabLabel = (locale: Locale, tab: AccountTab): string => sCopy(locale, `account.nav.${tab}`);

const viewProfile = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const t = translator(ctx.locale);
  const currentEmail = ctx.session._tag === "SignedIn" ? ctx.session.user.email : "";

  return h.div(
    [h.Class("kb-stack")],
    [
      card(h, [
        cardTitle(h, t.t("account.profile.title")),
        h.div(
          [h.Class("kb-form-grid")],
          [
            textField(h, {
              id: "kb-account-name",
              label: t.t("account.profile.name"),
              value: model.profile.name,
              onInput: (value) => Message.ChangedName({ value }),
              autocomplete: "name",
            }),
            h.div(
              [h.Class("kb-field")],
              [
                h.span([h.Class("kb-field__label")], [t.t("account.profile.language")]),
                segmented(h, {
                  label: t.t("account.profile.language"),
                  selected: ctx.prefs.locale,
                  items: [
                    { id: "cs", label: "Čeština" },
                    { id: "en", label: "English" },
                  ],
                  onSelect: (id) => Message.ChangedLocale({ locale: id === "en" ? "en" : "cs" }),
                }),
              ],
            ),
          ],
        ),
        h.div(
          [h.Class("kb-row")],
          [
            button(h, {
              label: sCopy(ctx.locale, "account.profile.save"),
              variant: "primary",
              busy: model.profile.savingProfile,
              onClick: Message.ClickedSaveProfile(),
            }),
          ],
        ),
      ]),
      card(h, [
        cardTitle(h, t.t("account.profile.email")),
        h.p([h.Class("kb-muted")], [currentEmail]),
        ...(model.profile.emailSentTo !== null
          ? [
              banner(h, {
                tone: "info",
                text: t.t("account.profile.emailChangeSent", { email: model.profile.emailSentTo }),
              }),
            ]
          : []),
        h.div(
          [h.Class("kb-ares-row")],
          [
            textField(h, {
              id: "kb-account-new-email",
              label: sCopy(ctx.locale, "account.profile.newEmail"),
              type: "email",
              value: model.profile.newEmail,
              onInput: (value) => Message.ChangedNewEmail({ value }),
              autocomplete: "email",
            }),
            button(h, {
              label: t.t("account.profile.changeEmail"),
              busy: model.profile.savingEmail,
              onClick: Message.ClickedChangeEmail(),
            }),
          ],
        ),
      ]),
    ],
  );
};

const viewAppearance = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const t = translator(ctx.locale);
  const activePreset = ctx.prefs.theme._tag === "Preset" ? ctx.prefs.theme.id : null;

  return h.div(
    [h.Class("kb-settings-grid")],
    [
      card(h, [
        cardTitle(h, t.t("account.appearance.title"), [
          button(h, {
            label: sCopy(ctx.locale, "account.appearance.savePrefs"),
            variant: "primary",
            busy: model.appearance.saving,
            onClick: Message.ClickedSaveAppearance(),
          }),
        ]),
        ...(model.appearance.dirty
          ? [banner(h, { tone: "info", text: t.t("account.appearance.unsaved") })]
          : []),
        h.div(
          [h.Class("kb-section")],
          [
            h.h3([], [t.t("account.appearance.presets")]),
            h.div(
              [h.Class("kb-preset-grid")],
              Theme.PRESET_IDS.map((id) => {
                const def = Theme.PresetDefinitions[id];
                return h.button(
                  [
                    h.Type("button"),
                    h.Class("kb-preset-card"),
                    h.AriaPressed(activePreset === id ? "true" : "false"),
                    h.DataAttribute("preset", id),
                    h.OnClick(Message.SelectedPreset({ preset: id })),
                  ],
                  [
                    h.span(
                      [h.Class("kb-preset-swatch"), h.Style({ "--kb-swatch-color": def.seed })],
                      [],
                    ),
                    h.span([], [t.translate(Theme.presetNameText(id))]),
                  ],
                );
              }),
            ),
          ],
        ),
        h.div(
          [h.Class("kb-ares-row")],
          [
            textField(h, {
              id: "kb-account-seed",
              label: t.t("account.appearance.seed"),
              hint: t.t("account.appearance.seedHint"),
              placeholder: sCopy(ctx.locale, "account.appearance.seedPlaceholder"),
              value: model.appearance.seedInput,
              error: model.appearance.seedError ?? undefined,
              mono: true,
              onInput: (value) => Message.ChangedSeedInput({ value }),
            }),
            button(h, {
              label: sCopy(ctx.locale, "account.appearance.applySeed"),
              onClick: Message.ClickedApplySeed(),
            }),
          ],
        ),
        h.div(
          [h.Class("kb-form-grid")],
          [
            h.div(
              [h.Class("kb-field")],
              [
                h.span([h.Class("kb-field__label")], [t.t("account.appearance.style")]),
                segmented(h, {
                  label: t.t("account.appearance.style"),
                  selected: ctx.prefs.style,
                  items: (["elegant", "cozy"] as const).map((s) => ({
                    id: s,
                    label: t.translate(Theme.styleNameText(s)),
                  })),
                  onSelect: (id) =>
                    Message.SelectedStyle({ style: id === "cozy" ? "cozy" : "elegant" }),
                }),
                h.span(
                  [h.Class("kb-field__hint")],
                  [t.translate(I18n.enumText("themeStyleHint", ctx.prefs.style))],
                ),
              ],
            ),
            h.div(
              [h.Class("kb-field")],
              [
                h.span([h.Class("kb-field__label")], [t.t("account.appearance.mode")]),
                segmented(h, {
                  label: t.t("account.appearance.mode"),
                  selected: ctx.prefs.mode,
                  items: (["system", "light", "dark"] as const).map((m) => ({
                    id: m,
                    label: t.translate(Theme.modeNameText(m)),
                  })),
                  onSelect: (id) =>
                    Message.SelectedMode({
                      mode: id === "light" || id === "dark" ? id : "system",
                    }),
                }),
              ],
            ),
            h.div(
              [h.Class("kb-field")],
              [
                h.span([h.Class("kb-field__label")], [t.t("account.appearance.contrast")]),
                segmented(h, {
                  label: t.t("account.appearance.contrast"),
                  selected: ctx.prefs.contrast,
                  items: (["standard", "medium", "high"] as const).map((c) => ({
                    id: c,
                    label: t.translate(Theme.contrastNameText(c)),
                  })),
                  onSelect: (id) =>
                    Message.SelectedContrast({
                      contrast: id === "medium" || id === "high" ? id : "standard",
                    }),
                }),
              ],
            ),
          ],
        ),
      ]),
      card(h, [
        cardTitle(h, t.t("account.appearance.preview")),
        h.div(
          [h.Class("kb-appearance-sample")],
          [
            h.div(
              [h.Class("kb-spread")],
              [
                h.strong([], [t.t("account.appearance.sampleCard")]),
                badge(h, t.translate(I18n.enumText("badge", "paid")), "paid"),
              ],
            ),
            h.div(
              [h.Class("kb-row")],
              [
                badge(h, t.translate(I18n.enumText("badge", "proforma")), "proforma"),
                badge(h, t.translate(I18n.enumText("badge", "overdue")), "overdue"),
                badge(h, t.translate(I18n.enumText("badge", "draft")), "draft"),
              ],
            ),
            h.div(
              [h.Class("kb-row")],
              [button(h, { label: t.t("account.appearance.sampleButton"), variant: "primary" })],
            ),
            h.p([h.Class("kb-small kb-muted")], [t.t("account.appearance.contrastOk")]),
          ],
        ),
      ]),
    ],
  );
};

const viewSecurity = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const t = translator(ctx.locale);
  const passkeys = Remote.dataOf(model.security.passkeys);
  const removing =
    model.security.removingId === null
      ? undefined
      : passkeys?.find((p) => p.id === model.security.removingId);

  return h.div(
    [h.Class("kb-stack")],
    [
      card(h, [
        cardTitle(h, t.t("account.security.passkeys")),
        h.div(
          [h.Class("kb-ares-row")],
          [
            textField(h, {
              id: "kb-passkey-name",
              label: t.t("account.security.passkeyName"),
              placeholder: sCopy(ctx.locale, "account.security.passkeyPlaceholder"),
              value: model.security.newPasskeyName,
              onInput: (value) => Message.ChangedNewPasskeyName({ value }),
            }),
            button(h, {
              label: t.t("account.security.addPasskey"),
              variant: "primary",
              busy: model.security.addingPasskey,
              onClick: Message.ClickedAddPasskey(),
            }),
          ],
        ),
        ...(model.security.passkeys._tag === "Loading"
          ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
          : model.security.passkeys._tag === "Failed"
            ? [
                banner(h, {
                  tone: "error",
                  text: textOf(t, model.security.passkeys.failure.text),
                  action: button(h, {
                    label: t.t("common.action.retry"),
                    small: true,
                    onClick: Message.ClickedRetry(),
                  }),
                }),
              ]
            : passkeys !== undefined && passkeys.length === 0
              ? [emptyState(h, { title: t.t("account.security.noPasskeys") })]
              : [
                  table(h, {
                    caption: t.t("account.security.passkeys"),
                    rows: passkeys ?? [],
                    rowKey: (row) => row.id,
                    columns: [
                      {
                        header: t.t("common.field.name"),
                        cell: (row) =>
                          model.security.renamingId === row.id
                            ? h.div(
                                [h.Class("kb-row")],
                                [
                                  h.input([
                                    h.Class("kb-input"),
                                    h.Value(model.security.renameValue),
                                    h.AriaLabel(t.t("account.security.passkeyName")),
                                    h.OnInput((value) => Message.ChangedRenamePasskey({ value })),
                                  ]),
                                  button(h, {
                                    label: t.t("common.action.save"),
                                    small: true,
                                    variant: "primary",
                                    onClick: Message.ClickedConfirmRenamePasskey(),
                                  }),
                                  button(h, {
                                    label: t.t("common.action.cancel"),
                                    small: true,
                                    variant: "ghost",
                                    onClick: Message.ClickedCancelRenamePasskey(),
                                  }),
                                ],
                              )
                            : row.name,
                      },
                      {
                        header: t.t("common.field.created"),
                        cell: (row) => h.span([h.Class("kb-mono")], [row.createdAt.slice(0, 10)]),
                      },
                      {
                        header: "",
                        align: "end",
                        cell: (row) => {
                          const isLast =
                            !model.security.hasPassword && (passkeys?.length ?? 0) <= 1;
                          return h.div(
                            [h.Class("kb-row")],
                            [
                              button(h, {
                                label: t.t("common.action.rename"),
                                small: true,
                                variant: "ghost",
                                onClick: Message.ClickedStartRenamePasskey({
                                  id: row.id,
                                  currentName: row.name,
                                }),
                              }),
                              button(h, {
                                label: t.t("common.action.remove"),
                                small: true,
                                variant: "danger",
                                disabled: isLast,
                                onClick: Message.ClickedAskRemovePasskey({ id: row.id }),
                              }),
                            ],
                          );
                        },
                      },
                    ],
                  }),
                ]),
      ]),
      card(h, [
        cardTitle(h, t.t("account.security.changePassword")),
        ...(model.security.passwordError !== null
          ? [banner(h, { tone: "error", text: model.security.passwordError })]
          : []),
        h.div(
          [h.Class("kb-form-grid")],
          [
            textField(h, {
              id: "kb-pw-current",
              label: t.t("account.security.currentPassword"),
              type: "password",
              value: model.security.currentPassword,
              autocomplete: "current-password",
              onInput: (value) => Message.ChangedCurrentPassword({ value }),
            }),
            textField(h, {
              id: "kb-pw-new",
              label: t.t("account.security.newPassword"),
              type: "password",
              value: model.security.newPassword,
              autocomplete: "new-password",
              onInput: (value) => Message.ChangedNewPassword({ value }),
            }),
            textField(h, {
              id: "kb-pw-confirm",
              label: sCopy(ctx.locale, "account.security.confirmPassword"),
              type: "password",
              value: model.security.confirmPassword,
              autocomplete: "new-password",
              onInput: (value) => Message.ChangedConfirmPassword({ value }),
            }),
          ],
        ),
        checkbox(h, {
          id: "kb-pw-signout-others",
          label: t.t("account.security.signOutOthers"),
          checked: model.security.signOutOthers,
          onToggle: (checked) => Message.ToggledSignOutOthers({ checked }),
        }),
        h.div(
          [h.Class("kb-row")],
          [
            button(h, {
              label: t.t("account.security.changePassword"),
              variant: "primary",
              busy: model.security.savingPassword,
              onClick: Message.ClickedChangePassword(),
            }),
          ],
        ),
      ]),
      ...(removing !== undefined
        ? [
            dialog(h, {
              id: "kb-remove-passkey-dialog",
              title: t.t("account.security.removePasskeyTitle", { name: removing.name }),
              body: [h.p([], [t.t("common.confirm.delete.body")])],
              actions: [
                button(h, {
                  label: t.t("common.action.cancel"),
                  onClick: Message.ClickedCancelRemovePasskey(),
                }),
                button(h, {
                  label: t.t("common.action.remove"),
                  variant: "danger",
                  onClick: Message.ClickedConfirmRemovePasskey(),
                }),
              ],
              onClose: Message.ClickedCancelRemovePasskey(),
            }),
          ]
        : []),
    ],
  );
};

const viewSessions = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const t = translator(ctx.locale);
  const rows = Remote.dataOf(model.sessions.list);

  return card(h, [
    cardTitle(h, t.t("account.security.sessions"), [
      button(h, {
        label: t.t("account.security.signOutOthers"),
        small: true,
        busy: model.sessions.revokingOthers,
        onClick: Message.ClickedRevokeOtherSessions(),
      }),
    ]),
    h.p([h.Class("kb-muted")], [sCopy(ctx.locale, "account.sessions.subtitle")]),
    ...(model.sessions.list._tag === "Loading"
      ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
      : model.sessions.list._tag === "Failed"
        ? [
            banner(h, {
              tone: "error",
              text: textOf(t, model.sessions.list.failure.text),
              action: button(h, {
                label: t.t("common.action.retry"),
                small: true,
                onClick: Message.ClickedRetry(),
              }),
            }),
          ]
        : rows !== undefined && rows.length === 0
          ? [emptyState(h, { title: sCopy(ctx.locale, "account.sessions.empty") })]
          : [
              table(h, {
                caption: t.t("account.security.sessions"),
                rows: rows ?? [],
                rowKey: (s) => s.id,
                columns: [
                  {
                    header: t.t("common.field.name"),
                    cell: (s) =>
                      h.div(
                        [h.Class("kb-row")],
                        [
                          h.span([], [s.userAgent]),
                          ...(s.current
                            ? [badge(h, t.t("account.security.thisDevice"), "paid")]
                            : []),
                        ],
                      ),
                  },
                  {
                    header: "IP",
                    cell: (s) => h.span([h.Class("kb-mono")], [s.ipAddress ?? "—"]),
                  },
                  {
                    header: t.t("common.field.updated"),
                    cell: (s) =>
                      h.span(
                        [h.Class("kb-mono")],
                        [t.t("account.security.lastActive", { date: s.updatedAt.slice(0, 10) })],
                      ),
                  },
                  {
                    header: "",
                    align: "end",
                    cell: (s) =>
                      s.current
                        ? ""
                        : button(h, {
                            label: t.t("account.security.revokeSession"),
                            small: true,
                            variant: "danger",
                            busy: model.sessions.revokingId === s.id,
                            onClick: Message.ClickedRevokeSession({ id: s.id }),
                          }),
                  },
                ],
              }),
            ]),
  ]);
};

const viewDanger = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const t = translator(ctx.locale);
  const phrase = t.t("account.danger.confirmPhrase");
  const blockingWorkspaces =
    ctx.session._tag === "SignedIn"
      ? ctx.session.workspaces.filter((w) => w.role === "owner" && w.memberCount === 1 && !w.closed)
      : [];
  const blocked = blockingWorkspaces.length > 0;
  const canSubmit = !blocked && model.danger.confirmText.trim() === phrase;

  return card(
    h,
    [
      cardTitle(h, t.t("account.danger.title")),
      h.p([], [t.t("account.danger.body")]),
      ...blockingWorkspaces.map((w) =>
        banner(h, {
          tone: "error",
          text: t.t("account.danger.blocked", { workspace: w.name }),
        }),
      ),
      textField(h, {
        id: "kb-delete-account-confirm",
        label: t.t("account.danger.confirm", { phrase }),
        value: model.danger.confirmText,
        disabled: blocked,
        mono: true,
        onInput: (value) => Message.ChangedDeleteConfirm({ value }),
      }),
      h.div(
        [h.Class("kb-row")],
        [
          button(h, {
            label: t.t("account.danger.submit"),
            variant: "danger",
            disabled: !canSubmit,
            busy: model.danger.deleting,
            onClick: Message.ClickedDeleteAccount(),
          }),
        ],
      ),
    ],
    [h.Class("kb-card kb-danger-card")],
  );
};

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const t = translator(ctx.locale);
  const activeTab: AccountTab = model.route._tag === "Account" ? model.route.tab : "profile";

  const body =
    activeTab === "profile"
      ? viewProfile(model, ctx, h)
      : activeTab === "appearance"
        ? viewAppearance(model, ctx, h)
        : activeTab === "security"
          ? viewSecurity(model, ctx, h)
          : activeTab === "sessions"
            ? viewSessions(model, ctx, h)
            : viewDanger(model, ctx, h);

  return page(h, [
    pageHeader(h, {
      title: t.t("account.title"),
      ...(ctx.session._tag === "SignedIn" ? { subtitle: ctx.session.user.email } : {}),
    }),
    tabs(h, {
      label: t.t("account.title"),
      selected: activeTab,
      items: ACCOUNT_TABS.map((tab) => ({
        id: tab,
        label: tabLabel(ctx.locale, tab),
        href: href({ _tag: "Account", tab }),
      })),
    }),
    ...(model.actionFailure !== null
      ? [banner(h, { tone: "error", text: textOf(t, model.actionFailure.text) })]
      : []),
    body,
  ]);
});
