/**
 * Screen 03 — Error pages (404 Not Found, 403 No Access, 500 Server Error, Offline)
 * with context-aware recovery links.
 */
import { ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import { href } from "../../app/routing";
import { icon } from "../../ui/icons";
import { button, card, linkButton } from "../../ui/kit";

export type Route = RouteOf<"Error">;

export const Model = Schema.Struct({
  route: ViewModels.Route,
  kind: Schema.Literals(["not_found", "no_access", "server", "offline"]),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
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

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => ({
  model: { route, kind: route.kind },
});

export const update = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
    ClickedRetry: () => ({
      model,
      outMessage: Intent_.reloadSession(),
    }),
  });

export const title = (model: Model, ctx: PageContext): string => {
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

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
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

  return h.div(
    [h.Class("kb-error-shell")],
    [
      card(
        h,
        [
          h.div(
            [h.Class("kb-row")],
            [icon(h, "alert", 20), h.span([h.Class("kb-error-code")], [CODE[model.kind]])],
          ),
          h.h1([], [heading]),
          h.p([h.Class("kb-muted")], [body]),
          ...(model.kind === "no_access" && workspaces.length > 0
            ? [
                h.hr([h.Class("kb-divider")]),
                h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "workspacesTitle")]),
                h.div(
                  [h.Class("kb-row")],
                  workspaces.map((ws) =>
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
          h.div(
            [h.Class("kb-row"), h.Style({ marginTop: "6px" })],
            [
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
            ],
          ),
        ],
        [h.Class("kb-card kb-error-card"), h.DataAttribute("error-kind", model.kind)],
      ),
    ],
  );
});
