import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 01 — Public Marketing Landing (Persuade).
 * K4 lockup, T4 subtle pattern hero, 6 bilingual feature cards, miniature invoice preview,
 * and CTAs to sign-up, sign-in, Android download, and `/app/` PWA.
 */
import { ConfigView } from "@kvitbit/api-contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { lockup } from "../../ui/brand";
import { type IconName, icon } from "../../ui/icons";
import { badge, banner, card, linkButton } from "../../ui/kit";
import { buttonVariants, cn, ui } from "../../ui/styles";
import { callApi } from "./_shared";

export type Route = RouteOf<"Landing">;

const ConfigRemote = Remote.remoteSchema(ConfigView);

export const Model = Schema.Struct({
  route: ViewModels.Route,
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

const FetchConfig = defineApiCommand("PublicLandingFetchConfig", {
  args: { seq: Remote.Seq },
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
  Message.match(message, {
    GotConfig: ({ seq, config }) => ({
      model: { ...model, config: Remote.succeed(model.config, seq, config) },
    }),
    FailedConfig: ({ seq, failure }) => ({
      model: { ...model, config: Remote.fail(model.config, seq, failure) },
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const title = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("public.landing.title");

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const cfg = Remote.dataOf(model.config);
  const signUpEnabled = cfg?.features.signUp ?? true;
  const firstWs = ctx.session._tag === "SignedIn" ? ctx.session.workspaces[0] : undefined;
  const sampleAmount = Format.moneyDisplay(ctx.locale, { amount: "48400.00", currency: "CZK" });

  return h.div
    .class("flex flex-col gap-12 pb-16")
    .attr("data-slot", "landing")
    .children([
      h.section
        .class(
          "kb-pattern relative border-b border-outline-variant bg-surface-container-low px-4 py-8 min-[761px]:px-7 min-[761px]:py-14",
        )
        .attr("data-slot", "landing-hero")
        .children([
          h.div
            .class(
              "mx-auto grid max-w-[1120px] grid-cols-[minmax(0,1fr)] items-center gap-9 min-[761px]:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]",
            )
            .children([
              h.div
                .class(
                  "flex flex-col gap-4.5 rounded-panel border border-outline-variant bg-[color-mix(in_srgb,var(--md-sys-color-surface)_92%,transparent)] p-7",
                )
                .children([
                  h.div.class(ui.row).children([lockup(h, "horizontal", 32)]),
                  h.span
                    .class(cn(ui.small, ui.muted))
                    .attr("data-slot", "landing-tagline")
                    .children([t.t("app.tagline")]),
                  h.h1
                    .class(
                      "font-display text-[clamp(1.85rem,3.4vw,2.5rem)] leading-[1.15] tracking-[-0.02em] text-on-surface",
                    )
                    .attr("data-slot", "landing-title")
                    .children([t.t("public.landing.title")]),
                  h.p
                    .class("max-w-[54ch] text-base leading-normal text-on-surface-variant")
                    .children([t.t("public.landing.subtitle")]),
                  ...(!signUpEnabled
                    ? [banner(h, { text: t.t("public.landing.signUpDisabled"), tone: "info" })]
                    : []),
                  h.div.class("mt-1 flex flex-wrap items-center gap-2.5").children(
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
                .class(
                  "flex flex-col gap-3.5 rounded-panel border border-outline-variant bg-surface-container-lowest p-5",
                )
                .attr("aria-label", local(ctx.locale, "previewLabel"))
                .children([
                  h.div
                    .class(ui.spread)
                    .children([
                      h.strong.children([local(ctx.locale, "previewNumber")]),
                      badge(h, local(ctx.locale, "previewStatus"), "paid"),
                    ]),
                  h.span
                    .class(cn(ui.small, ui.muted))
                    .children([local(ctx.locale, "previewIssuer")]),
                  h.hr.class(ui.divider),
                  h.div
                    .class(ui.spread)
                    .children([
                      h.span.class(ui.small).children([local(ctx.locale, "previewBuyer")]),
                      h.span
                        .class(cn("font-display text-[1.5rem] leading-[1.875rem]", ui.num))
                        .children([sampleAmount.text]),
                    ]),
                  h.span.class(ui.footnote).children([local(ctx.locale, "previewDue")]),
                ]),
            ]),
        ]),
      h.section
        .class("mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 min-[761px]:px-7")
        .children([
          h.h2.children([local(ctx.locale, "featuresHeading")]),
          h.div
            .class("grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4")
            .children(
              FEATURES.map((f) =>
                card(h, [
                  h.div
                    .class("flex flex-col gap-2")
                    .children([
                      h.span
                        .class(
                          "inline-flex h-9 w-9 items-center justify-center rounded-control bg-surface-container text-primary",
                        )
                        .children([icon(h, f.icon, 20)]),
                      h.h3.children([t.t(f.titleKey)]),
                      h.p.class(ui.muted).children([t.t(f.bodyKey)]),
                    ]),
                ]),
              ),
            ),
        ]),
      h.section
        .class("mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 min-[761px]:px-7")
        .children([
          h.div
            .class(
              "flex flex-wrap items-center justify-between gap-4 rounded-panel border border-outline-variant bg-surface-container-low px-6 py-5",
            )
            .children([
              h.div
                .class("flex flex-col gap-1")
                .children([
                  h.strong.children([t.t("app.name")]),
                  h.p.class(ui.muted).children([t.t("public.landing.selfHosted")]),
                ]),
              h.div.class(ui.row).children([
                linkButton(h, {
                  label: local(ctx.locale, "selfHostAction"),
                  href: href({ _tag: "AndroidDownload" }),
                  variant: "secondary",
                }),
                h.a
                  .class(buttonVariants({ variant: "ghost" }))
                  .attr("href", "/app/")
                  .children([local(ctx.locale, "pwaCta")]),
              ]),
            ]),
        ]),
    ]);
};
