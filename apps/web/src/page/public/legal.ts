import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 01 — Legal pages (Terms of Service & Privacy Policy).
 * Route kind `terms | privacy`, full bilingual cs/en copy.
 */
import { ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { copy, translator } from "../../app/i18n";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import { href } from "../../app/routing";
import { card, linkButton, pageHeader, tabs } from "../../ui/kit";

export type Route = RouteOf<"Legal">;

export const Model = Schema.Struct({
  route: ViewModels.Route,
  kind: Schema.Literals(["terms", "privacy"]),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    navLabel: "Právní dokumenty",
    updated: "Účinnost od 1. 11. 2026",
    backHome: "Zpět na úvodní stránku",
    termsIntro:
      "Tyto obchodní podmínky upravují používání fakturační služby Kvitbit pro správu dokladů, kontaktů a nákladů.",
    termsS1Title: "1. Rozsah služby",
    termsS1Body:
      "Kvitbit poskytuje webové, mobilní a MCP rozhraní pro vystavování faktur, zálohových faktur, daňových dokladů k platbě a opravných daňových dokladů v souladu s českou a evropskou legislativou.",
    termsS2Title: "2. Účty a pracovní prostory",
    termsS2Body:
      "Za správnost fakturačních údajů, daňového režimu a podání daňových přiznání odpovídá provozovatel příslušného pracovního prostoru. Přístupové tokeny a API klíče chraňte před zneužitím.",
    termsS3Title: "3. Dostupnost a export dat",
    termsS3Body:
      "Své doklady, přílohy a přehledy můžete kdykoli exportovat ve formátech CSV a PDF. V případě vlastního hostingu (self-hosting) odpovídá za zálohy a provoz správce instalace.",
    privacyIntro:
      "Ochrana osobních údajů podle nařízení (EU) 2016/679 (GDPR). Zpracováváme údaje pro provoz vašeho účtu, fakturaci a měření používání služby.",
    privacyS1Title: "1. Jaké údaje zpracováváme",
    privacyS1Body:
      "Identifikační a kontaktní údaje účtu (e-mail, jméno, přístupové klíče), údaje pracovního prostoru (IČO, DIČ, bankovní účty) a data dokladů a kontaktů, které do služby uložíte.",
    privacyS2Title: "2. Soubory cookie a místní úložiště",
    privacyS2Body:
      "Používáme pouze technicky nezbytné soubory cookie pro přihlášenou relaci a uložení předvoleb rozhraní (jazyk, motiv, kontrast). Nepoužíváme reklamní ani sledovací soubory cookie.",
    privacyS3Title: "3. Analytika bez souborů cookie",
    privacyS3Body:
      "Na webu a v mobilní webové aplikaci měříme návštěvy stránek pomocí PostHog EU (Frankfurt nad Mohanem, Německo). Do analytiky posíláme jen zobecněné adresy stránek bez parametrů a přístupových tokenů. PostHog používá IP adresu a informace o prohlížeči k výpočtu denní statistiky návštěvnosti bez souborů cookie. Obsah faktur ani osobní údaje vašich zákazníků do PostHog neposíláme.",
    privacyS4Title: "4. Veřejné odkazy a vaše práva",
    privacyS4Body:
      "Veřejné odkazy na doklady (/i/:token) jsou neveřejné a neindexované vyhledávači. Máte právo na přístup ke svým údajům, jejich opravu, export a smazání účtu v sekci Účet.",
  },
  en: {
    navLabel: "Legal documents",
    updated: "Effective from 1 November 2026",
    backHome: "Back to home",
    termsIntro:
      "These terms of service govern your use of Kvitbit for managing invoices, contacts, and expenses.",
    termsS1Title: "1. Scope of service",
    termsS1Body:
      "Kvitbit provides web, mobile, and MCP interfaces for issuing invoices, proformas, payment tax documents, and credit notes aligned with Czech and EU invoicing rules.",
    termsS2Title: "2. Accounts and workspaces",
    termsS2Body:
      "Each workspace owner is responsible for the accuracy of business details, tax regime selection, and statutory filings. Keep session credentials, passkeys, and API keys confidential.",
    termsS3Title: "3. Availability and data portability",
    termsS3Body:
      "You can export your documents, attachments, and reports at any time in CSV and PDF formats. For self-hosted installations, the installation operator is responsible for backups and uptime.",
    privacyIntro:
      "Privacy notice under Regulation (EU) 2016/679 (GDPR). We process data to run your account and invoicing workspaces and measure how the service is used.",
    privacyS1Title: "1. Data we process",
    privacyS1Body:
      "Account details (email, name, passkey credentials), workspace business records (IČO, DIČ, bank accounts), and the documents, expenses, and contacts you store.",
    privacyS2Title: "2. Cookies and local storage",
    privacyS2Body:
      "We use strictly necessary cookies for your authenticated session and UI preferences (language, theme, contrast). We do not use advertising or tracking cookies.",
    privacyS3Title: "3. Cookieless analytics",
    privacyS3Body:
      "We measure page visits on our website and mobile web app using PostHog EU (Frankfurt, Germany). We send only generalised page addresses with parameters and access tokens removed. PostHog uses IP addresses and browser information to calculate daily visit statistics without cookies. We do not send invoice contents or your customers' personal data to PostHog.",
    privacyS4Title: "4. Shared links and your rights",
    privacyS4Body:
      "Public document share links (/i/:token) are unindexed and revocable at any time. You have the right to access, correct, export, or delete your account data from Account settings.",
  },
});

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => ({
  model: { route, kind: route.page },
});

export const update = (
  model: Model,
  _message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> => ({ model });

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  return model.kind === "terms" ? t.t("public.legal.terms") : t.t("public.legal.privacy");
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const heading = model.kind === "terms" ? t.t("public.legal.terms") : t.t("public.legal.privacy");
  const sections =
    model.kind === "terms"
      ? [
          {
            title: local(ctx.locale, "termsS1Title"),
            body: local(ctx.locale, "termsS1Body"),
          },
          {
            title: local(ctx.locale, "termsS2Title"),
            body: local(ctx.locale, "termsS2Body"),
          },
          {
            title: local(ctx.locale, "termsS3Title"),
            body: local(ctx.locale, "termsS3Body"),
          },
        ]
      : [
          {
            title: local(ctx.locale, "privacyS1Title"),
            body: local(ctx.locale, "privacyS1Body"),
          },
          {
            title: local(ctx.locale, "privacyS2Title"),
            body: local(ctx.locale, "privacyS2Body"),
          },
          {
            title: local(ctx.locale, "privacyS3Title"),
            body: local(ctx.locale, "privacyS3Body"),
          },
          {
            title: local(ctx.locale, "privacyS4Title"),
            body: local(ctx.locale, "privacyS4Body"),
          },
        ];

  return h.div.class("kb-legal").children([
    pageHeader(h, {
      title: heading,
      subtitle: local(ctx.locale, "updated"),
      actions: [
        linkButton(h, {
          label: local(ctx.locale, "backHome"),
          href: href({ _tag: "Landing" }),
          variant: "ghost",
          small: true,
        }),
      ],
    }),
    tabs(h, {
      label: local(ctx.locale, "navLabel"),
      selected: model.kind,
      items: [
        {
          id: "terms",
          label: t.t("public.legal.terms"),
          href: href({ _tag: "Legal", page: "terms" }),
        },
        {
          id: "privacy",
          label: t.t("public.legal.privacy"),
          href: href({ _tag: "Legal", page: "privacy" }),
        },
      ],
    }),
    card(h, [
      h.article
        .class("kb-legal__article")
        .children([
          h.p.children([local(ctx.locale, model.kind === "terms" ? "termsIntro" : "privacyIntro")]),
          ...sections.map((s) =>
            h.section
              .class("kb-legal__section")
              .children([h.h2.children([s.title]), h.p.children([s.body])]),
          ),
        ]),
    ]),
  ]);
};
