import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 01 — Public Marketing Landing (Persuade).
 * K4 lockup, T4 subtle pattern hero, 6 bilingual feature cards, miniature invoice preview,
 * and CTAs to sign-up, sign-in, Android download, and `/app/` PWA.
 */
import { ConfigView } from "@kvitbit/api-contract";
import { Format } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { lockup } from "../../ui/brand";
import { type IconName, icon } from "../../ui/icons";
import { badge, banner, card, linkButton } from "../../ui/kit";
import { callApi } from "./_shared";

export const Route = RouteCases.Landing;
export type Route = typeof Route.Type;

const ConfigRemote = Remote.remoteSchema(ConfigView);

export const Model = Schema.Struct({
  route: Route,
  config: ConfigRemote,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  GotConfig: { seq: Remote.Seq, config: ConfigView },
  FailedConfig: { seq: Remote.Seq, failure: Failure },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
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

const FetchConfig = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "PublicLandingFetchConfig",
  args: { seq: Remote.Seq },
  execute: ({ seq }) =>
    callApi(
      (client) => client.config.getConfig(),
      (cfg) => Message.GotConfig({ seq, config: cfg }),
      (failure) => Message.FailedConfig({ seq, failure }),
    ),
});

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const config = Remote.load(Remote.idle);
  const seq = Remote.seqOf(config);
  return {
    model: { route, config },
    commands: [FetchConfig({ seq })],
  };
};

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
    GotConfig: ({ seq, config }) => ({
      model: { ...model, config: Remote.succeed(model.config, seq, config) },
    }),
    FailedConfig: ({ seq, failure }) => ({
      model: { ...model, config: Remote.fail(model.config, seq, failure) },
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, _ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("public.landing.title");

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const cfg = Remote.dataOf(model.config);
  const signUpEnabled = cfg?.features.signUp ?? true;
  const firstWs = ctx.session._tag === "SignedIn" ? ctx.session.workspaces[0] : undefined;
  const sampleAmount = Format.moneyDisplay(ctx.locale, { amount: "48400.00", currency: "CZK" });

  return h.div.class("kb-landing").children([
    h.section.class("kb-landing-hero kb-pattern").children([
      h.div.class("kb-landing-hero__inner").children([
        h.div.class("kb-landing-hero__copy").children([
          h.div.class("kb-row").children([lockup(h, "horizontal", 32)]),
          h.span.class("kb-small kb-muted").children([t.t("app.tagline")]),
          h.h1.class("kb-landing-hero__title").children([t.t("public.landing.title")]),
          h.p.class("kb-landing-hero__subtitle").children([t.t("public.landing.subtitle")]),
          ...(!signUpEnabled
            ? [banner(h, { text: t.t("public.landing.signUpDisabled"), tone: "info" })]
            : []),
          h.div.class("kb-landing-hero__actions").children(
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
        ]),
        h.aside
          .class("kb-landing-preview")
          .attr("aria-label", local(ctx.locale, "previewLabel"))
          .children([
            h.div
              .class("kb-spread")
              .children([
                h.strong.children([local(ctx.locale, "previewNumber")]),
                badge(h, local(ctx.locale, "previewStatus"), "paid"),
              ]),
            h.span.class("kb-small kb-muted").children([local(ctx.locale, "previewIssuer")]),
            h.hr.class("kb-divider"),
            h.div
              .class("kb-spread")
              .children([
                h.span.class("kb-small").children([local(ctx.locale, "previewBuyer")]),
                h.span.class("kb-landing-preview__total kb-num").children([sampleAmount.text]),
              ]),
            h.span.class("kb-footnote").children([local(ctx.locale, "previewDue")]),
          ]),
      ]),
    ]),
    h.section
      .class("kb-landing-section")
      .children([
        h.h2.children([local(ctx.locale, "featuresHeading")]),
        h.div
          .class("kb-feature-grid")
          .children(
            Arr.map(FEATURES, (f) =>
              card(h, [
                h.div
                  .class("kb-feature-card")
                  .children([
                    h.span.class("kb-feature-card__icon").children([icon(h, f.icon, 20)]),
                    h.h3.children([t.t(f.titleKey)]),
                    h.p.class("kb-muted").children([t.t(f.bodyKey)]),
                  ]),
              ]),
            ),
          ),
      ]),
    h.section.class("kb-landing-section").children([
      h.div.class("kb-selfhost-strip").children([
        h.div
          .class("kb-stack")
          .style({ "--kb-gap": "4px" })
          .children([
            h.strong.children([t.t("app.name")]),
            h.p.class("kb-muted").children([t.t("public.landing.selfHosted")]),
          ]),
        h.div.class("kb-row").children([
          linkButton(h, {
            label: local(ctx.locale, "selfHostAction"),
            href: href({ _tag: "AndroidDownload" }),
            variant: "secondary",
          }),
          h.a
            .class("kb-btn kb-btn--ghost")
            .attr("href", "/app/")
            .children([local(ctx.locale, "pwaCta")]),
        ]),
      ]),
    ]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
