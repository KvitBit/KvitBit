import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 05 — Workspace Invitation Landing (/invite/:token).
 * Previews workspace, inviter, role, and invited email; supports accept/decline for signed-in
 * matching users, wrong-account guidance, and sign-in/sign-up redirects when anonymous.
 */
import { InvitationPeek, WorkspaceSummary } from "@kvitbit/domain";
import { Format, I18n, ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { attribute } from "../../ui/html";
import { icon } from "../../ui/icons";
import { badge, banner, button, card, dl, linkButton, skeleton } from "../../ui/kit";
import { callApi, failureMessage } from "./_shared";

export type Route = RouteOf<"Invitation">;

const InviteRemote = Remote.remoteSchema(InvitationPeek);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  token: Schema.String,
  peek: InviteRemote,
  acceptSeq: Remote.Seq,
  accepting: Schema.Boolean,
  acceptFailure: Schema.NullOr(Failure),
  declined: Schema.Boolean,
  acceptedWorkspace: Schema.NullOr(WorkspaceSummary),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  GotPeek: { seq: Remote.Seq, peek: InvitationPeek },
  FailedPeek: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  ClickedAccept: {},
  ClickedDecline: {},
  CompletedAccept: { seq: Remote.Seq, workspace: WorkspaceSummary },
  FailedAccept: { seq: Remote.Seq, failure: Failure },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    decline: "Odmítnout",
    declinedNotice:
      "Pozvánku jste odmítli. Můžete toto okno zavřít nebo se vrátit na úvodní stránku.",
    backHome: "Zpět na úvodní stránku",
    invitedEmail: "Pozvaný e-mail",
    roleLabel: "Role",
    expiresLabel: "Platnost do",
    switchAccount: "Přihlásit se jiným účtem",
    joinedNotice: "Připojeno k pracovnímu prostoru {workspace}.",
  },
  en: {
    decline: "Decline",
    declinedNotice: "You declined this invitation. You can close this page or return home.",
    backHome: "Back to home",
    invitedEmail: "Invited email",
    roleLabel: "Role",
    expiresLabel: "Expires",
    switchAccount: "Sign in with another account",
    joinedNotice: "Joined {workspace}.",
  },
});

const FetchPeek = defineApiCommand("InvitationPeek", {
  args: { token: Schema.String, seq: Remote.Seq },
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.invitations.peek({ params: { token: token as never } }),
      (peek) => Message.GotPeek({ seq, peek }),
      (failure) => Message.FailedPeek({ seq, failure }),
    ),
});

const AcceptInvite = defineApiCommand("InvitationAccept", {
  args: { token: Schema.String, seq: Remote.Seq },
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.invitations.accept({ params: { token: token as never } }),
      (workspace) => Message.CompletedAccept({ seq, workspace }),
      (failure) => Message.FailedAccept({ seq, failure }),
    ),
});

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const peek = Remote.load(Remote.idle);
  const seq = Remote.seqOf(peek);
  return {
    model: {
      route,
      token: route.token,
      peek,
      acceptSeq: 0,
      accepting: false,
      acceptFailure: null,
      declined: false,
      acceptedWorkspace: null,
    },
    commands: [FetchPeek({ token: route.token, seq })],
  };
};

export const update = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match(message, {
    GotPeek: ({ seq, peek }) => ({
      model: { ...model, peek: Remote.succeed(model.peek, seq, peek) },
    }),
    FailedPeek: ({ seq, failure }) => ({
      model: { ...model, peek: Remote.fail(model.peek, seq, failure) },
    }),
    ClickedRetry: () => {
      const peek = Remote.load(model.peek);
      const seq = Remote.seqOf(peek);
      return {
        model: { ...model, peek },
        commands: [FetchPeek({ token: model.token, seq })],
      };
    },
    ClickedAccept: () => {
      const seq = model.acceptSeq + 1;
      return {
        model: { ...model, acceptSeq: seq, accepting: true, acceptFailure: null },
        commands: [AcceptInvite({ token: model.token, seq })],
      };
    },
    ClickedDecline: () => ({
      model: { ...model, declined: true },
    }),
    CompletedAccept: ({ seq, workspace }) => {
      if (seq !== model.acceptSeq) return { model };
      return {
        model: { ...model, accepting: false, acceptedWorkspace: workspace },
        outMessage: Intent_.reloadSession(),
      };
    },
    FailedAccept: ({ seq, failure }) => {
      if (seq !== model.acceptSeq) return { model };
      return { model: { ...model, accepting: false, acceptFailure: failure } };
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  const peek = Remote.dataOf(model.peek);
  return peek !== undefined
    ? t.t("invitation.landing.title", { workspace: peek.workspaceName })
    : t.t("invitation.landing.notFound");
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);

  if (model.peek._tag === "Loading" || model.peek._tag === "Idle") {
    return h.div
      .class("kb-invite-shell")
      .attr("aria-busy", String(true))
      .children([
        card(
          h,
          [
            skeleton(h, "65%", "1.5rem"),
            skeleton(h, "100%", "4rem"),
            skeleton(h, "50%", "2.25rem"),
          ],
          [attribute("class", "kb-card kb-invite-card")],
        ),
      ]);
  }

  if (model.peek._tag === "Failed") {
    const missing = model.peek.failure.tag === "NotFound";
    return h.div.class("kb-invite-shell").children([
      card(
        h,
        [
          h.div
            .class("kb-row")
            .children([
              icon(h, "alert", 20),
              h.h1.children([
                missing ? t.t("invitation.landing.notFound") : t.t("common.state.error"),
              ]),
            ]),
          ...(!missing
            ? [
                h.p.class("kb-muted").children([failureMessage(t, model.peek.failure)]),
                h.div.class("kb-row").children([
                  button(h, {
                    label: t.t("common.action.retry"),
                    onClick: Message.ClickedRetry(),
                    variant: "primary",
                  }),
                ]),
              ]
            : [
                linkButton(h, {
                  label: local(ctx.locale, "backHome"),
                  href: href({ _tag: "Landing" }),
                  variant: "secondary",
                }),
              ]),
        ],
        [attribute("class", "kb-card kb-invite-card")],
      ),
    ]);
  }

  if (model.acceptedWorkspace !== null) {
    return h.div.class("kb-invite-shell").children([
      card(
        h,
        [
          banner(h, {
            text: local(ctx.locale, "joinedNotice", { workspace: model.acceptedWorkspace.name }),
            tone: "info",
          }),
          h.div.class("kb-row").children([
            linkButton(h, {
              label: t.t("invitation.landing.open"),
              href: href({ _tag: "Dashboard", ws: model.acceptedWorkspace.slug }),
              variant: "primary",
            }),
          ]),
        ],
        [attribute("class", "kb-card kb-invite-card")],
      ),
    ]);
  }

  const peek = model.peek.data;
  const roleLabel = t.translate(I18n.enumText("role", peek.role));
  const statusLabel = t.translate(I18n.enumText("invitationStatus", peek.status));
  const statusBadgeTone =
    peek.status === "pending" ? "proforma" : peek.status === "accepted" ? "paid" : "error";

  const wrongAccount =
    ctx.session._tag === "SignedIn" &&
    ctx.session.user.email.toLowerCase() !== peek.email.toLowerCase();

  return h.div.class("kb-invite-shell").children([
    card(
      h,
      [
        h.div
          .class("kb-spread")
          .children([
            h.h1.children([t.t("invitation.landing.title", { workspace: peek.workspaceName })]),
            badge(h, statusLabel, statusBadgeTone),
          ]),
        h.p.class("kb-muted").children([
          t.t("invitation.landing.body", {
            inviter: peek.inviterName,
            workspace: peek.workspaceName,
            role: roleLabel,
          }),
        ]),
        dl(h, [
          [local(ctx.locale, "invitedEmail"), peek.email],
          [local(ctx.locale, "roleLabel"), roleLabel],
          [
            local(ctx.locale, "expiresLabel"),
            Format.formatDate(ctx.locale, peek.expiresAt.slice(0, 10)),
          ],
        ]),
        ...(model.acceptFailure !== null
          ? [banner(h, { text: failureMessage(t, model.acceptFailure), tone: "error" })]
          : []),
        ...(model.declined
          ? [
              banner(h, { text: local(ctx.locale, "declinedNotice"), tone: "neutral" }),
              linkButton(h, {
                label: local(ctx.locale, "backHome"),
                href: href({ _tag: "Landing" }),
                variant: "secondary",
              }),
            ]
          : peek.status === "expired"
            ? [banner(h, { text: t.t("invitation.landing.expired"), tone: "error" })]
            : peek.status === "revoked"
              ? [banner(h, { text: t.t("invitation.landing.revoked"), tone: "error" })]
              : peek.status === "accepted"
                ? [
                    banner(h, { text: t.t("invitation.landing.accepted"), tone: "info" }),
                    linkButton(h, {
                      label: local(ctx.locale, "backHome"),
                      href: href({ _tag: "Landing" }),
                      variant: "secondary",
                    }),
                  ]
                : ctx.session._tag === "Anonymous"
                  ? [
                      h.div.class("kb-row").children([
                        linkButton(h, {
                          label: t.t("invitation.landing.signUpToAccept"),
                          href: href({ _tag: "SignUp", invitation: model.token }),
                          variant: "primary",
                        }),
                        linkButton(h, {
                          label: t.t("invitation.landing.signInToAccept"),
                          href: href({ _tag: "SignIn", returnTo: href(model.route) }),
                          variant: "secondary",
                        }),
                      ]),
                    ]
                  : wrongAccount
                    ? [
                        banner(h, {
                          text: t.t("invitation.landing.wrongAccount", { email: peek.email }),
                          tone: "error",
                        }),
                        linkButton(h, {
                          label: local(ctx.locale, "switchAccount"),
                          href: href({ _tag: "SignIn", returnTo: href(model.route) }),
                          variant: "secondary",
                        }),
                      ]
                    : [
                        h.div.class("kb-spread").children([
                          button(h, {
                            label: local(ctx.locale, "decline"),
                            onClick: Message.ClickedDecline(),
                            variant: "ghost",
                            disabled: model.accepting,
                          }),
                          button(h, {
                            label: t.t("invitation.landing.accept"),
                            onClick: Message.ClickedAccept(),
                            variant: "primary",
                            busy: model.accepting,
                            disabled: model.accepting,
                            testId: "invitation-accept",
                          }),
                        ]),
                      ]),
      ],
      [attribute("class", "kb-card kb-invite-card")],
    ),
  ]);
};
