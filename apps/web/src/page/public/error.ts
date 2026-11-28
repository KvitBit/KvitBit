import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 03 — Error pages (404 Not Found, 403 No Access, 500 Server Error, Offline)
 * with context-aware recovery links.
 */
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import { href } from "../../app/routing";
import { attribute } from "../../ui/html";
import { icon } from "../../ui/icons";
import { button, card, linkButton, separator } from "../../ui/kit";
import { cn, ui } from "../../ui/styles";

export const Route = RouteCases.Error;
export type Route = typeof Route.Type;

export const Model = Schema.Struct({
  route: Route,
  kind: Schema.Literals(["not_found", "no_access", "server", "offline"]),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  ClickedRetry: {},
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    backHome: "Zpět na úvodní stránku",
    signIn: "Přihlásit se",
    createWorkspace: "Vytvořit pracovní prostor",
    workspacesTitle: "Vaše pracovní prostory",
  },
  en: {
    backHome: "Back to home",
    signIn: "Sign in",
    createWorkspace: "Create workspace",
    workspacesTitle: "Your workspaces",
  },
});

const CODE: Readonly<Record<Model["kind"], string>> = {
  not_found: "404",
  no_access: "403",
  server: "500",
  offline: "OFFLINE",
};

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => ({
  model: { route, kind: route.kind },
});

export const init: {
  (_ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match(message, {
    ClickedRetry: () => ({
      model,
      outMessage: Intent_.reloadSession(),
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, _ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  switch (model.kind) {
    case "not_found":
      return t.t("public.error.not_found.title");
    case "no_access":
      return t.t("public.error.no_access.title");
    case "server":
      return t.t("public.error.server.title");
    case "offline":
      return t.t("public.error.offline.title");
  }
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const heading = title(model, ctx);
  const body =
    model.kind === "not_found"
      ? t.t("public.error.not_found.body")
      : model.kind === "no_access"
        ? t.t("public.error.no_access.body")
        : model.kind === "server"
          ? t.t("public.error.server.body")
          : t.t("public.error.offline.body");

  const workspaces = ctx.session._tag === "SignedIn" ? ctx.session.workspaces : [];
  const firstWs = workspaces[0];

  return h.div.class("grid flex-1 place-items-center px-4 pt-10 pb-16").children([
    card(
      h,
      [
        h.div
          .class(ui.row)
          .children([
            icon(h, "alert", 20),
            h.span
              .class("font-mono text-[0.75rem] uppercase tracking-[0.08em] text-on-surface-variant")
              .children([CODE[model.kind]]),
          ]),
        h.h1.children([heading]),
        h.p.class(ui.muted).children([body]),
        ...(model.kind === "no_access" && workspaces.length > 0
          ? [
              separator(h),
              h.span.class(cn(ui.small, ui.muted)).children([local(ctx.locale, "workspacesTitle")]),
              h.div.class(ui.row).children(
                Arr.map(workspaces, (ws) =>
                  linkButton(h, {
                    label: ws.name,
                    href: href({ _tag: "Dashboard", ws: ws.slug }),
                    variant: "secondary",
                    small: true,
                  }),
                ),
              ),
            ]
          : []),
        h.div.class(cn(ui.row, "mt-1.5")).children([
          ...(model.kind === "server" || model.kind === "offline"
            ? [
                button(h, {
                  label: t.t("common.action.retry"),
                  onClick: Message.ClickedRetry(),
                  variant: "primary",
                }),
              ]
            : []),
          ...(firstWs !== undefined
            ? [
                linkButton(h, {
                  label: t.t("common.action.goHome"),
                  href: href({ _tag: "Dashboard", ws: firstWs.slug }),
                  variant: model.kind === "not_found" ? "primary" : "secondary",
                }),
              ]
            : [
                linkButton(h, {
                  label: local(ctx.locale, "backHome"),
                  href: href({ _tag: "Landing" }),
                  variant: model.kind === "not_found" ? "primary" : "secondary",
                }),
              ]),
          ...(model.kind === "no_access" && ctx.session._tag === "Anonymous"
            ? [
                linkButton(h, {
                  label: local(ctx.locale, "signIn"),
                  href: href({ _tag: "SignIn" }),
                  variant: "primary",
                }),
              ]
            : []),
          ...(model.kind === "no_access" && ctx.session._tag === "SignedIn"
            ? [
                linkButton(h, {
                  label: local(ctx.locale, "createWorkspace"),
                  href: href({ _tag: "Onboarding" }),
                  variant: "ghost",
                }),
              ]
            : []),
        ]),
      ],
      [attribute("data-error-kind", model.kind)],
      false,
      "flex w-[min(520px,100%)] flex-col gap-3.5 p-7",
    ),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
