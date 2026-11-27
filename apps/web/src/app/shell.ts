import { Mount } from "@effect/ui";
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
import {
  ariaKeyshortcuts,
  formatShortcut,
  SyncToasts,
  UiButton,
  UiMenu,
  UiMenuContent,
  UiMenuItem,
  UiMenuSeparator,
  UiMenuTrigger,
  UiToastRegion,
} from "../ui/sdk";
import { cn, ui } from "../ui/styles";
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
    notifications: "Oznámení",
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
    notifications: "Notifications",
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
  return UiMenu(h)
    .class("relative block")
    .open(model.switcherOpen)
    .attr("open", model.switcherOpen ? "" : undefined)
    .on("openchange", ({ value }) => {
      if (value === model.switcherOpen) return undefined;
      return value ? Message.ToggledSwitcher() : Message.ClosedSwitcher();
    })
    .children([
      UiMenuTrigger(h).children([
        h.button
          .class(
            "flex w-full cursor-pointer items-center justify-between gap-2 rounded-control border border-outline-variant bg-surface-container-lowest px-2.5 py-2 text-left",
          )
          .attr("type", "button")
          .attr("aria-expanded", String(model.switcherOpen))
          .attr("aria-haspopup", "menu")
          .attr("aria-keyshortcuts", ariaKeyshortcuts("mod+k"))
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
            h.span
              .class("inline-flex flex-none items-center gap-1.5 text-on-surface-variant")
              .children([
                h.kbd.class(ui.kbd).children([formatShortcut("mod+k")]),
                icon(h, "chevron"),
              ]),
          ]),
      ]),
      UiMenuContent(h)
        .class(
          "max-h-[var(--available-height,360px)] min-w-[var(--anchor-width,224px)] overflow-auto rounded-control border border-outline-variant bg-surface-container-lowest p-1 text-on-surface shadow-[0_8px_24px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_40%,transparent)]",
        )
        .attr("side", "bottom")
        .attr("align", "start")
        .attr("side-offset", "4")
        .attr("hidden", "")
        .children([
          ...workspaces.map((w) =>
            UiMenuItem(h)
              .key(w.slug)
              .value(w.slug)
              .label(w.name)
              .attr("value", w.slug)
              .attr("label", w.name)
              .attr("as-child", "")
              .children([
                withAttributes(h.a.class(), [
                  (element) => element.class(ui.menuItem),
                  (element) =>
                    element.attr("href", href(ViewModels.switchWorkspace(ctx.route, w.slug))),
                  (node) => (w.slug === current?.slug ? node.attr("aria-current", "true") : node),
                ]).children([
                  h.span.class("flex-1").children([w.name]),
                  ...(w.slug === current?.slug ? [icon(h, "check")] : []),
                ]),
              ]),
          ),
          UiMenuSeparator(h).class(ui.divider),
          UiMenuItem(h)
            .value("create-workspace")
            .label(tr(ctx).t("shell.workspaceSwitcher.create"))
            .attr("value", "create-workspace")
            .attr("as-child", "")
            .children([
              h.a
                .class(ui.menuItem)
                .attr("href", href({ _tag: "Onboarding" }))
                .children([icon(h, "plus"), tr(ctx).t("shell.workspaceSwitcher.create")]),
            ]),
        ]),
    ]);
};

const toastRegion = (
  model: Model,
  h: Html.H<Message>,
  locale: PageContext["locale"],
): Markup<Message, RunApi> =>
  UiToastRegion(h)
    .class(
      "fixed right-4 bottom-4 z-[60] flex max-w-[min(420px,calc(100vw-32px))] flex-col gap-2 [&_[data-slot=toast]]:flex [&_[data-slot=toast]]:items-center [&_[data-slot=toast]]:justify-between [&_[data-slot=toast]]:gap-3 [&_[data-slot=toast]]:rounded-control [&_[data-slot=toast]]:bg-inverse-surface [&_[data-slot=toast]]:px-3.5 [&_[data-slot=toast]]:py-2.5 [&_[data-slot=toast]]:text-[0.875rem] [&_[data-slot=toast]]:text-inverse-on-surface [&_[data-slot=toast]]:shadow-[0_8px_24px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_40%,transparent)] [&_[data-slot=toast][data-type=error]]:bg-error [&_[data-slot=toast][data-type=error]]:text-on-error [&_[data-slot=toast-close]]:cursor-pointer [&_[data-slot=toast-close]]:rounded-control [&_[data-slot=toast-close]]:border-0 [&_[data-slot=toast-close]]:bg-transparent [&_[data-slot=toast-close]]:px-1.5 [&_[data-slot=toast-close]]:py-0.5 [&_[data-slot=toast-close]]:text-[0.8125rem] [&_[data-slot=toast-close]]:text-inherit [&_[data-slot=toast-close]]:opacity-85 hover:[&_[data-slot=toast-close]]:opacity-100",
    )
    .maxVisible(3)
    .attr("side", "bottom")
    .attr("align", "end")
    .attr("max-visible", "3")
    .attr("aria-label", text(locale, "notifications"))
    .onMount(
      SyncToasts({
        toasts: model.toasts,
        dismissLabel: text(locale, "dismiss"),
      }).pipe(Mount.map((id) => Message.DismissedToast({ id }))),
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
                  button(h, {
                    label: text(ctx.locale, "signOut"),
                    onClick: Message.ClickedSignOut(),
                    small: true,
                  }),
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
            UiButton(h)
              .on("action", Message.ClickedSignOut())
              .children([
                h.button
                  .class(cn(ui.navItem, "cursor-pointer border-0 bg-transparent"))
                  .attr("type", "button")
                  .children([icon(h, "logout"), text(ctx.locale, "signOut")]),
              ]),
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
