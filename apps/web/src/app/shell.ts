/**
 * Shell chrome (screen 06). Public and account routes get the public header and footer; workspace
 * routes get the desktop sidebar with the workspace switcher, a top bar, and the mobile M3
 * navigation bar. The theme stylesheet is rendered here (app/theme.ts).
 */
import type { WorkspaceSummary } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { lockup, mark } from "../ui/brand";
import { type IconName, icon } from "../ui/icons";
import { linkButton, skeleton } from "../ui/kit";
import { compactPrefs } from "../ui/prefs-controls";
import { copy, type Translator, translator } from "./i18n";
import type { PageContext } from "./page";
import { viewPage } from "./pages";
import { Message, type Model } from "./root";
import { defaultReportRoute, href } from "./routing";
import { rootAttributes, themeStyle } from "./theme";

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
  h: HtmlBuilder<Message>,
  ctx: PageContext,
  ws: string,
  sections: ReadonlyArray<ViewModels.NavSection>,
  platform: "web" | "mobile",
): ReadonlyArray<Html> => {
  const active = Option.getOrUndefined(ViewModels.activeSection(ctx.route, platform));
  return sections.map((section) =>
    h.a(
      [
        h.Class("kb-nav__item"),
        h.Href(sectionHref(section, ws, ctx.route)),
        ...(active === section ? [h.AriaCurrent("page")] : []),
      ],
      [icon(h, NAV_ICON[section]), h.span([], [tr(ctx).t(ViewModels.navLabelKey(section))])],
    ),
  );
};

const switcher = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const current = ctx.workspace ?? undefined;
  const workspaces = model.session._tag === "SignedIn" ? model.session.workspaces : [];
  return h.div(
    [h.Class("kb-switcher")],
    [
      h.button(
        [
          h.Class("kb-switcher__button"),
          h.Type("button"),
          h.AriaExpanded(model.switcherOpen),
          h.AriaHasPopup("menu"),
          h.OnClick(Message.ToggledSwitcher()),
          h.DataAttribute("testid", "workspace-switcher"),
        ],
        [
          h.span(
            [h.Class("kb-stack"), h.Style({ "--kb-gap": "0" })],
            [
              h.span(
                [h.Class("kb-small kb-muted")],
                [tr(ctx).t("shell.workspaceSwitcher.current")],
              ),
              h.strong([], [current?.name ?? "…"]),
            ],
          ),
          icon(h, "chevron"),
        ],
      ),
      model.switcherOpen
        ? h.div(
            [
              h.Class("kb-switcher__menu"),
              h.Role("menu"),
              h.OnKeyDown((key) =>
                key === "Escape" ? Message.ClosedSwitcher() : Message.CompletedNavigate(),
              ),
            ],
            [
              ...workspaces.map((w) =>
                h.a(
                  [
                    h.Class("kb-menu-item"),
                    h.Role("menuitem"),
                    h.Href(href(ViewModels.switchWorkspace(ctx.route, w.slug))),
                    ...(w.slug === current?.slug ? [h.AriaCurrent("true")] : []),
                  ],
                  [
                    h.span([h.Style({ flex: "1" })], [w.name]),
                    ...(w.slug === current?.slug ? [icon(h, "check")] : []),
                  ],
                ),
              ),
              h.hr([h.Class("kb-divider")]),
              h.a(
                [h.Class("kb-menu-item"), h.Role("menuitem"), h.Href(href({ _tag: "Onboarding" }))],
                [icon(h, "plus"), tr(ctx).t("shell.workspaceSwitcher.create")],
              ),
            ],
          )
        : h.empty,
    ],
  );
};

const toastRegion = (model: Model, h: HtmlBuilder<Message>, locale: PageContext["locale"]): Html =>
  h.div(
    [h.Class("kb-toasts"), h.AriaLive("polite")],
    model.toasts.map((t) =>
      h.keyed("div")(
        String(t.id),
        [
          h.Class(`kb-toast${t.tone === "error" ? " kb-toast--error" : ""}`),
          h.Role(t.tone === "error" ? "alert" : "status"),
        ],
        [
          h.span([], [t.text]),
          h.button(
            [
              h.Class("kb-btn kb-btn--ghost kb-btn--small"),
              h.Type("button"),
              h.AriaLabel(text(locale, "dismiss")),
              h.OnClick(Message.DismissedToast({ id: t.id })),
            ],
            [icon(h, "close", 16)],
          ),
        ],
      ),
    ),
  );

const pageOrSplash = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html =>
  model.mount._tag === "Mounted"
    ? viewPage(model.mount.page, ctx, h, (message) => Message.GotPage({ message }))
    : h.div(
        [h.Class("kb-page"), h.AriaBusy(true), h.AriaLabel(tr(ctx).t("shell.splash"))],
        [skeleton(h, "40%", "1.5rem"), skeleton(h, "100%", "12rem")],
      );

const publicChrome = (
  model: Model,
  ctx: PageContext,
  h: HtmlBuilder<Message>,
  main: Html,
): Html => {
  const signedIn = model.session._tag === "SignedIn";
  const firstWs = model.session._tag === "SignedIn" ? model.session.workspaces[0] : undefined;
  return h.div(
    [h.Class("kb-public")],
    [
      h.header(
        [h.Class("kb-public__header")],
        [
          h.a(
            [
              h.Href(firstWs === undefined ? "/" : href({ _tag: "Dashboard", ws: firstWs.slug })),
              h.AriaLabel("Kvitbit"),
            ],
            [lockup(h, "horizontal", 22)],
          ),
          h.div(
            [h.Class("kb-row")],
            [
              compactPrefs(h, tr(ctx), ctx.prefs, (prefs) => Message.ChangedPrefs({ prefs })),
              ...(signedIn
                ? [
                    linkButton(h, {
                      label: text(ctx.locale, "account"),
                      href: href({ _tag: "Account", tab: "profile" }),
                      variant: "ghost",
                      small: true,
                    }),
                    h.button(
                      [
                        h.Class("kb-btn kb-btn--small"),
                        h.Type("button"),
                        h.OnClick(Message.ClickedSignOut()),
                      ],
                      [text(ctx.locale, "signOut")],
                    ),
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
            ],
          ),
        ],
      ),
      h.main([h.Class("kb-public__main"), h.Id("main")], [main]),
      h.footer(
        [h.Class("kb-public__footer")],
        [
          h.span(
            [h.Class("kb-row")],
            [mark(h, 16), text(ctx.locale, "rights", { year: new Date().getFullYear() })],
          ),
          h.nav(
            [h.Class("kb-row"), h.AriaLabel("Legal")],
            [
              h.a([h.Href(href({ _tag: "Legal", page: "terms" }))], [text(ctx.locale, "terms")]),
              h.a(
                [h.Href(href({ _tag: "Legal", page: "privacy" }))],
                [text(ctx.locale, "privacy")],
              ),
              h.a([h.Href(href({ _tag: "AndroidDownload" }))], [text(ctx.locale, "android")]),
            ],
          ),
        ],
      ),
    ],
  );
};

const workspaceChrome = (
  model: Model,
  ctx: PageContext,
  h: HtmlBuilder<Message>,
  ws: string,
  main: Html,
): Html =>
  h.div(
    [h.Class("kb-app")],
    [
      h.aside(
        [h.Class("kb-sidebar")],
        [
          h.div(
            [h.Class("kb-sidebar__brand")],
            [
              h.a(
                [
                  h.Href(href({ _tag: "Dashboard", ws: ws as WorkspaceSummary["slug"] })),
                  h.AriaLabel("Kvitbit"),
                ],
                [lockup(h, "horizontal", 20)],
              ),
            ],
          ),
          switcher(model, ctx, h),
          h.nav(
            [h.Class("kb-nav"), h.AriaLabel(text(ctx.locale, "mainNav"))],
            navItems(h, ctx, ws, ViewModels.WEB_NAV, "web"),
          ),
          h.div(
            [h.Class("kb-sidebar__footer")],
            [
              h.a(
                [h.Class("kb-nav__item"), h.Href(href({ _tag: "Account", tab: "profile" }))],
                [
                  icon(h, "user"),
                  model.session._tag === "SignedIn"
                    ? model.session.user.name
                    : text(ctx.locale, "account"),
                ],
              ),
              h.button(
                [
                  h.Class("kb-nav__item kb-btn--ghost"),
                  h.Type("button"),
                  h.Style({ border: "0", background: "transparent", cursor: "pointer" }),
                  h.OnClick(Message.ClickedSignOut()),
                ],
                [icon(h, "logout"), text(ctx.locale, "signOut")],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("kb-main")],
        [
          h.header(
            [h.Class("kb-topbar")],
            [
              h.span([h.Class("kb-row")], [mark(h, 22), h.strong([], [ctx.workspace?.name ?? ""])]),
              compactPrefs(h, tr(ctx), ctx.prefs, (prefs) => Message.ChangedPrefs({ prefs })),
            ],
          ),
          h.main([h.Id("main")], [main]),
        ],
      ),
      h.nav(
        [h.Class("kb-bottom-nav"), h.AriaLabel(text(ctx.locale, "mainNav"))],
        navItems(h, ctx, ws, ViewModels.MOBILE_NAV, "mobile"),
      ),
    ],
  );

export const shellView = (model: Model, ctx: PageContext, h: HtmlBuilder<Message>): Html => {
  const main = pageOrSplash(model, ctx, h);
  const chrome =
    "ws" in ctx.route
      ? workspaceChrome(model, ctx, h, ctx.route.ws, main)
      : publicChrome(model, ctx, h, main);
  return h.div(
    [...rootAttributes(ctx.prefs, h)],
    [
      themeStyle(ctx.prefs, h),
      h.a([h.Class("kb-visually-hidden"), h.Href("#main")], [tr(ctx).t("shell.skipToContent")]),
      chrome,
      toastRegion(model, h, ctx.locale),
    ],
  );
};
