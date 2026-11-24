/**
 * Screen 04 — Tokenized Public Share Link (/i/:token).
 * Renders unpaid CZK/EUR documents with SPAYD/EPC QR block, bank details, copy helpers,
 * PDF download, paid/overdue/proforma/credit-note/cancelled/revoked states, and scoped
 * Workspace branding theme override when provided.
 */
import { SharedDocumentView } from "@kvitbit/domain";
import { Format, I18n, Theme, ViewModels } from "@kvitbit/ui-port";
import { Result, Schema } from "effect";
import { Command, Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Failure } from "../../app/api";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { mark } from "../../ui/brand";
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

export type Route = RouteOf<"Share">;

const ShareRemote = Remote.remoteSchema(SharedDocumentView);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  token: Schema.String,
  doc: ShareRemote,
  pdfLanguage: Schema.Literals(["cs", "en"]),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotDocument: { seq: Remote.Seq, doc: SharedDocumentView },
  FailedDocument: { seq: Remote.Seq, failure: Failure },
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

const FetchShare = Command.define("PublicShareFetch", {
  args: { token: Schema.String, seq: Remote.Seq },
  messages: [Message.GotDocument, Message.FailedDocument],
  execute: ({ token, seq }) =>
    callApi(
      (client) => client.publicShare.open({ params: { token: token as Route["token"] } }),
      (doc) => Message.GotDocument({ seq, doc }),
      (failure) => Message.FailedDocument({ seq, failure }),
    ),
});

const CopyShare = Command.define("PublicShareCopy", {
  args: { value: Schema.String },
  messages: [Message.CopiedValue],
  execute: ({ value }) => copyToClipboard(value, (ok) => Message.CopiedValue({ ok })),
});

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const doc = Remote.load(Remote.idle);
  const seq = Remote.seqOf(doc);
  return {
    model: { route, token: route.token, doc, pdfLanguage: ctx.locale },
    commands: [FetchShare({ token: route.token, seq })],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
    GotDocument: ({ seq, doc }) => {
      const next = Remote.succeed(model.doc, seq, doc);
      return {
        model: {
          ...model,
          doc: next,
          pdfLanguage: next._tag === "Loaded" ? doc.language : model.pdfLanguage,
        },
      };
    },
    FailedDocument: ({ seq, failure }) => ({
      model: { ...model, doc: Remote.fail(model.doc, seq, failure) },
    }),
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
      ...(ok ? { outMessage: Intent_.toast(translator(ctx.locale).t("common.toast.copied")) } : {}),
    }),
  });

export const title = (model: Model, ctx: PageContext): string => {
  const doc = Remote.dataOf(model.doc);
  const t = translator(ctx.locale);
  if (doc === undefined) return t.t("share.view.gone.title");
  const kind = t.translate(I18n.enumText("documentKind", doc.kind));
  return t.t("share.view.title", { kind, number: doc.number });
};

const shareThemeCache = new Map<string, string>();

const scopedBrandCss = (
  doc: SharedDocumentView,
  style: PageContext["prefs"]["style"],
): string | null => {
  if (doc.branding.theme === null) return null;
  const key = `${JSON.stringify(doc.branding.theme)}|${style}`;
  const hit = shareThemeCache.get(key);
  if (hit !== undefined) return hit;
  const resolved = Theme.resolveSource(doc.branding.theme);
  if (!Result.isSuccess(resolved)) return null;
  const css = Theme.themeStylesheet(resolved.success, style, ".kb-share-themed");
  if (shareThemeCache.size > 16) shareThemeCache.clear();
  shareThemeCache.set(key, css);
  return css;
};

const digitsOf = (value: string): string => value.replace(/\D/g, "").slice(0, 10);

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const t = translator(ctx.locale);

  if (model.doc._tag === "Loading" || model.doc._tag === "Idle") {
    return h.div(
      [h.Class("kb-share-wrap"), h.AriaBusy(true)],
      [
        h.div(
          [h.Class("kb-share-paper")],
          [
            skeleton(h, "45%", "1.75rem"),
            skeleton(h, "100%", "7rem"),
            skeleton(h, "100%", "10rem"),
          ],
        ),
      ],
    );
  }

  if (model.doc._tag === "Failed") {
    const gone = model.doc.failure.tag === "NotFound" || model.doc.failure.tag === "Forbidden";
    return h.div(
      [h.Class("kb-error-shell")],
      [
        card(
          h,
          [
            h.div(
              [h.Class("kb-row")],
              [
                icon(h, "alert", 20),
                h.h1([], [gone ? t.t("share.view.gone.title") : t.t("common.state.error")]),
              ],
            ),
            h.p(
              [h.Class("kb-muted")],
              [gone ? t.t("share.view.gone.body") : failureMessage(t, model.doc.failure)],
            ),
            ...(!gone
              ? [
                  h.div(
                    [h.Class("kb-row")],
                    [
                      button(h, {
                        label: t.t("common.action.retry"),
                        onClick: Message.ClickedRetry(),
                        variant: "primary",
                      }),
                    ],
                  ),
                ]
              : []),
          ],
          [h.Class("kb-card kb-error-card")],
        ),
      ],
    );
  }

  const doc = model.doc.data;
  const issuer = parseIssuer(doc.issuer);
  const contact = parseContact(doc.contact);
  const lines = doc.lines.map((raw, i) => ({ raw, parsed: parseLine(raw), key: `l-${i}` }));
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
  const todayIso = new Date().toISOString().slice(0, 10);
  const isOverdue =
    doc.status === "issued" &&
    (doc.settlement === "unpaid" || doc.settlement === "partially_paid") &&
    doc.dates.dueOn < todayIso;
  const showPayBlock =
    doc.status === "issued" &&
    doc.kind !== "credit_note" &&
    (doc.settlement === "unpaid" || doc.settlement === "partially_paid");
  const vs = digitsOf(doc.number);
  const pdfHref = `${doc.pdfUrl}${doc.pdfUrl.includes("?") ? "&" : "?"}language=${model.pdfLanguage}`;
  const brandCss = scopedBrandCss(doc, ctx.prefs.style);

  return h.div(
    [
      h.Class(brandCss !== null ? "kb-share-wrap kb-share-themed" : "kb-share-wrap"),
      ...(brandCss !== null ? [h.DataAttribute("branded", "1")] : []),
    ],
    [
      ...(brandCss !== null ? [h.style([h.Id("kb-share-brand-theme")], [brandCss])] : []),
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
      h.article(
        [h.Class("kb-share-paper")],
        [
          h.header(
            [h.Class("kb-share-hero")],
            [
              h.div(
                [h.Class("kb-stack"), h.Style({ "--kb-gap": "6px" })],
                [
                  h.div(
                    [h.Class("kb-row")],
                    [
                      h.h1([], [t.t("share.view.title", { kind: kindLabel, number: doc.number })]),
                      badge(h, settlementLabel, settlementTone(doc.settlement)),
                      ...(doc.status !== "issued"
                        ? [badge(h, statusLabel, statusTone(doc.status))]
                        : []),
                      ...(isOverdue ? [badge(h, local(ctx.locale, "overdue"), "overdue")] : []),
                    ],
                  ),
                  ...(issuer !== undefined
                    ? [
                        h.p(
                          [h.Class("kb-muted")],
                          [t.t("share.view.from", { issuer: issuer.name })],
                        ),
                      ]
                    : []),
                  h.div(
                    [h.Class("kb-row kb-small kb-muted")],
                    [
                      h.span(
                        [],
                        [
                          t.t("share.view.issuedOn", {
                            date: Format.formatDate(ctx.locale, doc.dates.issuedOn),
                          }),
                        ],
                      ),
                      ...(doc.dates.taxableSupplyOn !== null
                        ? [
                            h.span(
                              [],
                              [
                                `${local(ctx.locale, "taxableSupply")}: ${Format.formatDate(ctx.locale, doc.dates.taxableSupplyOn)}`,
                              ],
                            ),
                          ]
                        : []),
                      h.span(
                        [],
                        [
                          t.t("share.view.dueOn", {
                            date: Format.formatDate(ctx.locale, doc.dates.dueOn),
                          }),
                        ],
                      ),
                    ],
                  ),
                  ...(doc.updatedAt !== null
                    ? [
                        h.span(
                          [h.Class("kb-footnote")],
                          [
                            local(ctx.locale, "updatedOn", {
                              date: Format.formatDate(ctx.locale, doc.updatedAt.slice(0, 10)),
                            }),
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
              h.div(
                [h.Class("kb-share-due")],
                [
                  h.span([h.Class("kb-small kb-muted")], [t.t("share.view.amountDue")]),
                  h.span([h.Class("kb-share-due__amount kb-num")], [amountDueDisplay.text]),
                  h.div(
                    [h.Class("kb-row"), h.Style({ marginTop: "6px" })],
                    [
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
                      h.a(
                        [h.Class("kb-btn kb-btn--primary kb-btn--small"), h.Href(pdfHref)],
                        [icon(h, "download", 16), t.t("common.action.downloadPdf")],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          ...(showPayBlock
            ? [
                h.section(
                  [h.Class("kb-share-pay"), h.AriaLabel(t.t("share.view.bankDetails"))],
                  [
                    ...(doc.paymentQr !== null
                      ? [
                          h.div(
                            [
                              h.Class("kb-stack"),
                              h.Style({ alignItems: "center", "--kb-gap": "6px" }),
                            ],
                            [
                              paymentQrView(
                                h,
                                doc.paymentQr.payload,
                                t.translate(I18n.enumText("qrFormat", doc.paymentQr.format)),
                              ),
                              h.span(
                                [h.Class("kb-small")],
                                [t.translate(I18n.enumText("qrFormat", doc.paymentQr.format))],
                              ),
                              h.span([h.Class("kb-footnote")], [t.t("share.view.scanHint")]),
                            ],
                          ),
                        ]
                      : [h.empty]),
                    h.div(
                      [h.Class("kb-stack")],
                      [
                        h.h2([], [t.t("share.view.bankDetails")]),
                        dl(h, [
                          ...(issuer?.bankAccount?.accountNumber
                            ? [
                                [
                                  local(ctx.locale, "account"),
                                  mono(h, issuer.bankAccount.accountNumber),
                                ] as const,
                              ]
                            : []),
                          ...(issuer?.bankAccount?.iban
                            ? [
                                [
                                  t.t("common.field.iban"),
                                  mono(h, Format.formatIban(issuer.bankAccount.iban)),
                                ] as const,
                              ]
                            : []),
                          ...(issuer?.bankAccount?.bic
                            ? [[t.t("common.field.bic"), mono(h, issuer.bankAccount.bic)] as const]
                            : []),
                          ...(vs !== ""
                            ? [[t.t("common.field.variableSymbol"), mono(h, vs)] as const]
                            : []),
                          [t.t("share.view.amountDue"), amount(h, amountDueDisplay.text)],
                        ]),
                        h.div(
                          [h.Class("kb-row")],
                          [
                            ...(issuer?.bankAccount?.iban
                              ? [
                                  button(h, {
                                    label: t.t("share.view.copyIban"),
                                    onClick: Message.ClickedCopy({
                                      value: issuer.bankAccount.iban,
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
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ]
            : []),
          h.section(
            [h.Class("kb-share-parties")],
            [
              h.div(
                [h.Class("kb-stack"), h.Style({ "--kb-gap": "4px" })],
                [
                  h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "issuer")]),
                  h.strong([], [issuer?.name ?? ""]),
                  ...(issuer?.address !== undefined
                    ? [h.span([h.Class("kb-small")], [formatAddressLine(issuer.address)])]
                    : []),
                  ...(issuer?.ico
                    ? [h.span([h.Class("kb-small kb-muted")], [`IČO: ${issuer.ico}`])]
                    : []),
                  ...(issuer?.dic
                    ? [h.span([h.Class("kb-small kb-muted")], [`DIČ: ${issuer.dic}`])]
                    : []),
                  ...(issuer?.registerEntry
                    ? [h.span([h.Class("kb-footnote")], [issuer.registerEntry])]
                    : []),
                ],
              ),
              h.div(
                [h.Class("kb-stack"), h.Style({ "--kb-gap": "4px" })],
                [
                  h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "buyer")]),
                  h.strong([], [contact?.name ?? ""]),
                  ...(contact?.address !== undefined
                    ? [h.span([h.Class("kb-small")], [formatAddressLine(contact.address)])]
                    : []),
                  ...(contact?.ico
                    ? [h.span([h.Class("kb-small kb-muted")], [`IČO: ${contact.ico}`])]
                    : []),
                  ...(contact?.dic
                    ? [h.span([h.Class("kb-small kb-muted")], [`DIČ: ${contact.dic}`])]
                    : []),
                ],
              ),
            ],
          ),
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
                    ? Format.formatQuantity(
                        ctx.locale,
                        r.parsed.quantity,
                        r.parsed.unit ?? undefined,
                      )
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
          h.div(
            [h.Class("kb-share-totals")],
            [
              h.div(
                [h.Class("kb-share-totals__row")],
                [
                  h.span([h.Class("kb-muted")], [t.t("common.field.subtotal")]),
                  amount(h, netDisplay.text),
                ],
              ),
              ...(doc.taxDocument
                ? [
                    h.div(
                      [h.Class("kb-share-totals__row")],
                      [
                        h.span([h.Class("kb-muted")], [t.t("common.field.vat")]),
                        amount(h, vatDisplay.text),
                      ],
                    ),
                  ]
                : []),
              ...(doc.totals.vatCzk !== null
                ? [
                    h.div(
                      [h.Class("kb-share-totals__row kb-small")],
                      [
                        h.span([h.Class("kb-muted")], [local(ctx.locale, "vatCzk")]),
                        amount(
                          h,
                          Format.moneyDisplay(ctx.locale, {
                            amount: doc.totals.vatCzk.amount,
                            currency: doc.totals.vatCzk.currency,
                          }).text,
                        ),
                      ],
                    ),
                  ]
                : []),
              h.div(
                [h.Class("kb-share-totals__row kb-share-totals__grand")],
                [h.span([], [t.t("common.field.total")]), amount(h, grossDisplay.text)],
              ),
            ],
          ),
          ...(doc.note !== null || doc.statutoryNotes.length > 0 || doc.branding.footerText !== null
            ? [
                h.hr([h.Class("kb-divider")]),
                h.div(
                  [h.Class("kb-stack"), h.Style({ "--kb-gap": "6px" })],
                  [
                    ...(doc.note !== null ? [h.p([h.Class("kb-small")], [doc.note])] : []),
                    ...doc.statutoryNotes.map((n) => h.p([h.Class("kb-footnote")], [n.text])),
                    ...(doc.branding.footerText !== null
                      ? [h.p([h.Class("kb-footnote")], [doc.branding.footerText])]
                      : []),
                  ],
                ),
              ]
            : []),
        ],
      ),
      h.div(
        [h.Class("kb-share-powered")],
        [mark(h, 14), h.span([], [t.t("share.view.poweredBy")])],
      ),
    ],
  );
});
