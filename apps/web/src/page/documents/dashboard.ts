/**
 * Screen 08 — Dashboard: KPIs, 12-month SVG cashflow chart, overdue/unpaid queue, recent activity,
 * quick actions, and onboarding checklist (CTAs pinned right per screens.md #08).
 */
import { DashboardView, type WorkspaceId } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Schema } from "effect";
import { type Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Failure, type WebServices } from "../../app/api";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { icon } from "../../ui/icons";
import {
  amount,
  badge,
  banner,
  button,
  card,
  cardTitle,
  emptyState,
  kpi,
  linkButton,
  mono,
  page,
  pageHeader,
  skeleton,
} from "../../ui/kit";
import {
  apiCommand,
  DocumentSummaryData,
  documentBadges,
  fmtDate,
  fmtMoney,
  kindBadge,
  readSummaries,
  sharedCopy,
  todayPrague,
  yearPeriodOf,
} from "./shared";

export type Route = RouteOf<"Dashboard">;

const CopyTable: Copy<
  | "title"
  | "subtitle"
  | "newInvoice"
  | "newProforma"
  | "newTemplate"
  | "allDocuments"
  | "kpiRevenue"
  | "kpiUnpaid"
  | "kpiOverdue"
  | "kpiOverdueCount"
  | "kpiExpenses"
  | "kpiIncomplete"
  | "cashflowTitle"
  | "cashflowAria"
  | "cashflowIn"
  | "cashflowOut"
  | "cashflowEmpty"
  | "queueTitle"
  | "queueEmpty"
  | "recentTitle"
  | "recentEmpty"
  | "checklistTitle"
  | "checklistDismiss"
  | "checkEntity"
  | "checkEntitySub"
  | "checkEntityCta"
  | "checkBank"
  | "checkBankSub"
  | "checkBankCta"
  | "checkInvoice"
  | "checkInvoiceSub"
  | "checkInvoiceCta"
  | "checkTemplate"
  | "checkTemplateSub"
  | "checkTemplateCta"
  | "dueLabel"
  | "draftLabel"
> = {
  cs: {
    title: "Přehled",
    subtitle: "Souhrn fakturace, peněžních toků a dokladů k vyřízení",
    newInvoice: "Nová faktura",
    newProforma: "Nová zálohová faktura",
    newTemplate: "Nová šablona",
    allDocuments: "Všechny doklady",
    kpiRevenue: "Tržby za období",
    kpiUnpaid: "Neuhrazeno",
    kpiOverdue: "Po splatnosti",
    kpiOverdueCount: "{count} po splatnosti",
    kpiExpenses: "Náklady za období",
    kpiIncomplete: "{count} nedokončených",
    cashflowTitle: "Peněžní toky (12 měsíců)",
    cashflowAria: "Sloupcový graf příjmů a výdajů za posledních 12 měsíců",
    cashflowIn: "Příjmy",
    cashflowOut: "Výdaje",
    cashflowEmpty: "Zatím žádná data peněžních toků.",
    queueTitle: "K úhradě a po splatnosti",
    queueEmpty: "Žádné neuhrazené doklady.",
    recentTitle: "Poslední doklady",
    recentEmpty: "Zatím jste nevystavili žádný doklad.",
    checklistTitle: "Nastavení pracovního prostoru",
    checklistDismiss: "Skrýt",
    checkEntity: "Údaje vystavitele",
    checkEntitySub: "Zkontrolujte IČO, DIČ a zápis v rejstříku",
    checkEntityCta: "Upravit",
    checkBank: "Bankovní účet",
    checkBankSub: "Přidejte účet pro QR platbu na fakturách",
    checkBankCta: "Nastavit",
    checkInvoice: "První faktura",
    checkInvoiceSub: "Vystavte první fakturu nebo zálohu",
    checkInvoiceCta: "Vystavit",
    checkTemplate: "Šablony a pravidelná fakturace",
    checkTemplateSub: "Uložte opakované faktury jako šablonu",
    checkTemplateCta: "Otevřít",
    dueLabel: "Splatnost {date}",
    draftLabel: "Koncept",
  },
  en: {
    title: "Dashboard",
    subtitle: "Summary of invoicing, cashflow, and items needing attention",
    newInvoice: "New invoice",
    newProforma: "New proforma",
    newTemplate: "New template",
    allDocuments: "All documents",
    kpiRevenue: "Revenue (period)",
    kpiUnpaid: "Unpaid",
    kpiOverdue: "Overdue",
    kpiOverdueCount: "{count} overdue",
    kpiExpenses: "Expenses (period)",
    kpiIncomplete: "{count} incomplete",
    cashflowTitle: "Cashflow (12 months)",
    cashflowAria: "Bar chart of incoming and outgoing cashflow over the last 12 months",
    cashflowIn: "Incoming",
    cashflowOut: "Outgoing",
    cashflowEmpty: "No cashflow data yet.",
    queueTitle: "Unpaid and overdue",
    queueEmpty: "No unpaid documents.",
    recentTitle: "Recent documents",
    recentEmpty: "No documents issued yet.",
    checklistTitle: "Workspace setup",
    checklistDismiss: "Hide",
    checkEntity: "Issuing entity details",
    checkEntitySub: "Verify IČO, DIČ, and commercial register line",
    checkEntityCta: "Review",
    checkBank: "Bank account",
    checkBankSub: "Add an account for payment QR codes on invoices",
    checkBankCta: "Configure",
    checkInvoice: "First invoice",
    checkInvoiceSub: "Issue your first invoice or proforma",
    checkInvoiceCta: "Create",
    checkTemplate: "Templates and recurring",
    checkTemplateSub: "Save recurring invoices as templates",
    checkTemplateCta: "Open",
    dueLabel: "Due {date}",
    draftLabel: "Draft",
  },
};

const txt = copy(CopyTable);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  dashboard: Remote.remoteSchema(DashboardView),
  recent: Remote.remoteSchema(Schema.Array(DocumentSummaryData)),
  checklistHidden: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  LoadedDashboard: { seq: Remote.Seq, data: DashboardView },
  FailedDashboard: { seq: Remote.Seq, failure: Failure },
  LoadedRecent: { seq: Remote.Seq, data: Schema.Array(DocumentSummaryData) },
  FailedRecent: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  ClickedDismissChecklist: {},
});
export type Message = typeof Message.Type;

const loadDashboardCommand = (
  workspaceId: WorkspaceId,
  seq: Remote.Seq,
): Command.Command<Message, never, WebServices> => {
  const period = yearPeriodOf(todayPrague());
  return apiCommand(
    "LoadDashboard",
    (c) =>
      c.reports.dashboard({
        params: { workspaceId },
        query: { from: period.from, to: period.to },
      }),
    (data): Message => Message.LoadedDashboard({ seq, data }),
    (failure): Message => Message.FailedDashboard({ seq, failure }),
  );
};

const loadRecentCommand = (
  workspaceId: WorkspaceId,
  seq: Remote.Seq,
): Command.Command<Message, never, WebServices> =>
  apiCommand(
    "LoadRecentDocuments",
    (c) => c.documents.list({ params: { workspaceId }, query: { limit: 8 } }),
    (pageData): Message => Message.LoadedRecent({ seq, data: readSummaries(pageData.items) }),
    (failure): Message => Message.FailedRecent({ seq, failure }),
  );

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  if (ws === null) {
    return {
      model: {
        route,
        dashboard: Remote.idle,
        recent: Remote.idle,
        checklistHidden: false,
      },
    };
  }
  const dashboard = Remote.load(Remote.idle);
  const recent = Remote.load(Remote.idle);
  return {
    model: { route, dashboard, recent, checklistHidden: false },
    commands: [
      loadDashboardCommand(ws.id, Remote.seqOf(dashboard)),
      loadRecentCommand(ws.id, Remote.seqOf(recent)),
    ],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
    LoadedDashboard: ({ seq, data }) => ({
      model: { ...model, dashboard: Remote.succeed(model.dashboard, seq, data) },
    }),
    FailedDashboard: ({ seq, failure }) => ({
      model: { ...model, dashboard: Remote.fail(model.dashboard, seq, failure) },
    }),
    LoadedRecent: ({ seq, data }) => ({
      model: { ...model, recent: Remote.succeed(model.recent, seq, data) },
    }),
    FailedRecent: ({ seq, failure }) => ({
      model: { ...model, recent: Remote.fail(model.recent, seq, failure) },
    }),
    ClickedRetry: () => {
      const ws = ctx.workspace;
      if (ws === null) return { model };
      const dashboard = Remote.load(model.dashboard);
      const recent = Remote.load(model.recent);
      return {
        model: { ...model, dashboard, recent },
        commands: [
          loadDashboardCommand(ws.id, Remote.seqOf(dashboard)),
          loadRecentCommand(ws.id, Remote.seqOf(recent)),
        ],
      };
    },
    ClickedDismissChecklist: () => ({
      model: { ...model, checklistHidden: true },
    }),
  });

export const title = (_model: Model, ctx: PageContext): string => txt(ctx.locale, "title");

const toNumber = (bd: BigDecimal.BigDecimal): number => {
  const n = Number(BigDecimal.format(bd));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

const renderCashflowSvg = (
  h: HtmlBuilder<Message>,
  locale: PageContext["locale"],
  points: DashboardView["cashflow"],
): Html => {
  if (points.length === 0) {
    return h.p([h.Class("kb-muted kb-small")], [txt(locale, "cashflowEmpty")]);
  }
  const width = 560;
  const height = 180;
  const padLeft = 12;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const maxVal = Math.max(
    1,
    ...points.flatMap((p) => [toNumber(p.in.amount), toNumber(p.out.amount)]),
  );
  const slotW = chartW / points.length;
  const barW = Math.max(6, Math.min(16, slotW * 0.34));

  const gridLines = [0, 0.5, 1].map((ratio) => {
    const y = Math.round(padTop + chartH * (1 - ratio));
    return `<line class="kb-chart-grid-line" x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" />`;
  });

  const bars = points
    .map((p, idx) => {
      const xCenter = padLeft + slotW * idx + slotW / 2;
      const inH = Math.round((toNumber(p.in.amount) / maxVal) * chartH);
      const outH = Math.round((toNumber(p.out.amount) / maxVal) * chartH);
      const inY = padTop + chartH - inH;
      const outY = padTop + chartH - outH;
      const label = p.month.slice(5);
      return [
        `<rect class="kb-chart-bar-in" x="${(xCenter - barW - 1).toFixed(1)}" y="${inY}" width="${barW.toFixed(1)}" height="${inH}" rx="2" />`,
        `<rect class="kb-chart-bar-out" x="${(xCenter + 1).toFixed(1)}" y="${outY}" width="${barW.toFixed(1)}" height="${outH}" rx="2" />`,
        `<text class="kb-chart-axis-label" x="${xCenter.toFixed(1)}" y="${height - 6}" text-anchor="middle">${label}</text>`,
      ].join("");
    })
    .join("");

  const svg = `<svg class="kb-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${txt(locale, "cashflowAria")}">${gridLines.join("")}${bars}</svg>`;

  return h.div(
    [h.Class("kb-stack")],
    [
      h.div([h.Class("kb-chart-wrap"), h.InnerHTML(svg)], []),
      h.div(
        [h.Class("kb-chart-legend")],
        [
          h.span(
            [],
            [h.span([h.Class("kb-chart-dot kb-chart-dot--in")], []), txt(locale, "cashflowIn")],
          ),
          h.span(
            [],
            [h.span([h.Class("kb-chart-dot kb-chart-dot--out")], []), txt(locale, "cashflowOut")],
          ),
        ],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const slug = ws.slug;
  const dashData = Remote.dataOf(model.dashboard);
  const recentData = Remote.dataOf(model.recent);

  const errorBanner =
    model.dashboard._tag === "Failed"
      ? [
          banner(h, {
            text: textOf(t, model.dashboard.failure.text),
            tone: "error",
            action: button(h, {
              label: sharedCopy(locale, "retry"),
              onClick: Message.ClickedRetry(),
              small: true,
            }),
          }),
        ]
      : [];

  const kpiRow =
    dashData === undefined
      ? h.div(
          [h.Class("kb-dash-kpis"), h.AriaBusy(true)],
          [
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
          ],
        )
      : h.div(
          [h.Class("kb-dash-kpis")],
          [
            kpi(h, {
              label: txt(locale, "kpiRevenue"),
              value: fmtMoney(locale, dashData.revenue),
            }),
            kpi(h, {
              label: txt(locale, "kpiUnpaid"),
              value: fmtMoney(locale, dashData.unpaid),
            }),
            kpi(h, {
              label: txt(locale, "kpiOverdue"),
              value: fmtMoney(locale, dashData.overdue.total),
              ...(dashData.overdue.count > 0
                ? {
                    note: badge(
                      h,
                      txt(locale, "kpiOverdueCount", { count: dashData.overdue.count }),
                      "overdue",
                    ),
                  }
                : {}),
            }),
            kpi(h, {
              label: txt(locale, "kpiExpenses"),
              value: fmtMoney(locale, dashData.expenses),
              ...(dashData.incompleteExpenses > 0
                ? {
                    note: badge(
                      h,
                      txt(locale, "kpiIncomplete", { count: dashData.incompleteExpenses }),
                      "proforma",
                    ),
                  }
                : {}),
            }),
          ],
        );

  const queueItems = (recentData ?? []).filter(
    (d) =>
      d.status === "issued" &&
      (d.overdue || d.settlement === "unpaid" || d.settlement === "partially_paid"),
  );

  const hasIssuedDoc = (recentData ?? []).some((d) => d.status === "issued");

  const checklistCard = model.checklistHidden
    ? []
    : [
        card(h, [
          cardTitle(h, txt(locale, "checklistTitle"), [
            button(h, {
              label: txt(locale, "checklistDismiss"),
              onClick: Message.ClickedDismissChecklist(),
              variant: "ghost",
              small: true,
            }),
          ]),
          h.ul(
            [h.Class("kb-checklist")],
            [
              {
                done: true,
                title: txt(locale, "checkEntity"),
                sub: txt(locale, "checkEntitySub"),
                cta: txt(locale, "checkEntityCta"),
                to: href({ _tag: "Settings", ws: slug, section: "issuingEntity" }),
              },
              {
                done: true,
                title: txt(locale, "checkBank"),
                sub: txt(locale, "checkBankSub"),
                cta: txt(locale, "checkBankCta"),
                to: href({ _tag: "Settings", ws: slug, section: "bankAccounts" }),
              },
              {
                done: hasIssuedDoc,
                title: txt(locale, "checkInvoice"),
                sub: txt(locale, "checkInvoiceSub"),
                cta: txt(locale, "checkInvoiceCta"),
                to: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
              },
              {
                done: false,
                title: txt(locale, "checkTemplate"),
                sub: txt(locale, "checkTemplateSub"),
                cta: txt(locale, "checkTemplateCta"),
                to: href({ _tag: "Templates", ws: slug }),
              },
            ].map((item) =>
              h.li(
                [h.Class("kb-checklist__row")],
                [
                  h.span(
                    [h.Class(`kb-checklist__mark${item.done ? " kb-checklist__mark--done" : ""}`)],
                    item.done ? [icon(h, "check", 14)] : [],
                  ),
                  h.div(
                    [h.Class("kb-checklist__text")],
                    [
                      h.strong([], [item.title]),
                      h.span([h.Class("kb-small kb-muted")], [item.sub]),
                    ],
                  ),
                  h.span(
                    [h.Class("kb-checklist__cta")],
                    [linkButton(h, { label: item.cta, href: item.to, small: true })],
                  ),
                ],
              ),
            ),
          ),
        ]),
      ];

  const queueCard = card(h, [
    cardTitle(h, txt(locale, "queueTitle"), [
      linkButton(h, {
        label: txt(locale, "allDocuments"),
        href: href({ _tag: "Documents", ws: slug, query: { overdue: true } }),
        variant: "ghost",
        small: true,
      }),
    ]),
    recentData === undefined
      ? h.div(
          [h.Class("kb-stack"), h.AriaBusy(true)],
          [skeleton(h, "100%", "2rem"), skeleton(h, "100%", "2rem"), skeleton(h, "100%", "2rem")],
        )
      : queueItems.length === 0
        ? emptyState(h, { title: txt(locale, "queueEmpty") })
        : h.ul(
            [h.Class("kb-queue-list")],
            queueItems
              .slice(0, 5)
              .map((doc) =>
                h.keyed("li")(
                  doc.id,
                  [h.Class("kb-queue-item")],
                  [
                    h.div(
                      [h.Class("kb-queue-item__meta")],
                      [
                        h.a(
                          [
                            h.Class("kb-queue-item__link"),
                            h.Href(
                              href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
                            ),
                          ],
                          [doc.contact.name],
                        ),
                        h.div(
                          [h.Class("kb-row")],
                          [
                            mono(h, doc.number ?? txt(locale, "draftLabel")),
                            h.span(
                              [h.Class("kb-small kb-muted kb-num")],
                              [txt(locale, "dueLabel", { date: fmtDate(locale, doc.dueOn) })],
                            ),
                          ],
                        ),
                      ],
                    ),
                    h.div(
                      [h.Class("kb-row")],
                      [...documentBadges(h, locale, doc), amount(h, fmtMoney(locale, doc.total))],
                    ),
                  ],
                ),
              ),
          ),
  ]);

  const recentCard = card(h, [
    cardTitle(h, txt(locale, "recentTitle"), [
      linkButton(h, {
        label: txt(locale, "allDocuments"),
        href: href({ _tag: "Documents", ws: slug, query: {} }),
        variant: "ghost",
        small: true,
      }),
    ]),
    recentData === undefined
      ? h.div(
          [h.Class("kb-stack"), h.AriaBusy(true)],
          [skeleton(h, "100%", "2rem"), skeleton(h, "100%", "2rem"), skeleton(h, "100%", "2rem")],
        )
      : recentData.length === 0
        ? emptyState(h, {
            title: txt(locale, "recentEmpty"),
            action: linkButton(h, {
              label: txt(locale, "newInvoice"),
              href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
              variant: "primary",
            }),
          })
        : h.ul(
            [h.Class("kb-queue-list")],
            recentData
              .slice(0, 6)
              .map((doc) =>
                h.keyed("li")(
                  doc.id,
                  [h.Class("kb-queue-item")],
                  [
                    h.div(
                      [h.Class("kb-queue-item__meta")],
                      [
                        h.a(
                          [
                            h.Class("kb-queue-item__link"),
                            h.Href(
                              href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
                            ),
                          ],
                          [
                            doc.number !== null
                              ? `${doc.number} · ${doc.contact.name}`
                              : `${txt(locale, "draftLabel")} · ${doc.contact.name}`,
                          ],
                        ),
                        h.div(
                          [h.Class("kb-row")],
                          [
                            kindBadge(h, locale, doc.kind),
                            h.span(
                              [h.Class("kb-small kb-muted kb-num")],
                              [fmtDate(locale, doc.issuedOn)],
                            ),
                          ],
                        ),
                      ],
                    ),
                    h.div(
                      [h.Class("kb-row")],
                      [...documentBadges(h, locale, doc), amount(h, fmtMoney(locale, doc.total))],
                    ),
                  ],
                ),
              ),
          ),
  ]);

  return page(h, [
    pageHeader(h, {
      title: txt(locale, "title"),
      subtitle: txt(locale, "subtitle"),
      actions: [
        linkButton(h, {
          label: txt(locale, "newProforma"),
          href: href({ _tag: "DocumentNew", ws: slug, kind: "proforma" }),
        }),
        linkButton(h, {
          label: txt(locale, "newInvoice"),
          href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
          variant: "primary",
        }),
      ],
    }),
    ...errorBanner,
    kpiRow,
    h.div(
      [h.Class("kb-dash-main")],
      [
        h.div(
          [h.Class("kb-stack")],
          [
            card(h, [
              cardTitle(h, txt(locale, "cashflowTitle")),
              dashData === undefined
                ? skeleton(h, "100%", "180px")
                : renderCashflowSvg(h, locale, dashData.cashflow),
            ]),
            recentCard,
          ],
        ),
        h.div([h.Class("kb-stack")], [queueCard, ...checklistCard]),
      ],
    ),
  ]);
});
