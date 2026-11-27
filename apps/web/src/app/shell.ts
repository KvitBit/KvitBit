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
import { button, linkButton, skeleton } from "../ui/kit";
import { compactPrefs } from "../ui/prefs-controls";
import { buttonVariants, cn, toastVariants, ui } from "../ui/styles";
import type { RunApi } from "./commands";
import { copy, type Translator, textOf, translator } from "./i18n";
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

const sectionHref = (section: ViewModels.NavSection, ws: string, ctx: PageContext): string =>
  Option.match(ViewModels.sectionRoute(section, ws as WorkspaceSummary["slug"], ctx.route), {
    onNone: () => href(defaultReportRoute(ws, Number(ctx.today.slice(0, 4)))),
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
      (element) => element.class(platform === "mobile" ? ui.navItemMobile : ui.navItem),
      (element) => element.attr("href", sectionHref(section, ws, ctx)),
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
  return h.div.class("relative").children([
    h.button
      .class(
        "flex w-full cursor-pointer items-center justify-between gap-2 rounded-control border border-outline-variant bg-surface-container-lowest px-2.5 py-2 text-left",
      )
      .attr("type", "button")
      .attr("aria-expanded", String(model.switcherOpen))
      .attr("aria-haspopup", "menu")
      .on("click", Message.ToggledSwitcher())
      .attr("data-testid", "workspace-switcher")
      .children([
        h.span
          .class("flex flex-col gap-0")
          .children([
            h.span
              .class(cn(ui.small, ui.muted))
              .children([tr(ctx).t("shell.workspaceSwitcher.current")]),
            h.strong.children([current?.name ?? "…"]),
          ]),
        icon(h, "chevron"),
      ]),
    model.switcherOpen
      ? h.div
          .class(
            "absolute top-[calc(100%+4px)] right-0 left-0 z-30 rounded-control border border-outline-variant bg-surface-container-lowest p-1 shadow-[0_8px_24px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_40%,transparent)]",
          )
          .attr("role", "menu")
          .on("keydown", ({ key }) => (key === "Escape" ? Message.ClosedSwitcher() : undefined))
          .children([
            ...workspaces.map((w) =>
              withAttributes(h.a.class(), [
                (element) => element.class(ui.menuItem),
                (element) => element.attr("role", "menuitem"),
                (element) =>
                  element.attr("href", href(ViewModels.switchWorkspace(ctx.route, w.slug))),
                (node) => (w.slug === current?.slug ? node.attr("aria-current", "true") : node),
              ]).children([
                h.span.class("flex-1").children([w.name]),
                ...(w.slug === current?.slug ? [icon(h, "check")] : []),
              ]),
            ),
            h.hr.class(ui.divider),
            h.a
              .class(ui.menuItem)
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
    .class("fixed right-4 bottom-4 z-[60] flex max-w-[min(420px,calc(100vw-32px))] flex-col gap-2")
    .attr("aria-live", "polite")
    .children(
      model.toasts.map((t) =>
        h.div
          .key(String(t.id))
          .class(toastVariants({ tone: t.tone === "error" ? "error" : "info" }))
          .attr("role", t.tone === "error" ? "alert" : "status")
          .children([
            h.span.children([t.text]),
            h.button
              .class(buttonVariants({ variant: "ghost", size: "small" }))
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
  !model.waitingForSession && model.pendingNav !== null && model.session._tag === "Unavailable"
    ? h.div
        .class(
          "mx-auto flex w-full max-w-[1280px] flex-col gap-3 px-4 pt-4 pb-24 md:px-7 md:pt-6 md:pb-12",
        )
        .children([
          h.p.attr("role", "alert").children(textOf(tr(ctx), model.session.failure.text)),
          button(h, {
            label: tr(ctx).t("common.action.retry"),
            onClick: Message.ClickedRetrySession(),
          }),
        ])
    : !model.waitingForSession
      ? viewPage(h, ctx, model.path, (intent) => Message.PageIntent({ path: model.path, intent }))
      : h.div
          .class(
            "mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-4 pb-24 md:px-7 md:pt-6 md:pb-12",
          )
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
  return h.div
    .class("flex min-h-dvh flex-col")
    .attr("data-slot", "public")
    .children([
      h.header
        .class(
          "flex items-center justify-between gap-3 border-b border-outline-variant px-4 py-3 md:px-7 md:py-3.5",
        )
        .children([
          h.a
            .attr(
              "href",
              firstWs === undefined ? "/" : href({ _tag: "Dashboard", ws: firstWs.slug }),
            )
            .attr("aria-label", "Kvitbit")
            .children([lockup(h, "horizontal", 22)]),
          h.div.class(ui.row).children([
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
                    .class(buttonVariants({ variant: "secondary", size: "small" }))
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
      h.main.class("flex flex-1 flex-col").id("main").children([main]),
      h.footer
        .class(
          "flex flex-wrap justify-between gap-4 border-t border-outline-variant px-4 py-3 text-[0.75rem] text-on-surface-variant md:px-7 md:py-5 [&_a]:text-inherit",
        )
        .children([
          h.span
            .class(ui.row)
            .children([
              mark(h, 16),
              text(ctx.locale, "rights", { year: Number(ctx.today.slice(0, 4)) }),
            ]),
          h.nav
            .class(ui.row)
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
  h.div
    .class("grid min-h-dvh grid-cols-[minmax(0,1fr)] min-[901px]:grid-cols-[248px_minmax(0,1fr)]")
    .attr("data-slot", "app")
    .children([
      h.aside
        .class(
          "sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-outline-variant bg-surface-container-low px-3 py-3.5 min-[901px]:flex",
        )
        .attr("data-slot", "sidebar")
        .children([
          h.div.class("px-2 pt-1 pb-3").children([
            h.a
              .attr("href", href({ _tag: "Dashboard", ws: ws as WorkspaceSummary["slug"] }))
              .attr("aria-label", "Kvitbit")
              .children([lockup(h, "horizontal", 20)]),
          ]),
          switcher(model, ctx, h),
          h.nav
            .class("flex flex-col gap-0.5")
            .attr("aria-label", text(ctx.locale, "mainNav"))
            .children(navItems(h, ctx, ws, ViewModels.WEB_NAV, "web")),
          h.div.class("mt-auto flex flex-col gap-2 border-t border-outline-variant pt-3").children([
            h.a
              .class(ui.navItem)
              .attr("href", href({ _tag: "Account", tab: "profile" }))
              .children([
                icon(h, "user"),
                model.session._tag === "SignedIn"
                  ? model.session.user.name
                  : text(ctx.locale, "account"),
              ]),
            h.button
              .class(cn(ui.navItem, "cursor-pointer border-0 bg-transparent"))
              .attr("type", "button")
              .on("click", Message.ClickedSignOut())
              .children([icon(h, "logout"), text(ctx.locale, "signOut")]),
          ]),
        ]),
      h.div
        .class("flex min-w-0 flex-col")
        .children([
          h.header
            .class(
              "sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-outline-variant bg-[color-mix(in_srgb,var(--md-sys-color-surface)_92%,transparent)] px-4 py-2.5 backdrop-blur-sm min-[901px]:px-7",
            )
            .children([
              h.span
                .class(ui.row)
                .children([mark(h, 22), h.strong.children([ctx.workspace?.name ?? ""])]),
              compactPrefs(h, tr(ctx), ctx.prefs, (prefs) => Message.ChangedPrefs({ prefs })),
            ]),
          h.main.id("main").children([main]),
        ]),
      h.nav
        .class(
          "fixed right-0 bottom-0 left-0 z-25 grid grid-cols-5 border-t border-outline-variant bg-surface-container px-1 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] min-[901px]:hidden",
        )
        .attr("data-slot", "bottom-nav")
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
      .class("sr-only")
      .attr("href", "#main")
      .children([tr(ctx).t("shell.skipToContent")]),
    chrome,
    toastRegion(model, h, ctx.locale),
  ]);
};
