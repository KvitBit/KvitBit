import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 04 — Tokenized Public Share Link (/i/:token).
 * Renders unpaid CZK/EUR documents with SPAYD/EPC QR block, bank details, copy helpers,
 * PDF download, paid/overdue/proforma/credit-note/cancelled/revoked states, and scoped
 * Workspace branding theme override when provided.
 */
import { SharedDocumentView, ShareToken, ThemeSource } from "@kvitbit/domain";
import { Format, I18n, Theme } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { mark } from "../../ui/brand";
import { attribute, withAttributes } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  amount,
  badge,
  banner,
  button,
  card,
  dl,
  mono,
  segmented,
  skeleton,
  table,
} from "../../ui/kit";
import { paymentQrView } from "./_qr";
import {
  callApi,
  copyToClipboard,
  failureMessage,
  formatAddressLine,
  parseContact,
  parseIssuer,
  parseLine,
  settlementTone,
  statusTone,
} from "./_shared";

export const Route = RouteCases.Share;
export type Route = typeof Route.Type;

const ShareRemote = Remote.remoteSchema(SharedDocumentView);

export const Model = Schema.Struct({
  route: Route,
  token: Schema.String,
  doc: ShareRemote,
  pdfLanguage: Schema.Literals(["cs", "en"]),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  GotDocument: { seq: Remote.Seq, token: Schema.String, doc: SharedDocumentView },
  FailedDocument: { seq: Remote.Seq, token: Schema.String, failure: Failure },
  ClickedRetry: {},
  SelectedPdfLanguage: { language: Schema.Literals(["cs", "en"]) },
  ClickedCopy: { value: Schema.String },
  CopiedValue: { ok: Schema.Boolean },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    issuer: "Dodavatel",
    buyer: "Odběratel",
    taxableSupply: "DUZP",
    linesCaption: "Položky dokladu",
    vatSummary: "Rekapitulace DPH",
    rate: "Sazba",
    base: "Základ",
    vatAmount: "DPH",
    gross: "Celkem",
    rounding: "Zaokrouhlení",
    vatCzk: "DPH v CZK",
    overdue: "Po splatnosti",
    updatedOn: "Aktualizováno {date}",
    account: "Číslo účtu",
  },
  en: {
    issuer: "Supplier",
    buyer: "Customer",
    taxableSupply: "Taxable supply",
    linesCaption: "Document line items",
    vatSummary: "VAT summary",
    rate: "Rate",
    base: "Base",
    vatAmount: "VAT",
    gross: "Total",
    rounding: "Rounding",
    vatCzk: "VAT in CZK",
    overdue: "Overdue",
    updatedOn: "Updated on {date}",
    account: "Account number",
  },
});

const FetchShare = defineApiCommand({
  message: Message,
  name: "PublicShareFetch",
  args: { token: Schema.String, seq: Remote.Seq },
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.publicShare.open({ params: { token: ShareToken.make(token) } }),
      (doc) => Message.GotDocument({ seq, token, doc }),
      (failure) => Message.FailedDocument({ seq, token, failure }),
    ),
});

const CopyShare = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "PublicShareCopy",
  args: { value: Schema.String },
  execute: ({ value }) => copyToClipboard(value, (ok) => Message.CopiedValue({ ok })),
});

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const doc = Remote.load(Remote.idle);
  const seq = Remote.seqOf(doc);
  return {
    model: { route, token: route.token, doc, pdfLanguage: ctx.locale },
    commands: [FetchShare({ token: route.token, seq })],
  };
};

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> =>
  Message.match(message, {
    GotDocument: ({ seq, token, doc }) => {
      if (token !== model.token) return { model };
      const next = Remote.succeed(model.doc, seq, doc);
      if (next === model.doc) return { model };
      return {
        model: {
          ...model,
          doc: next,
          pdfLanguage: next._tag === "Loaded" ? doc.language : model.pdfLanguage,
        },
      };
    },
    FailedDocument: ({ seq, token, failure }) =>
      token !== model.token
        ? { model }
        : { model: { ...model, doc: Remote.fail(model.doc, seq, failure) } },
    ClickedRetry: () => {
      const doc = Remote.load(model.doc);
      const seq = Remote.seqOf(doc);
      return {
        model: { ...model, doc },
        commands: [FetchShare({ token: model.token, seq })],
      };
    },
    SelectedPdfLanguage: ({ language }) => ({
      model: { ...model, pdfLanguage: language },
    }),
    ClickedCopy: ({ value }) => ({
      model,
      commands: [CopyShare({ value })],
    }),
    CopiedValue: ({ ok }) => ({
      model,
      outMessage: ok ? Intent_.toast(translator(ctx.locale).t("common.toast.copied")) : undefined,
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const doc = Remote.dataOf(model.doc);
  const t = translator(ctx.locale);
  if (doc === undefined) return t.t("share.view.gone.title");
  const kind = t.translate(I18n.enumText("documentKind", doc.kind));
  return t.t("share.view.title", { kind, number: doc.number });
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const shareThemeCache = new Map<string, string>();
const encodeTheme = Schema.encodeOption(Schema.fromJsonString(ThemeSource));

const SHARE_STYLE = "elegant" as const;

const scopedBrandCss = (doc: SharedDocumentView): string => {
  const theme = doc.branding.theme;
  const key = theme === null ? "default" : Option.getOrElse(encodeTheme(theme), () => "invalid");

  const hit = shareThemeCache.get(key);
  if (hit !== undefined) return hit;
  const resolved = doc.branding.theme === null ? null : Theme.resolveSource(doc.branding.theme);
  const schemes =
    resolved !== null && Result.isSuccess(resolved) ? resolved.success : Theme.KvitbitDefaultTheme;
  const css = Theme.themeStylesheet(schemes, SHARE_STYLE, ".kb-share-themed");
  if (shareThemeCache.size > 16) shareThemeCache.clear();
  shareThemeCache.set(key, css);
  return css;
};

const digitsOf = (value: string): string => Str.slice(0, 10)(Str.replace(/\D/g, "")(value));

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);

  if (model.doc._tag === "Loading" || model.doc._tag === "Idle") {
    return h.div
      .class("kb-share-wrap")
      .attr("aria-busy", String(true))
      .children([
        h.div
          .class("kb-share-paper")
          .children([
            skeleton(h, "45%", "1.75rem"),
            skeleton(h, "100%", "7rem"),
            skeleton(h, "100%", "10rem"),
          ]),
      ]);
  }

  if (model.doc._tag === "Failed") {
    const gone = model.doc.failure.tag === "NotFound" || model.doc.failure.tag === "Forbidden";
    return h.div.class("kb-error-shell").children([
      card(
        h,
        [
          h.div
            .class("kb-row")
            .children([
              icon(h, "alert", 20),
              h.h1.children([gone ? t.t("share.view.gone.title") : t.t("common.state.error")]),
            ]),
          h.p
            .class("kb-muted")
            .children([gone ? t.t("share.view.gone.body") : failureMessage(t, model.doc.failure)]),
          ...(!gone
            ? [
                h.div.class("kb-row").children([
                  button(h, {
                    label: t.t("common.action.retry"),
                    onClick: Message.ClickedRetry(),
                    variant: "primary",
                  }),
                ]),
              ]
            : []),
        ],
        [attribute("class", "kb-card kb-error-card")],
      ),
    ]);
  }

  const doc = model.doc.data;
  const issuer = parseIssuer(doc.issuer);
  const contact = parseContact(doc.contact);
  const accountNumber = issuer?.bankAccount?.accountNumber ?? "";
  const iban = issuer?.bankAccount?.iban ?? "";
  const bic = issuer?.bankAccount?.bic ?? "";
  const issuerIco = issuer?.ico ?? "";
  const issuerDic = issuer?.dic ?? "";
  const registerEntry = issuer?.registerEntry ?? "";
  const contactIco = contact?.ico ?? "";
  const contactDic = contact?.dic ?? "";
  const lines = Arr.map(doc.lines, (raw, i) => ({ raw, parsed: parseLine(raw), key: `l-${i}` }));
  const kindLabel = t.translate(I18n.enumText("documentKind", doc.kind));
  const settlementLabel = t.translate(I18n.enumText("settlement", doc.settlement));
  const statusLabel = t.translate(I18n.enumText("documentStatus", doc.status));
  const amountDueDisplay = Format.moneyDisplay(ctx.locale, {
    amount: doc.amountDue.amount,
    currency: doc.amountDue.currency,
  });
  const netDisplay = Format.moneyDisplay(ctx.locale, {
    amount: doc.totals.net.amount,
    currency: doc.totals.net.currency,
  });
  const vatDisplay = Format.moneyDisplay(ctx.locale, {
    amount: doc.totals.vat.amount,
    currency: doc.totals.vat.currency,
  });
  const grossDisplay = Format.moneyDisplay(ctx.locale, {
    amount: doc.totals.gross.amount,
    currency: doc.totals.gross.currency,
  });
  const isOverdue =
    doc.status === "issued" &&
    (doc.settlement === "unpaid" || doc.settlement === "partially_paid") &&
    doc.dates.dueOn < ctx.today;
  const showPayBlock =
    doc.status === "issued" &&
    doc.kind !== "credit_note" &&
    (doc.settlement === "unpaid" || doc.settlement === "partially_paid");
  const vs = digitsOf(doc.number);
  const pdfHref = `${doc.pdfUrl}${Str.includes("?")(doc.pdfUrl) ? "&" : "?"}language=${model.pdfLanguage}`;
  const brandCss = scopedBrandCss(doc);

  return withAttributes(h.div.class(), [
    (element) => element.class("kb-share-wrap kb-share-themed"),
    (element) => element.attr("data-style", SHARE_STYLE),
    (node) => (doc.branding.theme !== null ? node.attr("data-branded", "1") : node),
  ]).children([
    h.el("style").attr("id", "kb-share-brand-theme").children([brandCss]),
    ...(doc.viewerIsIssuer
      ? [banner(h, { text: t.t("share.view.issuerPreview"), tone: "info" })]
      : []),
    ...(doc.status === "cancelled"
      ? [banner(h, { text: t.t("share.view.cancelled"), tone: "error" })]
      : []),
    ...(doc.settlement === "paid"
      ? [banner(h, { text: t.t("share.view.paidThanks"), tone: "info" })]
      : []),
    ...(doc.kind === "proforma"
      ? [banner(h, { text: t.t("share.view.notTaxDocument"), tone: "neutral" })]
      : []),
    ...(doc.kind === "credit_note" && doc.correctsNumber !== null
      ? [
          banner(h, {
            text: t.t("share.view.creditNoteFor", { number: doc.correctsNumber }),
            tone: "neutral",
          }),
        ]
      : []),
    h.article.class("kb-share-paper").children([
      h.header.class("kb-share-hero").children([
        h.div
          .class("kb-stack")
          .style({ "--kb-gap": "6px" })
          .children([
            h.div
              .class("kb-row")
              .children([
                h.h1.children([t.t("share.view.title", { kind: kindLabel, number: doc.number })]),
                badge(h, settlementLabel, settlementTone(doc.settlement)),
                ...(doc.status !== "issued" ? [badge(h, statusLabel, statusTone(doc.status))] : []),
                ...(isOverdue ? [badge(h, local(ctx.locale, "overdue"), "overdue")] : []),
              ]),
            ...(issuer !== undefined
              ? [h.p.class("kb-muted").children([t.t("share.view.from", { issuer: issuer.name })])]
              : []),
            h.div.class("kb-row kb-small kb-muted").children([
              h.span.children([
                t.t("share.view.issuedOn", {
                  date: Format.formatDate(ctx.locale, doc.dates.issuedOn),
                }),
              ]),
              ...(doc.dates.taxableSupplyOn !== null
                ? [
                    h.span.children([
                      `${local(ctx.locale, "taxableSupply")}: ${Format.formatDate(ctx.locale, doc.dates.taxableSupplyOn)}`,
                    ]),
                  ]
                : []),
              h.span.children([
                t.t("share.view.dueOn", {
                  date: Format.formatDate(ctx.locale, doc.dates.dueOn),
                }),
              ]),
            ]),
            ...(doc.updatedAt !== null
              ? [
                  h.span.class("kb-footnote").children([
                    local(ctx.locale, "updatedOn", {
                      date: Format.formatDate(ctx.locale, Str.slice(0, 10)(doc.updatedAt)),
                    }),
                  ]),
                ]
              : []),
          ]),
        h.div.class("kb-share-due").children([
          h.span.class("kb-small kb-muted").children([t.t("share.view.amountDue")]),
          h.span.class("kb-share-due__amount kb-num").children([amountDueDisplay.text]),
          h.div
            .class("kb-row")
            .style({ marginTop: "6px" })
            .children([
              segmented(h, {
                label: t.t("share.view.language"),
                selected: model.pdfLanguage,
                items: [
                  { id: "cs", label: "CS" },
                  { id: "en", label: "EN" },
                ],
                onSelect: (id) =>
                  Message.SelectedPdfLanguage({ language: id === "en" ? "en" : "cs" }),
              }),
              h.a
                .class("kb-btn kb-btn--primary kb-btn--small")
                .attr("href", pdfHref)
                .attr("download", "")
                .children([icon(h, "download", 16), t.t("common.action.downloadPdf")]),
            ]),
        ]),
      ]),
      ...(showPayBlock
        ? [
            h.section
              .class("kb-share-pay")
              .attr("aria-label", t.t("share.view.bankDetails"))
              .children([
                ...(doc.paymentQr !== null
                  ? [
                      h.div
                        .class("kb-stack")
                        .style({ alignItems: "center", "--kb-gap": "6px" })
                        .children([
                          paymentQrView(
                            h,
                            doc.paymentQr.payload,
                            t.translate(I18n.enumText("qrFormat", doc.paymentQr.format)),
                          ),
                          h.span
                            .class("kb-small")
                            .children([
                              t.translate(I18n.enumText("qrFormat", doc.paymentQr.format)),
                            ]),
                          h.span.class("kb-footnote").children([t.t("share.view.scanHint")]),
                        ]),
                    ]
                  : [h.text("")]),
                h.div.class("kb-stack").children([
                  h.h2.children([t.t("share.view.bankDetails")]),
                  dl(h, [
                    ...(accountNumber !== ""
                      ? [[local(ctx.locale, "account"), mono(h, accountNumber)] as const]
                      : []),
                    ...(iban !== ""
                      ? [[t.t("common.field.iban"), mono(h, Format.formatIban(iban))] as const]
                      : []),
                    ...(bic !== "" ? [[t.t("common.field.bic"), mono(h, bic)] as const] : []),
                    ...(vs !== ""
                      ? [[t.t("common.field.variableSymbol"), mono(h, vs)] as const]
                      : []),
                    [t.t("share.view.amountDue"), amount(h, amountDueDisplay.text)],
                  ]),
                  h.div.class("kb-row").children([
                    ...(iban !== ""
                      ? [
                          button(h, {
                            label: t.t("share.view.copyIban"),
                            onClick: Message.ClickedCopy({
                              value: iban,
                            }),
                            small: true,
                          }),
                        ]
                      : []),
                    ...(vs !== ""
                      ? [
                          button(h, {
                            label: t.t("share.view.copyVs"),
                            onClick: Message.ClickedCopy({ value: vs }),
                            small: true,
                          }),
                        ]
                      : []),
                    button(h, {
                      label: t.t("share.view.copyAmount"),
                      onClick: Message.ClickedCopy({
                        value: String(doc.amountDue.amount),
                      }),
                      small: true,
                    }),
                  ]),
                ]),
              ]),
          ]
        : []),
      h.section.class("kb-share-parties").children([
        h.div
          .class("kb-stack")
          .style({ "--kb-gap": "4px" })
          .children([
            h.span.class("kb-small kb-muted").children([local(ctx.locale, "issuer")]),
            h.strong.children([issuer?.name ?? ""]),
            ...(issuer?.address !== undefined
              ? [h.span.class("kb-small").children([formatAddressLine(issuer.address)])]
              : []),
            ...(issuerIco !== ""
              ? [h.span.class("kb-small kb-muted").children([`IČO: ${issuerIco}`])]
              : []),
            ...(issuerDic !== ""
              ? [h.span.class("kb-small kb-muted").children([`DIČ: ${issuerDic}`])]
              : []),
            ...(registerEntry !== ""
              ? [h.span.class("kb-footnote").children([registerEntry])]
              : []),
          ]),
        h.div
          .class("kb-stack")
          .style({ "--kb-gap": "4px" })
          .children([
            h.span.class("kb-small kb-muted").children([local(ctx.locale, "buyer")]),
            h.strong.children([contact?.name ?? ""]),
            ...(contact?.address !== undefined
              ? [h.span.class("kb-small").children([formatAddressLine(contact.address)])]
              : []),
            ...(contactIco !== ""
              ? [h.span.class("kb-small kb-muted").children([`IČO: ${contactIco}`])]
              : []),
            ...(contactDic !== ""
              ? [h.span.class("kb-small kb-muted").children([`DIČ: ${contactDic}`])]
              : []),
          ]),
      ]),
      table(h, {
        caption: local(ctx.locale, "linesCaption"),
        rowKey: (row) => row.key,
        rows: lines,
        columns: [
          {
            header: t.t("common.field.description"),
            cell: (r) => r.parsed?.description ?? "",
          },
          {
            header: t.t("common.field.quantity"),
            align: "end",
            numeric: true,
            cell: (r) =>
              r.parsed !== undefined
                ? Format.formatQuantity(ctx.locale, r.parsed.quantity, r.parsed.unit ?? undefined)
                : "",
          },
          {
            header: t.t("common.field.unitPrice"),
            align: "end",
            numeric: true,
            cell: (r) =>
              r.parsed !== undefined
                ? Format.moneyDisplay(ctx.locale, {
                    amount: r.parsed.unitPrice,
                    currency: doc.totals.gross.currency,
                  }).text
                : "",
          },
          ...(doc.taxDocument
            ? [
                {
                  header: t.t("common.field.vatRate"),
                  align: "end" as const,
                  numeric: true,
                  cell: (r: (typeof lines)[number]) =>
                    r.parsed?.ratePercent !== undefined
                      ? Format.formatVatRate(ctx.locale, Number(r.parsed.ratePercent))
                      : "—",
                },
              ]
            : []),
          {
            header: t.t("common.field.total"),
            align: "end",
            numeric: true,
            cell: (r) =>
              r.parsed !== undefined
                ? Format.moneyDisplay(ctx.locale, {
                    amount: r.parsed.amount,
                    currency: doc.totals.gross.currency,
                  }).text
                : "",
          },
        ],
      }),
      h.div.class("kb-share-totals").children([
        h.div
          .class("kb-share-totals__row")
          .children([
            h.span.class("kb-muted").children([t.t("common.field.subtotal")]),
            amount(h, netDisplay.text),
          ]),
        ...(doc.taxDocument
          ? [
              h.div
                .class("kb-share-totals__row")
                .children([
                  h.span.class("kb-muted").children([t.t("common.field.vat")]),
                  amount(h, vatDisplay.text),
                ]),
            ]
          : []),
        ...(doc.totals.vatCzk !== null
          ? [
              h.div.class("kb-share-totals__row kb-small").children([
                h.span.class("kb-muted").children([local(ctx.locale, "vatCzk")]),
                amount(
                  h,
                  Format.moneyDisplay(ctx.locale, {
                    amount: doc.totals.vatCzk.amount,
                    currency: doc.totals.vatCzk.currency,
                  }).text,
                ),
              ]),
            ]
          : []),
        h.div
          .class("kb-share-totals__row kb-share-totals__grand")
          .children([h.span.children([t.t("common.field.total")]), amount(h, grossDisplay.text)]),
      ]),
      ...(doc.note !== null || doc.statutoryNotes.length > 0 || doc.branding.footerText !== null
        ? [
            h.hr.class("kb-divider"),
            h.div
              .class("kb-stack")
              .style({ "--kb-gap": "6px" })
              .children([
                ...(doc.note !== null ? [h.p.class("kb-small").children([doc.note])] : []),
                ...Arr.map(doc.statutoryNotes, (n) => h.p.class("kb-footnote").children([n.text])),
                ...(doc.branding.footerText !== null
                  ? [h.p.class("kb-footnote").children([doc.branding.footerText])]
                  : []),
              ]),
          ]
        : []),
    ]),
    h.div
      .class("kb-share-powered")
      .children([mark(h, 14), h.span.children([t.t("share.view.poweredBy")])]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
