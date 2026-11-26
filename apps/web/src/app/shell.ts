import type { Html } from "@effect/ui/html";
/**
 * Shell chrome (screen 06). Public and account routes get the public header and footer; workspace
 * routes get the desktop sidebar with the workspace switcher, a top bar, and the mobile M3
 * navigation bar. The theme stylesheet is rendered here (app/theme.ts).
 */
import type { WorkspaceSummary } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { Option } from "effect";
import { lockup, mark } from "../ui/brand";
import { type Markup, withAttributes } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { linkButton, skeleton } from "../ui/kit";
import { compactPrefs } from "../ui/prefs-controls";
import type { RunApi } from "./commands";
import { copy, type Translator, translator } from "./i18n";
import type { PageContext } from "./page";
import { viewPage } from "./pages";
import { Message, type Model } from "./root";
import { defaultReportRoute, href } from "./routing";
import { rootNode, themeStyle } from "./theme";

const text = copy({
  cs: {
    signIn: "Přihlásit se",
    signUp: "Začít zdarma",
    signOut: "Odhlásit se",
    account: "Účet",
    terms: "Obchodní podmínky",
    privacy: "Ochrana osobních údajů",
    android: "Aplikace pro Android",
    rights: "© {year} Kvitbit",
    mainNav: "Hlavní navigace",
    dismiss: "Zavřít",
  },
  en: {
    signIn: "Sign in",
    signUp: "Start for free",
    signOut: "Sign out",
    account: "Account",
    terms: "Terms of service",
    privacy: "Privacy policy",
    android: "Android app",
    rights: "© {year} Kvitbit",
    mainNav: "Main navigation",
    dismiss: "Dismiss",
  },
});

const tr = (ctx: PageContext): Translator => translator(ctx.locale);

const NAV_ICON: Readonly<Record<ViewModels.NavSection, IconName>> = {
  dashboard: "dashboard",
  documents: "documents",
  templates: "templates",
  expenses: "expenses",
  contacts: "contacts",
  priceList: "priceList",
  reports: "reports",
  settings: "settings",
  more: "more",
};

const sectionHref = (
  section: ViewModels.NavSection,
  ws: string,
  route: PageContext["route"],
): string =>
  Option.match(ViewModels.sectionRoute(section, ws as WorkspaceSummary["slug"], route), {
    onNone: () => href(defaultReportRoute(ws, new Date().getFullYear())),
    onSome: href,
  });

const navItems = (
  h: Html.H<Message>,
  ctx: PageContext,
  ws: string,
  sections: ReadonlyArray<ViewModels.NavSection>,
  platform: "web" | "mobile",
): ReadonlyArray<Markup<Message, RunApi>> => {
  const active = Option.getOrUndefined(ViewModels.activeSection(ctx.route, platform));
  return sections.map((section) =>
    withAttributes(h.a.class(), [
      (element) => element.class("kb-nav__item"),
      (element) => element.attr("href", sectionHref(section, ws, ctx.route)),
      (node) => (active === section ? node.attr("aria-current", "page") : node),
    ]).children([
      icon(h, NAV_ICON[section]),
      h.span.children([tr(ctx).t(ViewModels.navLabelKey(section))]),
    ]),
  );
};

const switcher = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message, RunApi> => {
  const current = ctx.workspace ?? undefined;
  const workspaces = model.session._tag === "SignedIn" ? model.session.workspaces : [];
  return h.div.class("kb-switcher").children([
    h.button
      .class("kb-switcher__button")
      .attr("type", "button")
      .attr("aria-expanded", String(model.switcherOpen))
      .attr("aria-haspopup", "menu")
      .on("click", Message.ToggledSwitcher())
      .attr("data-testid", "workspace-switcher")
      .children([
        h.span
          .class("kb-stack")
          .style({ "--kb-gap": "0" })
          .children([
            h.span
              .class("kb-small kb-muted")
              .children([tr(ctx).t("shell.workspaceSwitcher.current")]),
            h.strong.children([current?.name ?? "…"]),
          ]),
        icon(h, "chevron"),
      ]),
    model.switcherOpen
      ? h.div
          .class("kb-switcher__menu")
          .attr("role", "menu")
          .on("keydown", ({ key }) => (key === "Escape" ? Message.ClosedSwitcher() : undefined))
          .children([
            ...workspaces.map((w) =>
              withAttributes(h.a.class(), [
                (element) => element.class("kb-menu-item"),
                (element) => element.attr("role", "menuitem"),
                (element) =>
                  element.attr("href", href(ViewModels.switchWorkspace(ctx.route, w.slug))),
                (node) => (w.slug === current?.slug ? node.attr("aria-current", "true") : node),
              ]).children([
                h.span.style({ flex: "1" }).children([w.name]),
                ...(w.slug === current?.slug ? [icon(h, "check")] : []),
              ]),
            ),
            h.hr.class("kb-divider"),
            h.a
              .class("kb-menu-item")
              .attr("role", "menuitem")
              .attr("href", href({ _tag: "Onboarding" }))
              .children([icon(h, "plus"), tr(ctx).t("shell.workspaceSwitcher.create")]),
          ])
      : h.text(""),
  ]);
};

const toastRegion = (
  model: Model,
  h: Html.H<Message>,
  locale: PageContext["locale"],
): Markup<Message, RunApi> =>
  h.div
    .class("kb-toasts")
    .attr("aria-live", "polite")
    .children(
      model.toasts.map((t) =>
        h.div
          .key(String(t.id))
          .class(`kb-toast${t.tone === "error" ? " kb-toast--error" : ""}`)
          .attr("role", t.tone === "error" ? "alert" : "status")
          .children([
            h.span.children([t.text]),
            h.button
              .class("kb-btn kb-btn--ghost kb-btn--small")
              .attr("type", "button")
              .attr("aria-label", text(locale, "dismiss"))
              .on("click", Message.DismissedToast({ id: t.id }))
              .children([icon(h, "close", 16)]),
          ]),
      ),
    );

const pageOrSplash = (
  model: Model,
  ctx: PageContext,
  h: Html.H<Message>,
): Markup<Message, RunApi> =>
  !model.waitingForSession
    ? viewPage(h, ctx, model.path, (intent) => Message.PageIntent({ path: model.path, intent }))
    : h.div
        .class("kb-page")
        .attr("aria-busy", String(true))
        .attr("aria-label", tr(ctx).t("shell.splash"))
        .children([skeleton(h, "40%", "1.5rem"), skeleton(h, "100%", "12rem")]);

const publicChrome = (
  model: Model,
  ctx: PageContext,
  h: Html.H<Message>,
  main: Markup<Message, RunApi>,
): Markup<Message, RunApi> => {
  const signedIn = model.session._tag === "SignedIn";
  const firstWs = model.session._tag === "SignedIn" ? model.session.workspaces[0] : undefined;
  return h.div.class("kb-public").children([
    h.header.class("kb-public__header").children([
      h.a
        .attr("href", firstWs === undefined ? "/" : href({ _tag: "Dashboard", ws: firstWs.slug }))
        .attr("aria-label", "Kvitbit")
        .children([lockup(h, "horizontal", 22)]),
      h.div.class("kb-row").children([
        compactPrefs(h, tr(ctx), ctx.prefs, (prefs) => Message.ChangedPrefs({ prefs })),
        ...(signedIn
          ? [
              linkButton(h, {
                label: text(ctx.locale, "account"),
                href: href({ _tag: "Account", tab: "profile" }),
                variant: "ghost",
                small: true,
              }),
              h.button
                .class("kb-btn kb-btn--small")
                .attr("type", "button")
                .on("click", Message.ClickedSignOut())
                .children([text(ctx.locale, "signOut")]),
            ]
          : [
              linkButton(h, {
                label: text(ctx.locale, "signIn"),
                href: href({ _tag: "SignIn" }),
                variant: "ghost",
                small: true,
              }),
              linkButton(h, {
                label: text(ctx.locale, "signUp"),
                href: href({ _tag: "SignUp" }),
                variant: "primary",
                small: true,
              }),
            ]),
      ]),
    ]),
    h.main.class("kb-public__main").id("main").children([main]),
    h.footer.class("kb-public__footer").children([
      h.span
        .class("kb-row")
        .children([mark(h, 16), text(ctx.locale, "rights", { year: new Date().getFullYear() })]),
      h.nav
        .class("kb-row")
        .attr("aria-label", "Legal")
        .children([
          h.a
            .attr("href", href({ _tag: "Legal", page: "terms" }))
            .children([text(ctx.locale, "terms")]),
          h.a
            .attr("href", href({ _tag: "Legal", page: "privacy" }))
            .children([text(ctx.locale, "privacy")]),
          h.a
            .attr("href", href({ _tag: "AndroidDownload" }))
            .children([text(ctx.locale, "android")]),
        ]),
    ]),
  ]);
};

const workspaceChrome = (
  model: Model,
  ctx: PageContext,
  h: Html.H<Message>,
  ws: string,
  main: Markup<Message, RunApi>,
): Markup<Message, RunApi> =>
  h.div.class("kb-app").children([
    h.aside.class("kb-sidebar").children([
      h.div.class("kb-sidebar__brand").children([
        h.a
          .attr("href", href({ _tag: "Dashboard", ws: ws as WorkspaceSummary["slug"] }))
          .attr("aria-label", "Kvitbit")
          .children([lockup(h, "horizontal", 20)]),
      ]),
      switcher(model, ctx, h),
      h.nav
        .class("kb-nav")
        .attr("aria-label", text(ctx.locale, "mainNav"))
        .children(navItems(h, ctx, ws, ViewModels.WEB_NAV, "web")),
      h.div.class("kb-sidebar__footer").children([
        h.a
          .class("kb-nav__item")
          .attr("href", href({ _tag: "Account", tab: "profile" }))
          .children([
            icon(h, "user"),
            model.session._tag === "SignedIn"
              ? model.session.user.name
              : text(ctx.locale, "account"),
          ]),
        h.button
          .class("kb-nav__item kb-btn--ghost")
          .attr("type", "button")
          .style({ border: "0", background: "transparent", cursor: "pointer" })
          .on("click", Message.ClickedSignOut())
          .children([icon(h, "logout"), text(ctx.locale, "signOut")]),
      ]),
    ]),
    h.div
      .class("kb-main")
      .children([
        h.header
          .class("kb-topbar")
          .children([
            h.span
              .class("kb-row")
              .children([mark(h, 22), h.strong.children([ctx.workspace?.name ?? ""])]),
            compactPrefs(h, tr(ctx), ctx.prefs, (prefs) => Message.ChangedPrefs({ prefs })),
          ]),
        h.main.id("main").children([main]),
      ]),
    h.nav
      .class("kb-bottom-nav")
      .attr("aria-label", text(ctx.locale, "mainNav"))
      .children(navItems(h, ctx, ws, ViewModels.MOBILE_NAV, "mobile")),
  ]);

export const shellView = (
  model: Model,
  ctx: PageContext,
  h: Html.H<Message>,
): Markup<Message, RunApi> => {
  const main = pageOrSplash(model, ctx, h);
  const chrome =
    "ws" in ctx.route
      ? workspaceChrome(model, ctx, h, ctx.route.ws, main)
      : publicChrome(model, ctx, h, main);
  return rootNode(ctx.prefs, h).children([
    themeStyle(ctx.prefs, h),
    h.a
      .class("kb-visually-hidden")
      .attr("href", "#main")
      .children([tr(ctx).t("shell.skipToContent")]),
    chrome,
    toastRegion(model, h, ctx.locale),
  ]);
};
