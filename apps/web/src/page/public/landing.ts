/**
 * Screen 01 — Public Marketing Landing (Persuade).
 * K4 lockup, T4 subtle pattern hero, 6 bilingual feature cards, miniature invoice preview,
 * and CTAs to sign-up, sign-in, Android download, and `/app/` PWA.
 */
import { ConfigView } from "@kvitbit/api-contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Command, Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Failure } from "../../app/api";
import { copy, translator } from "../../app/i18n";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { lockup } from "../../ui/brand";
import { type IconName, icon } from "../../ui/icons";
import { badge, banner, card, linkButton } from "../../ui/kit";
import { callApi } from "./_shared";

export type Route = RouteOf<"Landing">;

const ConfigRemote = Remote.remoteSchema(ConfigView);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  config: ConfigRemote,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotConfig: { seq: Remote.Seq, config: ConfigView },
  FailedConfig: { seq: Remote.Seq, failure: Failure },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    eyebrow: "Fakturace pro české OSVČ a firmy",
    androidCta: "Aplikace pro Android",
    pwaCta: "Otevřít mobilní web (/app/)",
    openDashboard: "Přejít do přehledu",
    featuresHeading: "Vše, co potřebujete pro bezchybnou fakturaci",
    previewLabel: "Ukázka dokladu",
    previewNumber: "Faktura 2026-0042",
    previewIssuer: "Novák Design s.r.o. · IČO 01234567",
    previewBuyer: "Ateliér Stromovka a.s.",
    previewDue: "Splatnost 14 dní · QR Platba",
    previewStatus: "Zaplaceno",
    selfHostAction: "Stáhnout Android aplikaci",
  },
  en: {
    eyebrow: "Invoicing for Czech freelancers and companies",
    androidCta: "Android app",
    pwaCta: "Open mobile web (/app/)",
    openDashboard: "Open dashboard",
    featuresHeading: "Everything you need for compliant invoicing",
    previewLabel: "Document preview",
    previewNumber: "Invoice 2026-0042",
    previewIssuer: "Novák Design s.r.o. · IČO 01234567",
    previewBuyer: "Ateliér Stromovka a.s.",
    previewDue: "Due in 14 days · QR Platba",
    previewStatus: "Paid",
    selfHostAction: "Get the Android app",
  },
});

const FEATURES: ReadonlyArray<{
  readonly icon: IconName;
  readonly titleKey:
    | "public.landing.feature.compliance.title"
    | "public.landing.feature.ares.title"
    | "public.landing.feature.qr.title"
    | "public.landing.feature.fx.title"
    | "public.landing.feature.mobile.title"
    | "public.landing.feature.mcp.title";
  readonly bodyKey:
    | "public.landing.feature.compliance.body"
    | "public.landing.feature.ares.body"
    | "public.landing.feature.qr.body"
    | "public.landing.feature.fx.body"
    | "public.landing.feature.mobile.body"
    | "public.landing.feature.mcp.body";
}> = [
  {
    icon: "documents",
    titleKey: "public.landing.feature.compliance.title",
    bodyKey: "public.landing.feature.compliance.body",
  },
  {
    icon: "search",
    titleKey: "public.landing.feature.ares.title",
    bodyKey: "public.landing.feature.ares.body",
  },
  {
    icon: "check",
    titleKey: "public.landing.feature.qr.title",
    bodyKey: "public.landing.feature.qr.body",
  },
  {
    icon: "reports",
    titleKey: "public.landing.feature.fx.title",
    bodyKey: "public.landing.feature.fx.body",
  },
  {
    icon: "expenses",
    titleKey: "public.landing.feature.mobile.title",
    bodyKey: "public.landing.feature.mobile.body",
  },
  {
    icon: "key",
    titleKey: "public.landing.feature.mcp.title",
    bodyKey: "public.landing.feature.mcp.body",
  },
];

const FetchConfig = Command.define("PublicLandingFetchConfig", {
  args: { seq: Remote.Seq },
  messages: [Message.GotConfig, Message.FailedConfig],
  execute: ({ seq }) =>
    callApi(
      (client) => client.config.getConfig(),
      (cfg) => Message.GotConfig({ seq, config: cfg }),
      (failure) => Message.FailedConfig({ seq, failure }),
    ),
});

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const config = Remote.load(Remote.idle);
  const seq = Remote.seqOf(config);
  return {
    model: { route, config },
    commands: [FetchConfig({ seq })],
  };
};

export const update = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
    GotConfig: ({ seq, config }) => ({
      model: { ...model, config: Remote.succeed(model.config, seq, config) },
    }),
    FailedConfig: ({ seq, failure }) => ({
      model: { ...model, config: Remote.fail(model.config, seq, failure) },
    }),
  });

export const title = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("public.landing.title");

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const t = translator(ctx.locale);
  const cfg = Remote.dataOf(model.config);
  const signUpEnabled = cfg?.features.signUp ?? true;
  const firstWs = ctx.session._tag === "SignedIn" ? ctx.session.workspaces[0] : undefined;
  const sampleAmount = Format.moneyDisplay(ctx.locale, { amount: "48400.00", currency: "CZK" });

  return h.div(
    [h.Class("kb-landing")],
    [
      h.section(
        [h.Class("kb-landing-hero kb-pattern")],
        [
          h.div(
            [h.Class("kb-landing-hero__inner")],
            [
              h.div(
                [h.Class("kb-landing-hero__copy")],
                [
                  h.div([h.Class("kb-row")], [lockup(h, "horizontal", 32)]),
                  h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "eyebrow")]),
                  h.h1([h.Class("kb-landing-hero__title")], [t.t("public.landing.title")]),
                  h.p([h.Class("kb-landing-hero__subtitle")], [t.t("public.landing.subtitle")]),
                  ...(!signUpEnabled
                    ? [banner(h, { text: t.t("public.landing.signUpDisabled"), tone: "info" })]
                    : []),
                  h.div(
                    [h.Class("kb-landing-hero__actions")],
                    firstWs !== undefined
                      ? [
                          linkButton(h, {
                            label: local(ctx.locale, "openDashboard"),
                            href: href({ _tag: "Dashboard", ws: firstWs.slug }),
                            variant: "primary",
                          }),
                          linkButton(h, {
                            label: local(ctx.locale, "androidCta"),
                            href: href({ _tag: "AndroidDownload" }),
                            variant: "secondary",
                          }),
                        ]
                      : [
                          ...(signUpEnabled
                            ? [
                                linkButton(h, {
                                  label: t.t("public.landing.cta.signUp"),
                                  href: href({ _tag: "SignUp" }),
                                  variant: "primary",
                                }),
                              ]
                            : []),
                          linkButton(h, {
                            label: t.t("public.landing.cta.signIn"),
                            href: href({ _tag: "SignIn" }),
                            variant: signUpEnabled ? "secondary" : "primary",
                          }),
                          linkButton(h, {
                            label: local(ctx.locale, "androidCta"),
                            href: href({ _tag: "AndroidDownload" }),
                            variant: "ghost",
                          }),
                        ],
                  ),
                ],
              ),
              h.aside(
                [h.Class("kb-landing-preview"), h.AriaLabel(local(ctx.locale, "previewLabel"))],
                [
                  h.div(
                    [h.Class("kb-spread")],
                    [
                      h.strong([], [local(ctx.locale, "previewNumber")]),
                      badge(h, local(ctx.locale, "previewStatus"), "paid"),
                    ],
                  ),
                  h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "previewIssuer")]),
                  h.hr([h.Class("kb-divider")]),
                  h.div(
                    [h.Class("kb-spread")],
                    [
                      h.span([h.Class("kb-small")], [local(ctx.locale, "previewBuyer")]),
                      h.span([h.Class("kb-landing-preview__total kb-num")], [sampleAmount.text]),
                    ],
                  ),
                  h.span([h.Class("kb-footnote")], [local(ctx.locale, "previewDue")]),
                ],
              ),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("kb-landing-section")],
        [
          h.h2([], [local(ctx.locale, "featuresHeading")]),
          h.div(
            [h.Class("kb-feature-grid")],
            FEATURES.map((f) =>
              card(h, [
                h.div(
                  [h.Class("kb-feature-card")],
                  [
                    h.span([h.Class("kb-feature-card__icon")], [icon(h, f.icon, 20)]),
                    h.h3([], [t.t(f.titleKey)]),
                    h.p([h.Class("kb-muted")], [t.t(f.bodyKey)]),
                  ],
                ),
              ]),
            ),
          ),
        ],
      ),
      h.section(
        [h.Class("kb-landing-section")],
        [
          h.div(
            [h.Class("kb-selfhost-strip")],
            [
              h.div(
                [h.Class("kb-stack"), h.Style({ "--kb-gap": "4px" })],
                [
                  h.strong([], [t.t("app.name")]),
                  h.p([h.Class("kb-muted")], [t.t("public.landing.selfHosted")]),
                ],
              ),
              h.div(
                [h.Class("kb-row")],
                [
                  linkButton(h, {
                    label: local(ctx.locale, "selfHostAction"),
                    href: href({ _tag: "AndroidDownload" }),
                    variant: "secondary",
                  }),
                  h.a(
                    [h.Class("kb-btn kb-btn--ghost"), h.Href("/app/")],
                    [local(ctx.locale, "pwaCta")],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
