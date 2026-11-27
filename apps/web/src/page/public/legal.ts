import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 01 — Legal pages (Terms of Service & Privacy Policy).
 * Route kind `terms | privacy`, full bilingual cs/en copy.
 */
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { copy, translator } from "../../app/i18n";
import { type PageContext, type PageReturn, RouteCases } from "../../app/page";
import { href } from "../../app/routing";
import { card, linkButton, pageHeader, tabs } from "../../ui/kit";

export const Route = RouteCases.Legal;
export type Route = typeof Route.Type;

export const Model = Schema.Struct({
  route: Route,
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
      "Ochrana osobních údajů podle nařízení (EU) 2016/679 (GDPR). Zpracováváme pouze údaje nezbytné pro provoz vašeho účtu a fakturace.",
    privacyS1Title: "1. Jaké údaje zpracováváme",
    privacyS1Body:
      "Identifikační a kontaktní údaje účtu (e-mail, jméno, přístupové klíče), údaje pracovního prostoru (IČO, DIČ, bankovní účty) a data dokladů a kontaktů, které do služby uložíte.",
    privacyS2Title: "2. Soubory cookie a místní úložiště",
    privacyS2Body:
      "Používáme pouze technicky nezbytné soubory cookie pro přihlášenou relaci a uložení předvoleb rozhraní (jazyk, motiv, kontrast). Nepoužíváme reklamní ani sledovací soubory cookie třetích stran.",
    privacyS3Title: "3. Veřejné odkazy a vaše práva",
    privacyS3Body:
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
      "Privacy notice under Regulation (EU) 2016/679 (GDPR). We process only the data required to operate your account and invoicing workspaces.",
    privacyS1Title: "1. Data we process",
    privacyS1Body:
      "Account details (email, name, passkey credentials), workspace business records (IČO, DIČ, bank accounts), and the documents, expenses, and contacts you store.",
    privacyS2Title: "2. Cookies and local storage",
    privacyS2Body:
      "We use strictly necessary cookies for your authenticated session and UI preferences (language, theme, contrast). We do not use third-party advertising or tracking cookies.",
    privacyS3Title: "3. Shared links and your rights",
    privacyS3Body:
      "Public document share links (/i/:token) are unindexed and revocable at any time. You have the right to access, correct, export, or delete your account data from Account settings.",
  },
});

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => ({
  model: { route, kind: route.page },
});

export const init: {
  (_ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (
  model: Model,
  _message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> => ({ model });

export const update: {
  (_message: Message, _ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, _message: Message, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  return model.kind === "terms" ? t.t("public.legal.terms") : t.t("public.legal.privacy");
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
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
          ...Arr.map(sections, (s) =>
            h.section
              .class("kb-legal__section")
              .children([h.h2.children([s.title]), h.p.children([s.body])]),
          ),
        ]),
    ]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
