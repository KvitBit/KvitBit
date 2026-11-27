import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 02 — Authentication flows:
 * - SignUp (email/password or passkey, terms acceptance, invitation-locked email, quiet ALTCHA)
 * - SignIn (password, magic link, passkey WebAuthn trigger)
 * - CheckEmail (verification/magic-link/reset sent, resend action)
 * - AuthLink (auto-verify verify/magic/reset link tokens)
 * - ResetPassword (request reset link or set new password with token)
 *
 * Plain user-facing copy per DESIGN.md (no "PoW" or "Local cryptographic" jargon).
 */
import { BotScope } from "@kvitbit/api-contract";
import { InvitationPeek, InvitationToken, WorkspaceSummary } from "@kvitbit/domain";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { authFetch, Failure, failureFromUnknown } from "../../app/api";
import { browserCommand, defineApiCommand, type PageCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href, magicSignInCallback, safeReturnTo } from "../../app/routing";
import { performPasskeyAuthentication } from "../../app/webauthn";
import { lockup } from "../../ui/brand";
import { attribute, type Markup } from "../../ui/html";
import { icon } from "../../ui/icons";
import { banner, button, card, checkbox, segmented, textField } from "../../ui/kit";
import {
  BotProofState,
  botProofHeader,
  type FetchAndSolveResult,
  fetchAndSolveBotProof,
  isBotProofReady,
} from "./_altcha";
import { callApi, failureMessage, fieldIssue } from "./_shared";

export const Route = Schema.Union([
  RouteCases.SignUp,
  RouteCases.SignIn,
  RouteCases.CheckEmail,
  RouteCases.AuthLink,
  RouteCases.ResetPassword,
]);
export type Route = typeof Route.Type;

const SignInMethod = Schema.Literals(["password", "magic_link", "passkey"]);
const SignUpMethod = Schema.Literals(["password", "passkey"]);

const InvitationRemote = Remote.remoteSchema(InvitationPeek);

export const Model = Schema.Struct({
  route: Route,
  email: Schema.String,
  name: Schema.String,
  password: Schema.String,
  confirmPassword: Schema.String,
  acceptedTerms: Schema.Boolean,
  signInMethod: SignInMethod,
  signUpMethod: SignUpMethod,
  botProof: BotProofState,
  botSeq: Remote.Seq,
  submitSeq: Remote.Seq,
  submitting: Schema.Boolean,
  submitFailure: Schema.NullOr(Failure),
  localError: Schema.NullOr(Schema.String),
  infoNotice: Schema.NullOr(Schema.String),
  linkState: Schema.Literals(["idle", "sent", "verifying", "verified", "expired"]),
  resetDone: Schema.Boolean,
  resent: Schema.Boolean,
  invitation: InvitationRemote,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  ChangedEmail: { value: Schema.String },
  ChangedName: { value: Schema.String },
  ChangedPassword: { value: Schema.String },
  ChangedConfirmPassword: { value: Schema.String },
  ToggledTerms: { checked: Schema.Boolean },
  SelectedSignInMethod: { method: SignInMethod },
  SelectedSignUpMethod: { method: SignUpMethod },
  GotBotProof: {
    seq: Remote.Seq,
    status: Schema.Literals(["not_required", "solved", "failed"]),
    header: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  },
  ClickedRetryBotProof: {},
  ClickedRetryInvitation: {},
  GotInvitation: { seq: Remote.Seq, peek: InvitationPeek },
  FailedInvitation: { seq: Remote.Seq, failure: Failure },
  CompletedInvitationSignUp: { seq: Remote.Seq, workspace: WorkspaceSummary },
  FailedInvitationSignUp: { seq: Remote.Seq },
  SubmittedSignUp: {},
  SubmittedSignIn: {},
  ClickedPasskeySignIn: {},
  ClickedResendEmail: {},
  ClickedChangeEmail: {},
  SubmittedResetRequest: {},
  SubmittedResetConfirm: {},
  CompletedSubmit: {
    seq: Remote.Seq,
    action: Schema.Literals([
      "sign_up",
      "sign_up_passkey",
      "sign_in_password",
      "sign_in_magic",
      "sign_in_passkey",
      "resend",
      "verify_link",
      "reset_request",
      "reset_confirm",
    ]),
    sessionEstablished: Schema.optionalKey(Schema.Boolean),
  },
  FailedSubmit: { seq: Remote.Seq, failure: Failure },
  FailedPasskeyUnsupported: { seq: Remote.Seq },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    fullName: "Jméno a příjmení",
    emailRequired: "Zadejte e-mailovou adresu.",
    passwordTooShort: "Heslo musí mít alespoň 10 znaků.",
    passwordsMismatch: "Hesla se neshodují.",
    termsRequired: "Pro vytvoření účtu potvrďte souhlas s podmínkami.",
    botWait: "Počkejte na dokončení ověření.",
    retryCheck: "Zkusit znovu",
    backToSignIn: "Zpět na přihlášení",
    signInNow: "Přihlásit se",
    signUpLink: "Vytvořit účet",
    forgotLink: "Zapomenuté heslo?",
    requestNewReset: "Požádat o nový odkaz",
    invitationUnavailable:
      "Pozvánku se nepodařilo ověřit. Zkontrolujte odkaz nebo to zkuste znovu.",
    passkeySignUpHint:
      "Potvrďte e-mail odkazem. Potom si v nastavení zabezpečení vytvoříte přístupový klíč.",
    verifySignIn: "E-mail byl ověřen. Pokračujte přihlášením.",
    changeEmail: "Změnit e-mail",
  },
  en: {
    fullName: "Full name",
    emailRequired: "Enter your email address.",
    passwordTooShort: "Password must be at least 10 characters.",
    passwordsMismatch: "Passwords do not match.",
    termsRequired: "Accept the terms and privacy policy to continue.",
    botWait: "Please wait for verification to finish.",
    retryCheck: "Retry",
    backToSignIn: "Back to sign in",
    signInNow: "Sign in",
    signUpLink: "Create account",
    forgotLink: "Forgot password?",
    requestNewReset: "Request a new link",
    invitationUnavailable: "We couldn't verify this invitation. Check the link or try again.",
    passkeySignUpHint:
      "Verify your email with the link we send, then add a passkey in Security settings.",
    verifySignIn: "Your email is verified. Sign in to continue.",
    changeEmail: "Change email",
  },
});

const scopeForRoute = (
  route: Route,
  signInMethod: Model["signInMethod"],
  signUpMethod: Model["signUpMethod"] = "password",
): BotScope | null => {
  switch (route._tag) {
    case "SignUp":
      if (route.invitation !== undefined) return "invitation_accept";
      return signUpMethod === "passkey" ? "magic_link" : "sign_up";
    case "SignIn":
      return signInMethod === "magic_link"
        ? "magic_link"
        : signInMethod === "password"
          ? "sign_in"
          : null;
    case "ResetPassword":
      return route.token === undefined ? "password_reset" : null;
    default:
      return null;
  }
};

const mapBotResult = (seq: Remote.Seq, res: FetchAndSolveResult) => {
  switch (res._tag) {
    case "NotRequired":
      return Message.GotBotProof({ seq, status: "not_required", header: null, reason: null });
    case "Solved":
      return Message.GotBotProof({ seq, status: "solved", header: res.header, reason: null });
    case "Failed":
      return Message.GotBotProof({ seq, status: "failed", header: null, reason: res.reason });
  }
};

const BotProofCmd = defineApiCommand({
  message: Message,
  name: "AuthBotProof",
  args: { scope: BotScope, seq: Remote.Seq },
  execute: ({ scope, seq }) => fetchAndSolveBotProof(scope, (res) => mapBotResult(seq, res)),
});

const PeekInviteCmd = defineApiCommand({
  message: Message,
  name: "AuthPeekInvite",
  args: { token: Schema.String, seq: Remote.Seq },
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.invitations.peek({ params: { token: InvitationToken.make(token) } }),
      (peek) => Message.GotInvitation({ seq, peek }),
      (failure) => Message.FailedInvitation({ seq, failure }),
    ),
});

const AcceptSignedUpInviteCmd = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "AuthAcceptSignedUpInvite",
  args: { token: Schema.String, seq: Remote.Seq },
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.invitations.accept({ params: { token: InvitationToken.make(token) } }),
      (workspace) => Message.CompletedInvitationSignUp({ seq, workspace }),
      () => Message.FailedInvitationSignUp({ seq }),
    ),
});

const AuthAction = Schema.Literals([
  "sign_up",
  "sign_up_passkey",
  "sign_in_password",
  "sign_in_magic",
  "sign_in_passkey",
  "resend",
  "verify_link",
  "reset_request",
  "reset_confirm",
]);

const isAuthenticatedResponse = Schema.is(
  Schema.Struct({
    token: Schema.NonEmptyString,
  }),
);

const AuthPostCmd = defineApiCommand({
  message: Message,
  name: "AuthPost",
  args: {
    seq: Remote.Seq,
    action: AuthAction,
    path: Schema.String,
    body: Schema.JsonObject,
    altchaHeader: Schema.NullOr(Schema.String),
  },
  execute: ({ seq, action, path, body, altchaHeader }) =>
    authFetch(
      path,
      { method: "POST", body, altchaHeader: altchaHeader ?? undefined },
      (json) =>
        Message.CompletedSubmit({
          seq,
          action,
          sessionEstablished: isAuthenticatedResponse(json),
        }),
      (failure) => Message.FailedSubmit({ seq, failure }),
    ),
});

const AuthGetCmd = defineApiCommand({
  message: Message,
  name: "AuthGet",
  args: { seq: Remote.Seq, action: AuthAction, path: Schema.String },
  execute: ({ seq, action, path }) =>
    authFetch<ReturnType<typeof Message.CompletedSubmit> | ReturnType<typeof Message.FailedSubmit>>(
      path,
      { method: "GET" },
      () => Message.CompletedSubmit({ seq, action }),
      (failure) => Message.FailedSubmit({ seq, failure }),
    ),
});

const startBotProof = (scope: BotScope, seq: Remote.Seq) => BotProofCmd({ scope, seq });

const runPasskeyAuth = (seq: Remote.Seq) =>
  browserCommand(
    "AuthPasskey",
    performPasskeyAuthentication.pipe(
      Effect.map((out) =>
        !out.supported
          ? Message.FailedPasskeyUnsupported({ seq })
          : Message.CompletedSubmit({ seq, action: "sign_in_passkey" }),
      ),
      Effect.catch((e) =>
        Effect.succeed(Message.FailedSubmit({ seq, failure: failureFromUnknown(e) })),
      ),
    ),
  );

const invitationPath = (model: Model) =>
  model.route._tag === "SignUp" && model.route.invitation !== undefined
    ? href({ _tag: "Invitation", token: model.route.invitation })
    : undefined;

const signInPath = (returnTo: string | undefined) =>
  href(returnTo === undefined ? { _tag: "SignIn" } : { _tag: "SignIn", returnTo });

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const scope = scopeForRoute(route, "password");
  const botSeq = scope !== null ? 1 : 0;
  const botProof: BotProofState =
    scope !== null ? { _tag: "Solving", seq: botSeq } : { _tag: "Idle" };

  let invitation: Remote.Remote<InvitationPeek> = Remote.idle;
  const commands: Array<PageCommand<Message>> = [];

  if (scope !== null) {
    commands.push(startBotProof(scope, botSeq));
  }

  if (route._tag === "SignUp" && route.invitation !== undefined) {
    invitation = Remote.load(Remote.idle);
    const invSeq = Remote.seqOf(invitation);
    commands.push(PeekInviteCmd({ token: route.invitation, seq: invSeq }));
  }

  let linkState: Model["linkState"] = "idle";
  let submitSeq = 0;
  if (route._tag === "AuthLink") {
    if (route.kind === "reset") {
      return {
        model: {
          route,
          email: "",
          name: "",
          password: "",
          confirmPassword: "",
          acceptedTerms: false,
          signInMethod: "password",
          signUpMethod: "password",
          botProof: { _tag: "Idle" },
          botSeq: 0,
          submitSeq: 0,
          submitting: false,
          submitFailure: null,
          localError: null,
          infoNotice: null,
          linkState: "verifying",
          resetDone: false,
          resent: false,
          invitation: Remote.idle,
        },
        outMessage: Intent_.navigate(href({ _tag: "ResetPassword", token: route.token }), true),
      };
    }
    linkState = "verifying";
    submitSeq = 1;
    const verifyPath =
      route.kind === "verify"
        ? `/verify-email?token=${encodeURIComponent(route.token)}`
        : `/magic-link/verify?token=${encodeURIComponent(route.token)}`;
    commands.push(AuthGetCmd({ seq: submitSeq, action: "verify_link", path: verifyPath }));
  }

  return {
    model: {
      route,
      email: route._tag === "CheckEmail" ? route.email : "",
      name: "",
      password: "",
      confirmPassword: "",
      acceptedTerms: false,
      signInMethod: "password",
      signUpMethod: "password",
      botProof,
      botSeq,
      submitSeq,
      submitting: false,
      submitFailure: null,
      localError: null,
      infoNotice: null,
      linkState,
      resetDone: false,
      resent: false,
      invitation,
    },
    commands,
  };
};

export const init: {
  (_ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> =>
  Message.match(message, {
    ChangedEmail: ({ value }) =>
      invitationPath(model) !== undefined || model.submitting
        ? { model }
        : { model: { ...model, email: value, localError: null, submitFailure: null } },
    ChangedName: ({ value }) => ({
      model: { ...model, name: value, localError: null, submitFailure: null },
    }),
    ChangedPassword: ({ value }) => ({
      model: { ...model, password: value, localError: null, submitFailure: null },
    }),
    ChangedConfirmPassword: ({ value }) => ({
      model: { ...model, confirmPassword: value, localError: null, submitFailure: null },
    }),
    ToggledTerms: ({ checked }) => ({
      model: { ...model, acceptedTerms: checked, localError: null },
    }),
    SelectedSignUpMethod: ({ method }) => {
      if (model.submitting || model.signUpMethod === method || invitationPath(model) !== undefined)
        return { model };
      const route = model.route;
      const scope = scopeForRoute(route, model.signInMethod, method);
      if (scope === null) {
        return {
          model: { ...model, signUpMethod: method, localError: null, submitFailure: null },
        };
      }
      const botSeq = model.botSeq + 1;
      return {
        model: {
          ...model,
          signUpMethod: method,
          botSeq,
          botProof: { _tag: "Solving", seq: botSeq },
          localError: null,
          submitFailure: null,
        },
        commands: [startBotProof(scope, botSeq)],
      };
    },
    SelectedSignInMethod: ({ method }) => {
      if (model.submitting || model.signInMethod === method) return { model };
      const route = model.route;
      const scope = scopeForRoute(route, method);
      if (scope === null) {
        return {
          model: {
            ...model,
            signInMethod: method,
            botSeq: model.botSeq + 1,
            botProof: { _tag: "Idle" },
            localError: null,
            submitFailure: null,
          },
        };
      }
      const botSeq = model.botSeq + 1;
      return {
        model: {
          ...model,
          signInMethod: method,
          botSeq,
          botProof: { _tag: "Solving", seq: botSeq },
          localError: null,
          submitFailure: null,
        },
        commands: [startBotProof(scope, botSeq)],
      };
    },
    GotBotProof: ({ seq, status, header, reason }) => {
      if (seq !== model.botSeq || model.botProof._tag !== "Solving") return { model };
      const botProof: BotProofState =
        status === "not_required"
          ? { _tag: "NotRequired" }
          : status === "solved" && header !== null
            ? { _tag: "Solved", seq, header }
            : { _tag: "Failed", seq, reason: reason ?? "failed" };
      return { model: { ...model, botProof } };
    },
    ClickedRetryBotProof: () => {
      const scope = scopeForRoute(model.route, model.signInMethod, model.signUpMethod);
      if (scope === null) return { model };
      const botSeq = model.botSeq + 1;
      return {
        model: { ...model, botSeq, botProof: { _tag: "Solving", seq: botSeq }, localError: null },
        commands: [startBotProof(scope, botSeq)],
      };
    },
    GotInvitation: ({ seq, peek }) => {
      const invitation = Remote.succeed(model.invitation, seq, peek);
      if (invitation === model.invitation) return { model };
      return {
        model: {
          ...model,
          invitation,
          email: invitation._tag === "Loaded" ? peek.email : model.email,
        },
      };
    },
    FailedInvitation: ({ seq, failure }) => ({
      model: { ...model, invitation: Remote.fail(model.invitation, seq, failure) },
    }),
    ClickedRetryInvitation: () => {
      if (model.route._tag !== "SignUp" || model.route.invitation === undefined) return { model };
      const invitation = Remote.load(model.invitation);
      return {
        model: { ...model, invitation, localError: null },
        commands: [PeekInviteCmd({ token: model.route.invitation, seq: Remote.seqOf(invitation) })],
      };
    },
    SubmittedSignUp: () => {
      if (model.submitting || model.route._tag !== "SignUp") return { model };
      const route = model.route;
      const invite = invitationPath(model);
      const peek = Remote.dataOf(model.invitation);
      if (
        invite !== undefined &&
        (model.invitation._tag !== "Loaded" || peek?.status !== "pending")
      ) {
        return { model: { ...model, localError: local(ctx.locale, "invitationUnavailable") } };
      }
      const email = Str.trim(peek?.email ?? model.email);
      if (email === "") {
        return { model: { ...model, localError: local(ctx.locale, "emailRequired") } };
      }
      if (model.signUpMethod === "password" && model.password.length < 10) {
        return { model: { ...model, localError: local(ctx.locale, "passwordTooShort") } };
      }
      if (!model.acceptedTerms) {
        return { model: { ...model, localError: local(ctx.locale, "termsRequired") } };
      }
      if (!isBotProofReady(model.botProof)) {
        return { model: { ...model, localError: local(ctx.locale, "botWait") } };
      }
      const seq = model.submitSeq + 1;
      const displayName = Str.trim(model.name) || Str.split(email, "@")[0] || email;
      const isPasskeySignUp = model.signUpMethod === "passkey";
      const credentials = {
        email,
        name: displayName,
        password: model.password,
        callbackURL: signInPath(invite),
      };
      const signUpBody =
        route.invitation === undefined
          ? credentials
          : { ...credentials, invitationToken: route.invitation };
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          localError: null,
          submitFailure: null,
        },
        commands: [
          AuthPostCmd({
            seq,
            action: isPasskeySignUp ? "sign_up_passkey" : "sign_up",
            path: isPasskeySignUp ? "/sign-in/magic-link" : "/sign-up/email",
            body: isPasskeySignUp
              ? {
                  email,
                  name: displayName,
                  callbackURL: href({ _tag: "Account", tab: "security" }),
                }
              : signUpBody,
            altchaHeader: botProofHeader(model.botProof) ?? null,
          }),
        ],
      };
    },
    SubmittedSignIn: () => {
      if (model.submitting || model.route._tag !== "SignIn" || model.signInMethod === "passkey") {
        return { model };
      }
      const email = Str.trim(model.email);
      if (email === "") {
        return { model: { ...model, localError: local(ctx.locale, "emailRequired") } };
      }
      if (!isBotProofReady(model.botProof)) {
        return { model: { ...model, localError: local(ctx.locale, "botWait") } };
      }
      const seq = model.submitSeq + 1;
      if (model.signInMethod === "magic_link") {
        return {
          model: {
            ...model,
            submitSeq: seq,
            submitting: true,
            localError: null,
            submitFailure: null,
          },
          commands: [
            AuthPostCmd({
              seq,
              action: "sign_in_magic",
              path: "/sign-in/magic-link",
              body: {
                email,
                callbackURL: safeReturnTo(model.route.returnTo) ?? magicSignInCallback,
              },
              altchaHeader: botProofHeader(model.botProof) ?? null,
            }),
          ],
        };
      }
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          localError: null,
          submitFailure: null,
        },
        commands: [
          AuthPostCmd({
            seq,
            action: "sign_in_password",
            path: "/sign-in/email",
            body: { email, password: model.password },
            altchaHeader: botProofHeader(model.botProof) ?? null,
          }),
        ],
      };
    },
    ClickedPasskeySignIn: () => {
      if (model.submitting || model.route._tag !== "SignIn" || model.signInMethod !== "passkey") {
        return { model };
      }
      const seq = model.submitSeq + 1;
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          localError: null,
          submitFailure: null,
        },
        commands: [runPasskeyAuth(seq)],
      };
    },
    ClickedChangeEmail: () => {
      const scope = scopeForRoute(model.route, model.signInMethod, model.signUpMethod);
      if (scope === null) return { model };
      const botSeq = model.botSeq + 1;
      return {
        model: { ...model, linkState: "idle", botSeq, botProof: { _tag: "Solving", seq: botSeq } },
        commands: [startBotProof(scope, botSeq)],
      };
    },
    ClickedResendEmail: () => {
      const seq = model.submitSeq + 1;
      return {
        model: { ...model, submitSeq: seq, submitting: true, submitFailure: null },
        commands: [
          AuthPostCmd({
            seq,
            action: "resend",
            path: "/send-verification-email",
            body: { email: model.email },
            altchaHeader: null,
          }),
        ],
      };
    },
    SubmittedResetRequest: () => {
      const email = Str.trim(model.email);
      if (email === "") {
        return { model: { ...model, localError: local(ctx.locale, "emailRequired") } };
      }
      if (!isBotProofReady(model.botProof)) {
        return { model: { ...model, localError: local(ctx.locale, "botWait") } };
      }
      const seq = model.submitSeq + 1;
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          localError: null,
          submitFailure: null,
        },
        commands: [
          AuthPostCmd({
            seq,
            action: "reset_request",
            path: "/request-password-reset",
            body: { email },
            altchaHeader: botProofHeader(model.botProof) ?? null,
          }),
        ],
      };
    },
    SubmittedResetConfirm: () => {
      if (model.password.length < 10) {
        return { model: { ...model, localError: local(ctx.locale, "passwordTooShort") } };
      }
      if (model.password !== model.confirmPassword) {
        return { model: { ...model, localError: local(ctx.locale, "passwordsMismatch") } };
      }
      const seq = model.submitSeq + 1;
      const route = model.route;
      if (route._tag !== "ResetPassword") return { model };
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          localError: null,
          submitFailure: null,
        },
        commands: [
          AuthPostCmd({
            seq,
            action: "reset_confirm",
            path: "/reset-password",
            body: { token: route.token ?? "", newPassword: model.password },
            altchaHeader: null,
          }),
        ],
      };
    },
    CompletedSubmit: ({ seq, action, sessionEstablished }) => {
      if (seq !== model.submitSeq) return { model };
      const t = translator(ctx.locale);
      switch (action) {
        case "sign_up": {
          if (sessionEstablished === true) {
            if (model.route._tag === "SignUp" && model.route.invitation !== undefined) {
              return {
                model: { ...model, password: "" },
                commands: [AcceptSignedUpInviteCmd({ token: model.route.invitation, seq })],
              };
            }
            return {
              model: { ...model, submitting: false, password: "" },
              outMessage: Intent_.reloadSession({ _tag: "DefaultSignedIn" }),
            };
          }
          return {
            model: { ...model, submitting: false, password: "" },
            outMessage: Intent_.navigate(
              href({ _tag: "CheckEmail", email: Str.trim(model.email) }),
            ),
          };
        }
        case "sign_up_passkey":
        case "sign_in_magic":
          return { model: { ...model, submitting: false, linkState: "sent" } };
        case "reset_request":
          return {
            model: { ...model, submitting: false },
            outMessage: Intent_.navigate(
              href({ _tag: "CheckEmail", email: Str.trim(model.email) }),
              false,
            ),
          };
        case "sign_in_password":
        case "sign_in_passkey": {
          const returnTo =
            model.route._tag === "SignIn" ? safeReturnTo(model.route.returnTo) : undefined;
          return {
            model: { ...model, submitting: false },
            outMessage:
              returnTo !== undefined
                ? Intent_.reloadSession({ _tag: "Path", path: returnTo, replace: true })
                : Intent_.reloadSession({ _tag: "DefaultSignedIn" }),
          };
        }
        case "resend":
          return {
            model: {
              ...model,
              submitting: false,
              resent: true,
              infoNotice: t.t("auth.checkEmail.resent"),
            },
          };
        case "verify_link":
          return {
            model: { ...model, submitting: false, linkState: "verified" },
            outMessage:
              model.route._tag === "AuthLink" && model.route.kind === "magic"
                ? Intent_.reloadSession({ _tag: "DefaultSignedIn" })
                : undefined,
          };
        case "reset_confirm":
          return {
            model: { ...model, submitting: false, resetDone: true },
          };
      }
    },
    CompletedInvitationSignUp: ({ seq, workspace }) =>
      seq !== model.submitSeq
        ? { model }
        : {
            model: { ...model, submitting: false },
            outMessage: Intent_.reloadSession({
              _tag: "Path",
              path: href({ _tag: "Dashboard", ws: workspace.slug }),
              replace: true,
            }),
          },
    FailedInvitationSignUp: ({ seq }) => {
      const invite = invitationPath(model);
      return seq !== model.submitSeq || invite === undefined
        ? { model }
        : {
            model: { ...model, submitting: false },
            outMessage: Intent_.reloadSession({ _tag: "Path", path: invite, replace: true }),
          };
    },
    FailedSubmit: ({ seq, failure }) => {
      if (seq !== model.submitSeq) return { model };
      if (model.route._tag === "AuthLink") {
        return {
          model: { ...model, submitting: false, linkState: "expired", submitFailure: failure },
        };
      }
      // If the server rejected the bot proof, automatically fetch a fresh challenge.
      const scope = scopeForRoute(model.route, model.signInMethod, model.signUpMethod);
      if (failure.freshBotProof && scope !== null) {
        const botSeq = model.botSeq + 1;
        return {
          model: {
            ...model,
            submitting: false,
            submitFailure: failure,
            botSeq,
            botProof: { _tag: "Solving", seq: botSeq },
          },
          commands: [startBotProof(scope, botSeq)],
        };
      }
      return {
        model: { ...model, submitting: false, submitFailure: failure },
      };
    },
    FailedPasskeyUnsupported: ({ seq }) =>
      seq !== model.submitSeq
        ? { model }
        : {
            model: {
              ...model,
              submitting: false,
              localError: translator(ctx.locale).t("auth.passkey.unsupported"),
            },
          },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  switch (model.route._tag) {
    case "SignUp":
      return t.t("auth.signUp.title");
    case "SignIn":
      return t.t("auth.signIn.title");
    case "CheckEmail":
      return t.t("auth.checkEmail.title");
    case "AuthLink":
      return model.linkState === "expired"
        ? t.t("auth.link.expired.title")
        : t.t("auth.link.verifying");
    case "ResetPassword":
      return t.t("auth.resetPassword.title");
    default:
      return t.t("auth.signIn.title");
  }
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const botProofBar = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  if (model.botProof._tag === "Idle" || model.botProof._tag === "NotRequired") return h.text("");
  if (model.botProof._tag === "Solving") {
    return h.div
      .class("kb-bot-proof")
      .attr("role", "status")
      .attr("aria-live", "polite")
      .children([h.span.children([t.t("auth.botProof.verifying")])]);
  }
  if (model.botProof._tag === "Solved") {
    return h.div
      .class("kb-bot-proof kb-bot-proof--verified")
      .attr("role", "status")
      .children([
        h.span.class("kb-row").children([icon(h, "check", 16), t.t("auth.botProof.verified")]),
      ]);
  }
  return h.div
    .class("kb-bot-proof kb-bot-proof--failed")
    .attr("role", "alert")
    .children([
      h.span.children([t.t("auth.botProof.failed")]),
      button(h, {
        label: local(ctx.locale, "retryCheck"),
        onClick: Message.ClickedRetryBotProof(),
        small: true,
      }),
    ]);
};

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const errorText =
    model.localError ??
    (model.submitFailure !== null ? failureMessage(t, model.submitFailure) : null);

  const body = (() => {
    if (model.linkState === "sent") {
      return h.div.class("kb-auth-form").children([
        h.h1.children([t.t("auth.checkEmail.title")]),
        h.p.class("kb-muted").children([t.t("auth.checkEmail.body", { email: model.email })]),
        button(h, {
          label: local(ctx.locale, "changeEmail"),
          onClick: Message.ClickedChangeEmail(),
          variant: "secondary",
        }),
      ]);
    }
    switch (model.route._tag) {
      case "SignUp": {
        const invited = Remote.dataOf(model.invitation);
        const invite = invitationPath(model);
        const emailLocked = invite !== undefined;
        const inviteReady = model.invitation._tag === "Loaded" && invited?.status === "pending";
        return h.div.class("kb-auth-form").children([
          h.div
            .class("kb-auth-header")
            .children([
              h.h1.children([t.t("auth.signUp.title")]),
              h.p.class("kb-muted").children([t.t("auth.signUp.subtitle")]),
            ]),
          ...(invited !== undefined
            ? [banner(h, { text: t.t("auth.signUp.invitationNote"), tone: "info" })]
            : []),
          ...(model.invitation._tag === "Failed"
            ? [
                banner(h, { text: local(ctx.locale, "invitationUnavailable"), tone: "error" }),
                button(h, {
                  label: t.t("common.action.retry"),
                  onClick: Message.ClickedRetryInvitation(),
                  variant: "secondary",
                }),
              ]
            : []),
          ...(errorText !== null ? [banner(h, { text: errorText, tone: "error" })] : []),
          ...(emailLocked
            ? []
            : [
                segmented(h, {
                  label: t.t("auth.signUp.title"),
                  selected: model.signUpMethod,
                  items: [
                    { id: "password", label: t.t("auth.signUp.methodPassword") },
                    { id: "passkey", label: t.t("auth.signUp.methodPasskey") },
                  ],
                  onSelect: (id) =>
                    Message.SelectedSignUpMethod({
                      method: id === "passkey" ? "passkey" : "password",
                    }),
                }),
              ]),
          textField(h, {
            id: "auth-signup-email",
            label: t.t("common.field.email"),
            type: "email",
            value: model.email,
            onInput: (value) => Message.ChangedEmail({ value }),
            autocomplete: "email",
            required: true,
            disabled: emailLocked,
            error: fieldIssue(t, model.submitFailure, "email"),
          }),
          textField(h, {
            id: "auth-signup-name",
            label: local(ctx.locale, "fullName"),
            value: model.name,
            onInput: (value) => Message.ChangedName({ value }),
            autocomplete: "name",
          }),
          ...(model.signUpMethod === "password"
            ? [
                textField(h, {
                  id: "auth-signup-password",
                  label: t.t("common.field.password"),
                  type: "password",
                  value: model.password,
                  onInput: (value) => Message.ChangedPassword({ value }),
                  hint: t.t("auth.signUp.passwordHint"),
                  autocomplete: "new-password",
                  required: true,
                  error: fieldIssue(t, model.submitFailure, "password"),
                }),
              ]
            : [h.p.class("kb-small kb-muted").children([local(ctx.locale, "passkeySignUpHint")])]),
          checkbox(h, {
            id: "auth-signup-terms",
            label: t.t("auth.signUp.acceptTerms"),
            checked: model.acceptedTerms,
            onToggle: (checked) => Message.ToggledTerms({ checked }),
          }),
          botProofBar(model, ctx, h),
          button(h, {
            label: t.t("auth.signUp.submit"),
            onClick: Message.SubmittedSignUp(),
            variant: "primary",
            busy: model.submitting,
            disabled:
              model.submitting || !isBotProofReady(model.botProof) || (emailLocked && !inviteReady),
            testId: "auth-signup-submit",
          }),
          h.div
            .class("kb-auth-footer")
            .children([
              h.span.children([t.t("auth.signUp.haveAccount")]),
              h.a.attr("href", signInPath(invite)).children([local(ctx.locale, "signInNow")]),
            ]),
        ]);
      }

      case "SignIn": {
        return h.div.class("kb-auth-form").children([
          h.div.class("kb-auth-header").children([h.h1.children([t.t("auth.signIn.title")])]),
          ...(errorText !== null ? [banner(h, { text: errorText, tone: "error" })] : []),
          segmented(h, {
            label: t.t("auth.signIn.title"),
            selected: model.signInMethod,
            items: [
              { id: "password", label: t.t("auth.signIn.withPassword") },
              { id: "magic_link", label: t.t("auth.signIn.withMagicLink") },
              { id: "passkey", label: t.t("auth.signIn.withPasskey") },
            ],
            onSelect: (id) =>
              Message.SelectedSignInMethod({
                method:
                  id === "magic_link" ? "magic_link" : id === "passkey" ? "passkey" : "password",
              }),
          }),
          ...(model.signInMethod === "passkey"
            ? [
                h.p.class("kb-muted").children([t.t("auth.passkey.prompt")]),
                button(h, {
                  label: t.t("auth.signIn.withPasskey"),
                  onClick: Message.ClickedPasskeySignIn(),
                  variant: "primary",
                  icon: icon(h, "key", 16),
                  busy: model.submitting,
                  disabled: model.submitting,
                  testId: "auth-passkey-btn",
                }),
              ]
            : [
                textField(h, {
                  id: "auth-signin-email",
                  label: t.t("common.field.email"),
                  type: "email",
                  value: model.email,
                  onInput: (value) => Message.ChangedEmail({ value }),
                  autocomplete: "email",
                  required: true,
                  error: fieldIssue(t, model.submitFailure, "email"),
                }),
                ...(model.signInMethod === "password"
                  ? [
                      textField(h, {
                        id: "auth-signin-password",
                        label: t.t("common.field.password"),
                        type: "password",
                        value: model.password,
                        onInput: (value) => Message.ChangedPassword({ value }),
                        autocomplete: "current-password",
                        required: true,
                        error: fieldIssue(t, model.submitFailure, "password"),
                      }),
                    ]
                  : []),
                botProofBar(model, ctx, h),
                button(h, {
                  label:
                    model.signInMethod === "magic_link"
                      ? t.t("auth.signIn.sendLink")
                      : t.t("auth.signIn.submit"),
                  onClick: Message.SubmittedSignIn(),
                  variant: "primary",
                  busy: model.submitting,
                  disabled: model.submitting || !isBotProofReady(model.botProof),
                  testId: "auth-signin-submit",
                }),
              ]),
          h.div
            .class("kb-auth-footer")
            .children([
              h.a
                .attr("href", href({ _tag: "ResetPassword" }))
                .children([local(ctx.locale, "forgotLink")]),
              h.a
                .attr("href", href({ _tag: "SignUp" }))
                .children([local(ctx.locale, "signUpLink")]),
            ]),
        ]);
      }

      case "CheckEmail": {
        return h.div.class("kb-auth-form").children([
          h.div
            .class("kb-auth-header")
            .children([
              h.div
                .class("kb-row")
                .children([icon(h, "mail", 22), h.h1.children([t.t("auth.checkEmail.title")])]),
              h.p.class("kb-muted").children([t.t("auth.checkEmail.body", { email: model.email })]),
            ]),
          ...(model.infoNotice !== null
            ? [banner(h, { text: model.infoNotice, tone: "info" })]
            : []),
          ...(errorText !== null ? [banner(h, { text: errorText, tone: "error" })] : []),
          button(h, {
            label: t.t("auth.checkEmail.resend"),
            onClick: Message.ClickedResendEmail(),
            variant: "secondary",
            busy: model.submitting,
            disabled: model.submitting,
          }),
          h.div
            .class("kb-auth-footer")
            .children([
              h.a
                .attr("href", href({ _tag: "SignIn" }))
                .children([t.t("auth.checkEmail.wrongEmail")]),
            ]),
        ]);
      }

      case "AuthLink": {
        if (model.linkState === "verified") {
          return h.div.class("kb-auth-form").children([
            banner(h, { text: local(ctx.locale, "verifySignIn"), tone: "info" }),
            h.a
              .class("kb-btn kb-btn--primary")
              .attr("href", signInPath(undefined))
              .children([local(ctx.locale, "signInNow")]),
          ]);
        }
        if (model.linkState === "expired") {
          return h.div.class("kb-auth-form").children([
            h.h1.children([t.t("auth.link.expired.title")]),
            h.p.class("kb-muted").children([t.t("auth.link.expired.body")]),
            h.a
              .class("kb-btn kb-btn--primary")
              .attr("href", href({ _tag: "SignIn" }))
              .children([t.t("auth.link.sendNew")]),
          ]);
        }
        return h.div
          .class("kb-auth-form")
          .attr("aria-busy", String(true))
          .children([h.h1.children([t.t("auth.link.verifying")])]);
      }

      case "ResetPassword": {
        if (model.resetDone) {
          return h.div.class("kb-auth-form").children([
            banner(h, { text: t.t("auth.resetPassword.done"), tone: "info" }),
            h.a
              .class("kb-btn kb-btn--primary")
              .attr("href", href({ _tag: "SignIn" }))
              .children([local(ctx.locale, "signInNow")]),
          ]);
        }
        if (model.route.token !== undefined) {
          return h.div.class("kb-auth-form").children([
            h.h1.children([t.t("auth.resetPassword.title")]),
            ...(errorText !== null ? [banner(h, { text: errorText, tone: "error" })] : []),
            textField(h, {
              id: "auth-reset-new",
              label: t.t("auth.resetPassword.newPassword"),
              type: "password",
              value: model.password,
              onInput: (value) => Message.ChangedPassword({ value }),
              hint: t.t("auth.signUp.passwordHint"),
              autocomplete: "new-password",
              required: true,
            }),
            textField(h, {
              id: "auth-reset-confirm",
              label: t.t("auth.resetPassword.confirmPassword"),
              type: "password",
              value: model.confirmPassword,
              onInput: (value) => Message.ChangedConfirmPassword({ value }),
              autocomplete: "new-password",
              required: true,
            }),
            button(h, {
              label: t.t("auth.resetPassword.submit"),
              onClick: Message.SubmittedResetConfirm(),
              variant: "primary",
              busy: model.submitting,
              disabled: model.submitting,
            }),
          ]);
        }
        return h.div.class("kb-auth-form").children([
          h.div
            .class("kb-auth-header")
            .children([
              h.h1.children([t.t("auth.resetPassword.title")]),
              h.p.class("kb-muted").children([t.t("auth.resetPassword.requestBody")]),
            ]),
          ...(errorText !== null ? [banner(h, { text: errorText, tone: "error" })] : []),
          textField(h, {
            id: "auth-reset-email",
            label: t.t("common.field.email"),
            type: "email",
            value: model.email,
            onInput: (value) => Message.ChangedEmail({ value }),
            autocomplete: "email",
            required: true,
          }),
          botProofBar(model, ctx, h),
          button(h, {
            label: t.t("auth.resetPassword.send"),
            onClick: Message.SubmittedResetRequest(),
            variant: "primary",
            busy: model.submitting,
            disabled: model.submitting || !isBotProofReady(model.botProof),
          }),
          h.div.class("kb-auth-footer").children([
            h.a
              .attr("href", href({ _tag: "SignIn" }))
              // biome-ignore lint/security/noSecrets: This is static user-facing copy or a translation key.
              .children([local(ctx.locale, "backToSignIn")]),
          ]),
        ]);
      }

      default:
        return h.text("");
    }
  })();

  return h.div
    .class("kb-auth-shell")
    .children([
      card(
        h,
        [h.div.class("kb-row").children([lockup(h, "horizontal", 22)]), body],
        [attribute("class", "kb-card kb-auth-card")],
      ),
    ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
