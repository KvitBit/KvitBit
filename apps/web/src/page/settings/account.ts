import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
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
import { Effect, Option, Schema } from "effect";
import { authFetch, Failure, failureFromUnknown, request } from "../../app/api";
import { browserCommand, type PageCommand } from "../../app/commands";
import { textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import type { Locale, Prefs, ThemeChoice } from "../../app/prefs";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { performPasskeyRegistration } from "../../app/webauthn";
import { attribute, type Markup } from "../../ui/html";
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
  removingPasskey: Schema.Boolean,
  currentPassword: Schema.String,
  newPassword: Schema.String,
  confirmPassword: Schema.String,
  signOutOthers: Schema.Boolean,
  passwordError: Schema.NullOr(Schema.String),
  savingPassword: Schema.Boolean,
  hasPassword: Remote.remoteSchema(Schema.Boolean),
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

export const Message = UiSchema.TaggedEnum({
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
  // Security: Passkeys & Accounts
  GotPasskeys: { seq: Remote.Seq, items: Schema.Array(PasskeyItem) },
  FailedPasskeys: { seq: Remote.Seq, failure: Failure },
  GotAccounts: { seq: Remote.Seq, hasPassword: Schema.Boolean },
  FailedAccounts: { seq: Remote.Seq, failure: Failure },
  ChangedNewPasskeyName: { value: Schema.String },
  ClickedAddPasskey: {},
  AddedPasskey: {},
  FailedAddPasskey: { failure: Failure },
  ClickedStartRenamePasskey: { id: Schema.String, currentName: Schema.String },
  ChangedRenamePasskey: { value: Schema.String },
  ClickedConfirmRenamePasskey: {},
  ClickedCancelRenamePasskey: {},
  RenamedPasskey: { id: Schema.String, name: Schema.String },
  ClickedAskRemovePasskey: { id: Schema.String },
  ClickedCancelRemovePasskey: {},
  ClickedConfirmRemovePasskey: {},
  RemovedPasskey: { id: Schema.String },
  FailedRemovePasskey: { failure: Failure },
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

const decodeAccounts = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ providerId: Schema.String })),
);
const decodePasskeys = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      deviceType: Schema.String,
    }),
  ),
);
const decodeCurrentSession = Schema.decodeUnknownOption(
  Schema.Struct({ session: Schema.Struct({ id: Schema.String }) }),
);
const decodeSessions = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      token: Schema.String,
      userAgent: Schema.optionalKey(Schema.NullOr(Schema.String)),
      ipAddress: Schema.optionalKey(Schema.NullOr(Schema.String)),
      updatedAt: Schema.String,
    }),
  ),
);

const invalidAuthResponse = (path: string): Failure =>
  failureFromUnknown(new Error(`Unexpected response from ${path}`));

const origin = (): string =>
  typeof location === "undefined" || location.origin === "null"
    ? "http://localhost"
    : location.origin;

const cmdLoadAccounts = (seq: number) =>
  browserCommand(
    "Account.LoadAccounts",
    authFetch(
      "/list-accounts",
      { method: "GET" },
      (json): Message => {
        const accounts = decodeAccounts(json);
        return Option.isSome(accounts)
          ? Message.GotAccounts({
              seq,
              hasPassword: accounts.value.some((account) => account.providerId === "credential"),
            })
          : Message.FailedAccounts({ seq, failure: invalidAuthResponse("/list-accounts") });
      },
      (failure): Message => Message.FailedAccounts({ seq, failure }),
    ),
  );

const cmdLoadPasskeys = (seq: number, locale: Locale) =>
  browserCommand(
    "Account.LoadPasskeys",
    authFetch(
      "/passkey/list-user-passkeys",
      { method: "GET" },
      (json): Message => {
        const passkeys = decodePasskeys(json);
        return Option.isSome(passkeys)
          ? Message.GotPasskeys({
              seq,
              items: passkeys.value.map((passkey) => ({
                ...passkey,
                name: passkey.name?.trim() || sCopy(locale, "account.security.unnamedPasskey"),
                createdAt: passkey.createdAt ?? "",
              })),
            })
          : Message.FailedPasskeys({
              seq,
              failure: invalidAuthResponse("/passkey/list-user-passkeys"),
            });
      },
      (failure): Message => Message.FailedPasskeys({ seq, failure }),
    ),
  );

const cmdAddPasskey = (name: string) =>
  browserCommand(
    "Account.AddPasskey",
    Effect.tryPromise({
      try: () => performPasskeyRegistration(origin(), name),
      catch: (e) => e,
    }).pipe(
      Effect.map(
        (res): Message =>
          res.supported
            ? Message.AddedPasskey()
            : Message.FailedAddPasskey({
                failure: {
                  tag: "Invalid",
                  surface: "inline",
                  text: { key: "auth.passkey.unsupported" },
                  issues: [],
                  retryable: false,
                  staleRevision: false,
                  freshBotProof: false,
                  requestId: null,
                },
              }),
      ),
      Effect.catch((e) =>
        Effect.succeed<Message>(Message.FailedAddPasskey({ failure: failureFromUnknown(e) })),
      ),
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
  browserCommand(
    "Account.DeletePasskey",
    authFetch(
      "/passkey/delete-passkey",
      { method: "POST", body: { id } },
      (): Message => Message.RemovedPasskey({ id }),
      (failure): Message => Message.FailedRemovePasskey({ failure }),
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

const cmdLoadSessions = (seq: number, unknownDevice: string) =>
  browserCommand(
    "Account.LoadSessions",
    authFetch(
      "/get-session",
      { method: "GET" },
      (json) => {
        const current = decodeCurrentSession(json);
        return Option.isSome(current)
          ? { _tag: "Current" as const, id: current.value.session.id }
          : Message.FailedSessions({ seq, failure: invalidAuthResponse("/get-session") });
      },
      (failure) => Message.FailedSessions({ seq, failure }),
    ).pipe(
      Effect.andThen((current): Effect.Effect<Message> => {
        if (current._tag === "FailedSessions") return Effect.succeed(current);
        return authFetch(
          "/list-sessions",
          { method: "GET" },
          (json): Message => {
            const sessions = decodeSessions(json);
            if (Option.isNone(sessions) || !sessions.value.some((s) => s.id === current.id)) {
              return Message.FailedSessions({
                seq,
                failure: invalidAuthResponse("/list-sessions"),
              });
            }
            return Message.GotSessions({
              seq,
              items: sessions.value.map((session) => ({
                ...session,
                userAgent: session.userAgent?.trim() || unknownDevice,
                ipAddress: session.ipAddress ?? null,
                current: session.id === current.id,
              })),
            });
          },
          (failure): Message => Message.FailedSessions({ seq, failure }),
        );
      }),
    ),
  );

const cmdRevokeSession = (id: string, token: string) =>
  browserCommand(
    "Account.RevokeSession",
    authFetch(
      "/revoke-session",
      { method: "POST", body: { token } },
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
  const commands: Array<PageCommand<Message>> = [];

  let preferences: Remote.Remote<AccountPreferences> = Remote.idle;
  let passkeys: Remote.Remote<ReadonlyArray<PasskeyItem>> = Remote.idle;
  let hasPassword: Remote.Remote<boolean> = Remote.idle;
  let sessions: Remote.Remote<ReadonlyArray<SessionItem>> = Remote.idle;

  if (route.tab === "profile" || route.tab === "appearance") {
    preferences = Remote.load(preferences);
    commands.push(cmdLoadPreferences(Remote.seqOf(preferences)));
  } else if (route.tab === "security") {
    passkeys = Remote.load(passkeys);
    hasPassword = Remote.load(hasPassword);
    commands.push(
      cmdLoadPasskeys(Remote.seqOf(passkeys), ctx.locale),
      cmdLoadAccounts(Remote.seqOf(hasPassword)),
    );
  } else if (route.tab === "sessions") {
    sessions = Remote.load(sessions);
    commands.push(
      cmdLoadSessions(Remote.seqOf(sessions), sCopy(ctx.locale, "account.sessions.unknownDevice")),
    );
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
        removingPasskey: false,
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
        signOutOthers: true,
        passwordError: null,
        savingPassword: false,
        hasPassword,
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

const canRemovePasskey = (security: Model["security"], id: string): boolean =>
  !security.removingPasskey &&
  security.passkeys._tag === "Loaded" &&
  security.passkeys.data.some((passkey) => passkey.id === id) &&
  security.hasPassword._tag === "Loaded" &&
  (security.hasPassword.data || security.passkeys.data.length > 1);

const currentRevision = (model: Model): number => Remote.dataOf(model.preferences)?.revision ?? 1;

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const t = translator(ctx.locale);

  return Message.match(message, {
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
    GotAccounts: ({ seq, hasPassword }) => ({
      model: {
        ...model,
        security: {
          ...model.security,
          hasPassword: Remote.succeed(model.security.hasPassword, seq, hasPassword),
        },
      },
    }),
    FailedAccounts: ({ seq, failure }) => ({
      model: {
        ...model,
        security: {
          ...model.security,
          hasPassword: Remote.fail(model.security.hasPassword, seq, failure),
        },
      },
    }),
    ChangedNewPasskeyName: ({ value }) => ({
      model: { ...model, security: { ...model.security, newPasskeyName: value } },
    }),
    ClickedAddPasskey: () => {
      if (model.security.addingPasskey) return { model };
      const name =
        model.security.newPasskeyName.trim() ||
        sCopy(ctx.locale, "account.security.unnamedPasskey");
      return {
        model: {
          ...model,
          security: { ...model.security, addingPasskey: true },
          actionFailure: null,
        },
        commands: [cmdAddPasskey(name)],
      };
    },
    AddedPasskey: () => {
      const passkeys = Remote.load(model.security.passkeys);
      return {
        model: {
          ...model,
          security: { ...model.security, addingPasskey: false, newPasskeyName: "", passkeys },
        },
        commands: [cmdLoadPasskeys(Remote.seqOf(passkeys), ctx.locale)],
        outMessage: Intent_.toast(t.t("account.security.passkeyAdded")),
      };
    },
    FailedAddPasskey: ({ failure }) => ({
      model: {
        ...model,
        security: { ...model.security, addingPasskey: false },
        actionFailure: failure,
      },
    }),
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
      const seq = Remote.seqOf(model.security.passkeys) + 1;
      return {
        model: {
          ...model,
          security: {
            ...model.security,
            renamingId: null,
            renameValue: "",
            passkeys: {
              _tag: "Refreshing",
              seq,
              data: existing.map((p) => (p.id === id ? { ...p, name } : p)),
            },
          },
        },
        commands: [cmdLoadPasskeys(seq, ctx.locale)],
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.security.passkeyRenamed")),
      };
    },
    ClickedAskRemovePasskey: ({ id }) =>
      canRemovePasskey(model.security, id)
        ? { model: { ...model, security: { ...model.security, removingId: id } } }
        : { model },
    ClickedCancelRemovePasskey: () =>
      model.security.removingPasskey
        ? { model }
        : { model: { ...model, security: { ...model.security, removingId: null } } },
    ClickedConfirmRemovePasskey: () => {
      const id = model.security.removingId;
      if (model.security.removingPasskey) return { model };
      if (id === null || !canRemovePasskey(model.security, id)) {
        return { model: { ...model, security: { ...model.security, removingId: null } } };
      }
      return {
        model: {
          ...model,
          security: { ...model.security, removingPasskey: true },
          actionFailure: null,
        },
        commands: [cmdDeletePasskey(id)],
      };
    },
    RemovedPasskey: ({ id }) => {
      const existing = Remote.dataOf(model.security.passkeys) ?? [];
      const seq = Remote.seqOf(model.security.passkeys) + 1;
      return {
        model: {
          ...model,
          security: {
            ...model.security,
            removingId: null,
            removingPasskey: false,
            passkeys: {
              _tag: "Refreshing",
              seq,
              data: existing.filter((p) => p.id !== id),
            },
          },
        },
        commands: [cmdLoadPasskeys(seq, ctx.locale)],
        outMessage: Intent_.toast(sCopy(ctx.locale, "account.security.passkeyRemoved")),
      };
    },

    FailedRemovePasskey: ({ failure }) => {
      const passkeys = Remote.load(model.security.passkeys);
      return {
        model: {
          ...model,
          security: { ...model.security, removingId: null, removingPasskey: false, passkeys },
          actionFailure: failure,
        },
        commands: [cmdLoadPasskeys(Remote.seqOf(passkeys), ctx.locale)],
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
          hasPassword: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.security.hasPassword) + 1,
            data: true,
          },
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
    ClickedRevokeSession: ({ id }) => {
      if (model.sessions.revokingId !== null || model.sessions.revokingOthers) return { model };
      const target = Remote.dataOf(model.sessions.list)?.find((s) => s.id === id);
      if (target === undefined || target.current) return { model };
      return {
        model: {
          ...model,
          sessions: { ...model.sessions, revokingId: id },
          actionFailure: null,
        },
        commands: [cmdRevokeSession(id, target.token)],
      };
    },
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
    ClickedRevokeOtherSessions: () => {
      if (
        model.sessions.revokingOthers ||
        model.sessions.revokingId !== null ||
        !Remote.dataOf(model.sessions.list)?.some((s) => !s.current)
      )
        return { model };
      return {
        model: {
          ...model,
          sessions: { ...model.sessions, revokingOthers: true },
          actionFailure: null,
        },
        commands: [cmdRevokeOtherSessions()],
      };
    },
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
        security: { ...model.security, savingPassword: false },
        sessions: { ...model.sessions, revokingId: null, revokingOthers: false },
        danger: { ...model.danger, deleting: false },
        actionFailure: failure,
      },
    }),

    ClickedRetry: () => {
      if (model.route._tag !== "Account") return { model };
      if (model.route.tab === "security") {
        const passkeys = Remote.load(model.security.passkeys);
        const hasPassword = Remote.load(model.security.hasPassword);
        return {
          model: { ...model, security: { ...model.security, passkeys, hasPassword } },
          commands: [
            cmdLoadPasskeys(Remote.seqOf(passkeys), ctx.locale),
            cmdLoadAccounts(Remote.seqOf(hasPassword)),
          ],
        };
      }
      return init(model.route, ctx);
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

// --- Title --------------------------------------------------------------------------------------

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  if (model.route._tag !== "Account") return t.t("account.title");
  return `${t.t("account.title")} · ${sCopy(ctx.locale, `account.nav.${model.route.tab}`)}`;
};

// --- View ---------------------------------------------------------------------------------------

const tabLabel = (locale: Locale, tab: AccountTab): string => sCopy(locale, `account.nav.${tab}`);

const viewProfile = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const currentEmail = ctx.session._tag === "SignedIn" ? ctx.session.user.email : "";

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("account.profile.title")),
      h.div.class("kb-form-grid").children([
        textField(h, {
          id: "kb-account-name",
          label: t.t("account.profile.name"),
          value: model.profile.name,
          onInput: (value) => Message.ChangedName({ value }),
          autocomplete: "name",
        }),
        h.div.class("kb-field").children([
          h.span.class("kb-field__label").children([t.t("account.profile.language")]),
          segmented(h, {
            label: t.t("account.profile.language"),
            selected: ctx.prefs.locale,
            items: [
              { id: "cs", label: "Čeština" },
              { id: "en", label: "English" },
            ],
            onSelect: (id) => Message.ChangedLocale({ locale: id === "en" ? "en" : "cs" }),
          }),
        ]),
      ]),
      h.div.class("kb-row").children([
        button(h, {
          label: sCopy(ctx.locale, "account.profile.save"),
          variant: "primary",
          busy: model.profile.savingProfile,
          onClick: Message.ClickedSaveProfile(),
        }),
      ]),
    ]),
    card(h, [
      cardTitle(h, t.t("account.profile.email")),
      h.p.class("kb-muted").children([currentEmail]),
      ...(model.profile.emailSentTo !== null
        ? [
            banner(h, {
              tone: "info",
              text: t.t("account.profile.emailChangeSent", { email: model.profile.emailSentTo }),
            }),
          ]
        : []),
      h.div.class("kb-ares-row").children([
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
      ]),
    ]),
  ]);
};

const viewAppearance = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const activePreset = ctx.prefs.theme._tag === "Preset" ? ctx.prefs.theme.id : null;

  return h.div.class("kb-settings-grid").children([
    card(h, [
      cardTitle(h, t.t("account.appearance.title"), [
        button(h, {
          label: sCopy(ctx.locale, "account.appearance.savePrefs"),
          variant: "primary",
          busy: model.appearance.saving,
          onClick: Message.ClickedSaveAppearance(),
        }),
      ]),
      h.div
        .style({ display: "contents" })
        .children(
          model.appearance.dirty
            ? [banner(h, { tone: "info", text: t.t("account.appearance.unsaved") })]
            : [],
        ),
      h.div.class("kb-section").children([
        h.h3.children([t.t("account.appearance.presets")]),
        h.div.class("kb-preset-grid").children(
          Theme.PRESET_IDS.map((id) => {
            const def = Theme.PresetDefinitions[id];
            return h.button
              .attr("type", "button")
              .class("kb-preset-card")
              .attr("aria-pressed", String(activePreset === id ? "true" : "false"))
              .attr("data-preset", id)
              .on("click", Message.SelectedPreset({ preset: id }))
              .children([
                h.span
                  .class("kb-preset-swatch")
                  .style({ "--kb-swatch-color": def.seed })
                  .children([]),
                h.span.children([t.translate(Theme.presetNameText(id))]),
              ]);
          }),
        ),
      ]),
      h.div.class("kb-ares-row").children([
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
      ]),
      h.div.class("kb-form-grid").children([
        h.div.class("kb-field").children([
          h.span.class("kb-field__label").children([t.t("account.appearance.style")]),
          segmented(h, {
            label: t.t("account.appearance.style"),
            selected: ctx.prefs.style,
            items: (["elegant", "cozy"] as const).map((s) => ({
              id: s,
              label: t.translate(Theme.styleNameText(s)),
            })),
            onSelect: (id) => Message.SelectedStyle({ style: id === "cozy" ? "cozy" : "elegant" }),
          }),
          h.span
            .class("kb-field__hint")
            .children([t.translate(I18n.enumText("themeStyleHint", ctx.prefs.style))]),
        ]),
        h.div.class("kb-field").children([
          h.span.class("kb-field__label").children([t.t("account.appearance.mode")]),
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
        ]),
        h.div.class("kb-field").children([
          h.span.class("kb-field__label").children([t.t("account.appearance.contrast")]),
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
        ]),
      ]),
    ]),
    card(h, [
      cardTitle(h, t.t("account.appearance.preview")),
      h.div
        .class("kb-appearance-sample")
        .children([
          h.div
            .class("kb-spread")
            .children([
              h.strong.children([t.t("account.appearance.sampleCard")]),
              badge(h, t.translate(I18n.enumText("badge", "paid")), "paid"),
            ]),
          h.div
            .class("kb-row")
            .children([
              badge(h, t.translate(I18n.enumText("badge", "proforma")), "proforma"),
              badge(h, t.translate(I18n.enumText("badge", "overdue")), "overdue"),
              badge(h, t.translate(I18n.enumText("badge", "draft")), "draft"),
            ]),
          h.div
            .class("kb-row")
            .children([
              button(h, { label: t.t("account.appearance.sampleButton"), variant: "primary" }),
            ]),
          h.p.class("kb-small kb-muted").children([t.t("account.appearance.contrastOk")]),
        ]),
    ]),
  ]);
};

const viewSecurity = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const passkeys = Remote.dataOf(model.security.passkeys);
  const removing =
    model.security.removingId === null
      ? undefined
      : passkeys?.find((p) => p.id === model.security.removingId);

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("account.security.passkeys")),
      h.div.class("kb-ares-row").children([
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
      ]),
      ...(model.security.hasPassword._tag === "Failed" && model.security.passkeys._tag !== "Failed"
        ? [
            banner(h, {
              tone: "error",
              text: textOf(t, model.security.hasPassword.failure.text),
              action: button(h, {
                label: t.t("common.action.retry"),
                small: true,
                onClick: Message.ClickedRetry(),
              }),
            }),
          ]
        : []),
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
                          ? h.div.class("kb-row").children([
                              h.input
                                .class("kb-input")
                                .value(model.security.renameValue)
                                .attr("aria-label", t.t("account.security.passkeyName"))
                                .on("input", ({ value }) =>
                                  Message.ChangedRenamePasskey({ value }),
                                ),
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
                            ])
                          : row.name,
                    },
                    {
                      header: t.t("common.field.created"),
                      cell: (row) => h.span.class("kb-mono").children([row.createdAt.slice(0, 10)]),
                    },
                    {
                      header: "",
                      align: "end",
                      cell: (row) => {
                        return h.div.class("kb-row").children([
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
                            disabled: !canRemovePasskey(model.security, row.id),
                            onClick: Message.ClickedAskRemovePasskey({ id: row.id }),
                          }),
                        ]);
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
      h.div.class("kb-form-grid").children([
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
      ]),
      checkbox(h, {
        id: "kb-pw-signout-others",
        label: t.t("account.security.signOutOthers"),
        checked: model.security.signOutOthers,
        onToggle: (checked) => Message.ToggledSignOutOthers({ checked }),
      }),
      h.div.class("kb-row").children([
        button(h, {
          label: t.t("account.security.changePassword"),
          variant: "primary",
          busy: model.security.savingPassword,
          onClick: Message.ClickedChangePassword(),
        }),
      ]),
    ]),
    ...(removing !== undefined
      ? [
          dialog(h, {
            id: "kb-remove-passkey-dialog",
            title: t.t("account.security.removePasskeyTitle", { name: removing.name }),
            alert: true,
            body: [h.p.children([t.t("common.confirm.delete.body")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                disabled: model.security.removingPasskey,
                onClick: Message.ClickedCancelRemovePasskey(),
              }),
              button(h, {
                label: t.t("common.action.remove"),
                variant: "danger",
                busy: model.security.removingPasskey,
                disabled: !canRemovePasskey(model.security, removing.id),
                onClick: Message.ClickedConfirmRemovePasskey(),
              }),
            ],
            onClose: Message.ClickedCancelRemovePasskey(),
          }),
        ]
      : []),
  ]);
};

const viewSessions = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const rows = Remote.dataOf(model.sessions.list);

  return card(h, [
    cardTitle(h, t.t("account.security.sessions"), [
      button(h, {
        label: t.t("account.security.signOutOthers"),
        small: true,
        busy: model.sessions.revokingOthers,
        disabled: model.sessions.revokingId !== null || !rows?.some((session) => !session.current),
        onClick: Message.ClickedRevokeOtherSessions(),
      }),
    ]),
    h.p.class("kb-muted").children([sCopy(ctx.locale, "account.sessions.subtitle")]),
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
                      h.div
                        .class("kb-row")
                        .children([
                          h.span.children([s.userAgent]),
                          ...(s.current
                            ? [badge(h, t.t("account.security.thisDevice"), "paid")]
                            : []),
                        ]),
                  },
                  {
                    header: "IP",
                    cell: (s) => h.span.class("kb-mono").children([s.ipAddress ?? "—"]),
                  },
                  {
                    header: t.t("common.field.updated"),
                    cell: (s) =>
                      h.span
                        .class("kb-mono")
                        .children([
                          t.t("account.security.lastActive", { date: s.updatedAt.slice(0, 10) }),
                        ]),
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
                            disabled:
                              model.sessions.revokingOthers || model.sessions.revokingId !== null,
                            onClick: Message.ClickedRevokeSession({ id: s.id }),
                          }),
                  },
                ],
              }),
            ]),
  ]);
};

const viewDanger = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
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
      h.p.children([t.t("account.danger.body")]),
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
      h.div.class("kb-row").children([
        button(h, {
          label: t.t("account.danger.submit"),
          variant: "danger",
          disabled: !canSubmit,
          busy: model.danger.deleting,
          onClick: Message.ClickedDeleteAccount(),
        }),
      ]),
    ],
    [attribute("class", "kb-card kb-danger-card")],
  );
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
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
};
