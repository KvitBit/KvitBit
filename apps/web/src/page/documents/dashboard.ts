import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 08 — Dashboard: KPIs, 12-month SVG cashflow chart, overdue/unpaid queue, recent activity,
 * quick actions, and onboarding checklist (CTAs pinned right per screens.md #08).
 */
import { DashboardView, type WorkspaceId } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Schema } from "effect";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { barChart } from "../../ui/bars";
import type { Markup } from "../../ui/html";
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
  canRole,
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

export const Message = UiSchema.TaggedEnum({
  LoadedDashboard: { seq: Remote.Seq, data: DashboardView },
  FailedDashboard: { seq: Remote.Seq, failure: Failure },
  LoadedRecent: { seq: Remote.Seq, data: Schema.Array(DocumentSummaryData) },
  FailedRecent: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  ClickedDismissChecklist: {},
});
export type Message = typeof Message.Type;

const loadDashboardCommand = (workspaceId: WorkspaceId, seq: Remote.Seq): PageCommand<Message> => {
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

const loadRecentCommand = (workspaceId: WorkspaceId, seq: Remote.Seq): PageCommand<Message> =>
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
  Message.match(message, {
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
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const title = (_model: Model, ctx: PageContext): string => txt(ctx.locale, "title");

const toNumber = (bd: BigDecimal.BigDecimal): number => {
  const n = Number(BigDecimal.format(bd));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

const renderCashflowSvg = (
  h: Html.H<Message>,
  locale: PageContext["locale"],
  points: DashboardView["cashflow"],
): Markup<Message> => {
  if (points.length === 0) {
    return h.p.class("kb-muted kb-small").children([txt(locale, "cashflowEmpty")]);
  }
  const groups = points.map((point) => ({
    label: point.month.slice(5),
    bars: [
      { value: toNumber(point.in.amount), tone: "primary" as const },
      { value: toNumber(point.out.amount), tone: "secondary" as const },
    ],
  }));

  return h.div
    .class("kb-stack")
    .children([
      barChart(h, txt(locale, "cashflowAria"), groups),
      h.div
        .class("kb-chart-legend")
        .children([
          h.span.children([
            h.span.class("kb-chart-dot kb-chart-dot--in").children([]),
            txt(locale, "cashflowIn"),
          ]),
          h.span.children([
            h.span.class("kb-chart-dot kb-chart-dot--out").children([]),
            txt(locale, "cashflowOut"),
          ]),
        ]),
    ]);
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const slug = ws.slug;
  const canCreateDraft = canRole(ws.role, "document.draft");
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
      ? h.div
          .class("kb-dash-kpis")
          .attr("aria-busy", String(true))
          .children([
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
          ])
      : h.div.class("kb-dash-kpis").children([
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
        ]);

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
          h.ul.class("kb-checklist").children(
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
              ...(canCreateDraft
                ? [
                    {
                      done: hasIssuedDoc,
                      title: txt(locale, "checkInvoice"),
                      sub: txt(locale, "checkInvoiceSub"),
                      cta: txt(locale, "checkInvoiceCta"),
                      to: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
                    },
                  ]
                : []),
              {
                done: false,
                title: txt(locale, "checkTemplate"),
                sub: txt(locale, "checkTemplateSub"),
                cta: txt(locale, "checkTemplateCta"),
                to: href({ _tag: "Templates", ws: slug }),
              },
            ].map((item) =>
              h.li
                .class("kb-checklist__row")
                .children([
                  h.span
                    .class(`kb-checklist__mark${item.done ? " kb-checklist__mark--done" : ""}`)
                    .children(item.done ? [icon(h, "check", 14)] : []),
                  h.div
                    .class("kb-checklist__text")
                    .children([
                      h.strong.children([item.title]),
                      h.span.class("kb-small kb-muted").children([item.sub]),
                    ]),
                  h.span
                    .class("kb-checklist__cta")
                    .children([linkButton(h, { label: item.cta, href: item.to, small: true })]),
                ]),
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
      ? h.div
          .class("kb-stack")
          .attr("aria-busy", String(true))
          .children([
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
          ])
      : queueItems.length === 0
        ? emptyState(h, { title: txt(locale, "queueEmpty") })
        : h.ul.class("kb-queue-list").children(
            queueItems.slice(0, 5).map((doc) =>
              h.li
                .key(doc.id)
                .class("kb-queue-item")
                .children([
                  h.div.class("kb-queue-item__meta").children([
                    h.a
                      .class("kb-queue-item__link")
                      .attr(
                        "href",
                        href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
                      )
                      .children([doc.contact.name]),
                    h.div
                      .class("kb-row")
                      .children([
                        mono(h, doc.number ?? txt(locale, "draftLabel")),
                        h.span
                          .class("kb-small kb-muted kb-num")
                          .children([
                            txt(locale, "dueLabel", { date: fmtDate(locale, doc.dueOn) }),
                          ]),
                      ]),
                  ]),
                  h.div
                    .class("kb-row")
                    .children([
                      ...documentBadges(h, locale, doc),
                      amount(h, fmtMoney(locale, doc.total)),
                    ]),
                ]),
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
      ? h.div
          .class("kb-stack")
          .attr("aria-busy", String(true))
          .children([
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
          ])
      : recentData.length === 0
        ? emptyState(h, {
            title: txt(locale, "recentEmpty"),
            ...(canCreateDraft
              ? {
                  action: linkButton(h, {
                    label: txt(locale, "newInvoice"),
                    href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
                    variant: "primary",
                  }),
                }
              : {}),
          })
        : h.ul.class("kb-queue-list").children(
            recentData.slice(0, 6).map((doc) =>
              h.li
                .key(doc.id)
                .class("kb-queue-item")
                .children([
                  h.div.class("kb-queue-item__meta").children([
                    h.a
                      .class("kb-queue-item__link")
                      .attr(
                        "href",
                        href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
                      )
                      .children([
                        doc.number !== null
                          ? `${doc.number} · ${doc.contact.name}`
                          : `${txt(locale, "draftLabel")} · ${doc.contact.name}`,
                      ]),
                    h.div
                      .class("kb-row")
                      .children([
                        kindBadge(h, locale, doc.kind),
                        h.span
                          .class("kb-small kb-muted kb-num")
                          .children([fmtDate(locale, doc.issuedOn)]),
                      ]),
                  ]),
                  h.div
                    .class("kb-row")
                    .children([
                      ...documentBadges(h, locale, doc),
                      amount(h, fmtMoney(locale, doc.total)),
                    ]),
                ]),
            ),
          ),
  ]);

  return page(h, [
    pageHeader(h, {
      title: txt(locale, "title"),
      subtitle: txt(locale, "subtitle"),
      actions: canCreateDraft
        ? [
            linkButton(h, {
              label: txt(locale, "newProforma"),
              href: href({ _tag: "DocumentNew", ws: slug, kind: "proforma" }),
            }),
            linkButton(h, {
              label: txt(locale, "newInvoice"),
              href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
              variant: "primary",
            }),
          ]
        : [],
    }),
    ...errorBanner,
    kpiRow,
    h.div
      .class("kb-dash-main")
      .children([
        h.div
          .class("kb-stack")
          .children([
            card(h, [
              cardTitle(h, txt(locale, "cashflowTitle")),
              dashData === undefined
                ? skeleton(h, "100%", "180px")
                : renderCashflowSvg(h, locale, dashData.cashflow),
            ]),
            recentCard,
          ]),
        h.div.class("kb-stack").children([queueCard, ...checklistCard]),
      ]),
  ]);
};
