import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 08 — Dashboard: KPIs, 12-month SVG cashflow chart, overdue/unpaid queue, recent activity,
 * quick actions, and onboarding checklist (CTAs pinned right per screens.md #08).
 */
import { DashboardView, type WorkspaceId } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
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
import { cn, ui } from "../../ui/styles";
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

export const Route = RouteCases.Dashboard;
export type Route = typeof Route.Type;

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
  route: Route,
  dashboard: Remote.remoteSchema(DashboardView),
  recent: DocumentSummaryData.pipe(Schema.Array, Remote.remoteSchema),
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
    Message,
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
    Message,
    "LoadRecentDocuments",
    (c) => c.documents.list({ params: { workspaceId }, query: { limit: 8 } }),
    (pageData): Message => Message.LoadedRecent({ seq, data: readSummaries(pageData.items) }),
    (failure): Message => Message.FailedRecent({ seq, failure }),
  );

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
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

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> =>
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

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (_model: Model, ctx: PageContext): string => txt(ctx.locale, "title");

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

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
    return h.p.class(cn(ui.muted, ui.small)).children([txt(locale, "cashflowEmpty")]);
  }
  const groups = Arr.map(points, (point) => ({
    label: Str.slice(5)(point.month),
    bars: [
      { value: toNumber(point.in.amount), tone: "primary" as const },
      { value: toNumber(point.out.amount), tone: "secondary" as const },
    ],
  }));

  return h.div
    .class(ui.stack)
    .children([
      barChart(h, txt(locale, "cashflowAria"), groups),
      h.div
        .class("flex items-center gap-4 text-[0.75rem] text-on-surface-variant")
        .children([
          h.span.children([
            h.span
              .class("mr-1.5 inline-block h-2.5 w-2.5 rounded-badge bg-primary align-middle")
              .children([]),
            txt(locale, "cashflowIn"),
          ]),
          h.span.children([
            h.span
              .class("mr-1.5 inline-block h-2.5 w-2.5 rounded-badge bg-outline align-middle")
              .children([]),
            txt(locale, "cashflowOut"),
          ]),
        ]),
    ]);
};

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
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

  const dashKpisClass = "grid grid-cols-1 gap-3 min-[641px]:grid-cols-2 min-[1025px]:grid-cols-4";
  const kpiRow =
    dashData === undefined
      ? h.div
          .class(dashKpisClass)
          .attr("aria-busy", String(true))
          .children([
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
            card(h, [skeleton(h, "50%", "0.75rem"), skeleton(h, "75%", "1.5rem")]),
          ])
      : h.div.class(dashKpisClass).children([
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
            note:
              dashData.overdue.count > 0
                ? badge(
                    h,
                    txt(locale, "kpiOverdueCount", { count: dashData.overdue.count }),
                    "overdue",
                  )
                : undefined,
          }),
          kpi(h, {
            label: txt(locale, "kpiExpenses"),
            value: fmtMoney(locale, dashData.expenses),
            note:
              dashData.incompleteExpenses > 0
                ? badge(
                    h,
                    txt(locale, "kpiIncomplete", { count: dashData.incompleteExpenses }),
                    "proforma",
                  )
                : undefined,
          }),
        ]);

  const queueItems = Arr.filter(
    recentData ?? [],
    (d) =>
      d.status === "issued" &&
      (d.overdue || d.settlement === "unpaid" || d.settlement === "partially_paid"),
  );

  const hasIssuedDoc = Arr.some(recentData ?? [], (d) => d.status === "issued");

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
          h.ul.class("m-0 flex list-none flex-col p-0").children(
            Arr.map(
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
              ],
              (item) =>
                h.li
                  .class(
                    "flex items-center gap-3 border-b border-outline-variant py-2.5 last:border-b-0 last:pb-0",
                  )
                  .children([
                    h.span
                      .class(
                        cn(
                          "inline-flex h-5 w-5 flex-none items-center justify-center rounded-badge border",
                          item.done
                            ? "border-transparent bg-paid-container text-on-paid-container"
                            : "border-outline text-on-surface-variant",
                        ),
                      )
                      .children(item.done ? [icon(h, "check", 14)] : []),
                    h.div
                      .class("flex min-w-0 flex-1 flex-col gap-0.5")
                      .children([
                        h.strong.children([item.title]),
                        h.span.class(cn(ui.small, ui.muted)).children([item.sub]),
                      ]),
                    h.span
                      .class("ml-auto flex-none")
                      .attr("data-slot", "checklist-cta")
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
          .class(ui.stack)
          .attr("aria-busy", String(true))
          .children([
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
          ])
      : queueItems.length === 0
        ? emptyState(h, { title: txt(locale, "queueEmpty") })
        : h.ul.class("m-0 flex list-none flex-col p-0").children(
            Arr.map(queueItems.slice(0, 5), (doc) =>
              h.li
                .key(doc.id)
                .class(
                  "flex items-center justify-between gap-3 border-b border-outline-variant py-2.5 last:border-b-0 last:pb-0",
                )
                .children([
                  h.div.class("flex min-w-0 flex-col gap-0.5").children([
                    h.a
                      .class("font-medium no-underline hover:underline")
                      .attr(
                        "href",
                        href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
                      )
                      .children([doc.contact.name]),
                    h.div
                      .class(ui.row)
                      .children([
                        mono(h, doc.number ?? txt(locale, "draftLabel")),
                        h.span
                          .class(cn(ui.small, ui.muted, ui.num))
                          .children([
                            txt(locale, "dueLabel", { date: fmtDate(locale, doc.dueOn) }),
                          ]),
                      ]),
                  ]),
                  h.div
                    .class(ui.row)
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
          .class(ui.stack)
          .attr("aria-busy", String(true))
          .children([
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
            skeleton(h, "100%", "2rem"),
          ])
      : recentData.length === 0
        ? emptyState(h, {
            title: txt(locale, "recentEmpty"),
            action: canCreateDraft
              ? linkButton(h, {
                  label: txt(locale, "newInvoice"),
                  href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
                  variant: "primary",
                })
              : undefined,
          })
        : h.ul.class("m-0 flex list-none flex-col p-0").children(
            Arr.map(recentData.slice(0, 6), (doc) =>
              h.li
                .key(doc.id)
                .class(
                  "flex items-center justify-between gap-3 border-b border-outline-variant py-2.5 last:border-b-0 last:pb-0",
                )
                .children([
                  h.div.class("flex min-w-0 flex-col gap-0.5").children([
                    h.a
                      .class("font-medium no-underline hover:underline")
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
                      .class(ui.row)
                      .children([
                        kindBadge(h, locale, doc.kind),
                        h.span
                          .class(cn(ui.small, ui.muted, ui.num))
                          .children([fmtDate(locale, doc.issuedOn)]),
                      ]),
                  ]),
                  h.div
                    .class(ui.row)
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
      .class(
        "grid grid-cols-1 items-start gap-4 min-[1025px]:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]",
      )
      .children([
        h.div
          .class(ui.stack)
          .children([
            card(h, [
              cardTitle(h, txt(locale, "cashflowTitle")),
              dashData === undefined
                ? skeleton(h, "100%", "180px")
                : renderCashflowSvg(h, locale, dashData.cashflow),
            ]),
            recentCard,
          ]),
        h.div.class(ui.stack).children([queueCard, ...checklistCard]),
      ]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
