import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Reports Suite screen (Screen 17, route `Reports`).
 * Tabs: Revenue, Expenses, Cashflow, Receivables, VAT Summary (+ non-VAT payer turnover threshold
 * hint), period selector, group-by switch, inline SVG charts & tabular summary tables, Export
 * dialog (CSV / PDF).
 */
import type { ReportKind, VatTreatment, WorkspaceId } from "@kvitbit/domain/contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Failure, request } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { barChart } from "../../ui/bars";
import type { Markup } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  dialog,
  emptyState,
  kpi,
  linkButton,
  mono,
  page,
  pageHeader,
  segmented,
  select,
  skeleton,
  skeletonTable,
  table,
  tabs,
} from "../../ui/kit";
import {
  apiCommand,
  type CashflowReportRecord,
  downloadUrlCommand,
  type ExpensesReportRecord,
  enumLabel,
  moneyText,
  normalizeReport,
  type ProfitReportRecord,
  parseUserDecimal,
  periodOptions,
  periodToRange,
  type ReceivablesReportRecord,
  ReportDataRecord,
  type RevenueReportRecord,
  type VatSummaryReportRecord,
} from "./shared";

export type Route = RouteOf<"Reports">;

const REPORT_TABS: ReadonlyArray<ReportKind> = [
  "revenue",
  "expenses",
  "cashflow",
  "receivables",
  "vat_summary",
];

const TURNOVER_THRESHOLD_CZK = 2_000_000;

const tLocal = copy({
  cs: {
    subtitle: "Všechny částky jsou přepočteny do CZK kurzem ČNB platným k datu dokladu.",
    net: "Základ",
    vat: "DPH",
    gross: "Celkem",
    count: "Počet",
    original: "Původní měna",
    groupCol: "Skupina",
    monthCol: "Měsíc",
    docCol: "Doklad",
    customerCol: "Odběratel",
    agingCol: "Prodlení",
    dueCol: "K úhradě",
    dueCzkCol: "K úhradě (CZK)",
    notDue: "Před splatností",
    aging_not_due: "Před splatností",
    aging_1_30: "1–30 dnů",
    aging_31_60: "31–60 dnů",
    aging_61_90: "61–90 dnů",
    aging_over_90: "Nad 90 dnů",
    remind: "Upomínka",
    pay: "Uhradit",
    vatOutputTitle: "DPH na výstupu",
    vatInputTitle: "DPH na vstupu",
    vatRateCol: "Sazba / režim",
    vatBaseCol: "Základ (CZK)",
    vatTaxCol: "DPH (CZK)",
    vatSourcesCol: "Doklady",
    incompleteNotice: "Neúplné náklady ({count}) nejsou zahrnuty ve výpočtu.",
    thresholdTitle: "Sledování obratu pro registraci k DPH",
    thresholdNote:
      "Prostor je v režimu neplátce DPH. Zákonný limit obratu za kalendářní rok je 2 000 000 Kč.",
    exportDesc: "Stáhne aktuálně zobrazený přehled za období {period} ve zvoleném formátu.",
    exportDone: "Export stažen.",
    chartTitleRevenue: "Vývoj tržeb",
    chartTitleExpenses: "Vývoj nákladů",
    chartTitleCashflow: "Peněžní tok podle měsíců",
    chartTitleReceivables: "Stáří pohledávek",
    chartTitleVat: "Výstupní vs. vstupní DPH",
    revenueCountNote: "{count} dokladů",
    expensesCountNote: "{count} nákladů",
  },
  en: {
    subtitle: "All amounts are converted to CZK using each document's stored CNB exchange rate.",
    net: "Net",
    vat: "VAT",
    gross: "Gross",
    count: "Count",
    original: "Original currency",
    groupCol: "Group",
    monthCol: "Month",
    docCol: "Document",
    customerCol: "Customer",
    agingCol: "Aging",
    dueCol: "Outstanding",
    dueCzkCol: "Outstanding (CZK)",
    notDue: "Not due",
    aging_not_due: "Not due",
    aging_1_30: "1–30 days",
    aging_31_60: "31–60 days",
    aging_61_90: "61–90 days",
    aging_over_90: "Over 90 days",
    remind: "Remind",
    pay: "Record payment",
    vatOutputTitle: "Output VAT",
    vatInputTitle: "Input VAT",
    vatRateCol: "Rate / treatment",
    vatBaseCol: "Base (CZK)",
    vatTaxCol: "VAT (CZK)",
    vatSourcesCol: "Sources",
    incompleteNotice: "{count} incomplete expenses are excluded from totals.",
    thresholdTitle: "VAT registration turnover threshold",
    thresholdNote:
      "Workspace is a non-VAT payer. The statutory Czech annual turnover limit is CZK 2,000,000.",
    exportDesc: "Downloads the current report for period {period} in the selected format.",
    exportDone: "Export downloaded.",
    chartTitleRevenue: "Revenue trend",
    chartTitleExpenses: "Expenses trend",
    chartTitleCashflow: "Monthly cashflow",
    chartTitleReceivables: "Receivables aging",
    chartTitleVat: "Output vs. input VAT",
    revenueCountNote: "{count} documents",
    expensesCountNote: "{count} expenses",
  },
});

const GroupByLiteral = Schema.Literals(["month", "contact", "currency", "category"]);
type GroupByLiteral = typeof GroupByLiteral.Type;

const ExportFormatLiteral = Schema.Literals(["csv", "pdf"]);
type ExportFormatLiteral = typeof ExportFormatLiteral.Type;

export const Model = Schema.Struct({
  route: ViewModels.Route,
  groupBy: GroupByLiteral,
  data: Remote.remoteSchema(ReportDataRecord),
  exportOpen: Schema.Boolean,
  exportFormat: ExportFormatLiteral,
  exporting: Schema.Boolean,
  exportError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  LoadedReport: { seq: Schema.Int, report: ReportDataRecord },
  FailedReport: { seq: Schema.Int, failure: Failure },
  ChangedPeriod: { period: Schema.String },
  ChangedGroupBy: { groupBy: GroupByLiteral },
  ClickedRetry: {},
  OpenedExport: {},
  ClosedExport: {},
  SelectedExportFormat: { format: ExportFormatLiteral },
  SubmittedExport: {},
  CompletedExport: {},
  FailedExport: { failure: Failure },
});
export type Message = typeof Message.Type;

const loadReportCommand = (
  workspaceId: string,
  report: ReportKind,
  period: ViewModels.Period,
  groupBy: GroupByLiteral,
  seq: number,
): PageCommand<Message> => {
  const { from, to } = periodToRange(period);
  const needsGroup = report === "revenue" || report === "expenses";
  const effectiveGroup = report === "revenue" && groupBy === "category" ? "month" : groupBy;
  return apiCommand(
    "ReportsRun",
    request(
      (client) =>
        client.reports.run({
          params: { workspaceId: workspaceId as WorkspaceId, report },
          query: {
            from,
            to,
            ...(needsGroup ? { groupBy: effectiveGroup } : {}),
          },
        }),
      (raw): Message => Message.LoadedReport({ seq, report: normalizeReport(raw, report) }),
      (failure): Message => Message.FailedReport({ seq, failure }),
    ),
  );
};

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const data = Remote.load<ReportDataRecord>(Remote.idle);
  const wsId = ctx.workspace?.id;
  return {
    model: {
      route,
      groupBy: "month",
      data,
      exportOpen: false,
      exportFormat: "csv",
      exporting: false,
      exportError: null,
    },
    commands:
      wsId === undefined
        ? []
        : [loadReportCommand(wsId, route.report, route.period, "month", Remote.seqOf(data))],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  const wsId = ctx.workspace?.id;

  return Message.match(message, {
    LoadedReport: ({ seq, report }) => ({
      model: { ...model, data: Remote.succeed(model.data, seq, report) },
    }),

    FailedReport: ({ seq, failure }) => ({
      model: { ...model, data: Remote.fail(model.data, seq, failure) },
    }),

    ChangedPeriod: ({ period }) => {
      const nextRoute: Route = {
        _tag: "Reports",
        ws: route.ws,
        report: route.report,
        period: period as ViewModels.Period,
      };
      return {
        model,
        outMessage: Intent_.navigate(href(nextRoute), false),
      };
    },

    ChangedGroupBy: ({ groupBy }) => {
      const nextData = Remote.load(model.data);
      return {
        model: { ...model, groupBy, data: nextData },
        commands:
          wsId === undefined
            ? []
            : [
                loadReportCommand(
                  wsId,
                  route.report,
                  route.period,
                  groupBy,
                  Remote.seqOf(nextData),
                ),
              ],
      };
    },

    ClickedRetry: () => {
      const nextData = Remote.load(model.data);
      return {
        model: { ...model, data: nextData },
        commands:
          wsId === undefined
            ? []
            : [
                loadReportCommand(
                  wsId,
                  route.report,
                  route.period,
                  model.groupBy,
                  Remote.seqOf(nextData),
                ),
              ],
      };
    },

    OpenedExport: () => ({
      model: { ...model, exportOpen: true, exportError: null },
    }),

    ClosedExport: () => ({
      model: { ...model, exportOpen: false, exporting: false, exportError: null },
    }),

    SelectedExportFormat: ({ format }) => ({
      model: { ...model, exportFormat: format, exportError: null },
    }),

    SubmittedExport: () => {
      if (wsId === undefined || model.exporting) return { model };
      const { from, to } = periodToRange(route.period);
      const query = new URLSearchParams({
        format: model.exportFormat,
        from,
        to,
        ...(route.report === "revenue" || route.report === "expenses"
          ? { groupBy: model.groupBy }
          : {}),
      });
      const path = `/api/v1/workspaces/${encodeURIComponent(wsId)}/reports/${encodeURIComponent(route.report)}/export?${query.toString()}`;
      const filename = `kvitbit-${route.report}-${route.period}.${model.exportFormat}`;
      return {
        model: { ...model, exporting: true, exportError: null },
        commands: [
          downloadUrlCommand(
            "ReportsExport",
            path,
            filename,
            () => Message.CompletedExport(),
            (failure) => Message.FailedExport({ failure }),
          ),
        ],
      };
    },

    CompletedExport: () => ({
      model: { ...model, exporting: false, exportOpen: false },
      outMessage: Intent_.toast(tLocal(ctx.locale, "exportDone"), "info"),
    }),

    FailedExport: ({ failure }) => ({
      model: { ...model, exporting: false, exportError: textOf(tr, failure.text) },
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

export const title = (model: Model, ctx: PageContext): string => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  return `${tr.t("reports.suite.title")} · ${enumLabel(tr, "reportKind", route.report)}`;
};

// --- Report charts ------------------------

export const reportBarChart = (
  h: Html.H<Message>,
  chartTitle: string,
  items: ReadonlyArray<{
    readonly label: string;
    readonly value: number;
    readonly secondary?: number;
    readonly tone?: "primary" | "secondary" | "overdue";
  }>,
  legend?: ReadonlyArray<{ readonly label: string; readonly cls: string }>,
): Markup<Message> => {
  const groups = items.map((item) => ({
    label: item.label,
    bars: [
      {
        value: item.value,
        tone:
          item.tone === "overdue" || item.tone === "secondary" ? item.tone : ("primary" as const),
      },
      ...(item.secondary === undefined
        ? []
        : [{ value: item.secondary, tone: "secondary" as const }]),
    ],
  }));

  return card(h, [
    h.div
      .class("kb-chart-card")
      .children([
        h.div
          .class("kb-spread")
          .children([
            h.h2.children([chartTitle]),
            ...(legend !== undefined && legend.length > 0
              ? [
                  h.div
                    .class("kb-chart-legend")
                    .children(
                      legend.map((l) =>
                        h.span
                          .class("kb-chart-legend__item")
                          .children([
                            h.span.class(`kb-chart-swatch ${l.cls}`).children([]),
                            l.label,
                          ]),
                      ),
                    ),
                ]
              : []),
          ]),
        barChart(h, chartTitle, groups),
      ]),
  ]);
};

// --- Per-report renderers ------------------------------------------------------------------------

const renderAmountReport = (
  h: Html.H<Message>,
  ctx: PageContext,
  data: RevenueReportRecord | ExpensesReportRecord,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  const isExpenses = data.report === "expenses";
  const kpis = h.div.class("kb-kpi-strip").children([
    kpi(h, {
      label: tLocal(ctx.locale, "net"),
      value: moneyText(ctx.locale, data.totals.net.amount, data.totals.net.currency),
    }),
    kpi(h, {
      label: tLocal(ctx.locale, "vat"),
      value: moneyText(ctx.locale, data.totals.vat.amount, data.totals.vat.currency),
    }),
    kpi(h, {
      label: tLocal(ctx.locale, "gross"),
      value: moneyText(ctx.locale, data.totals.gross.amount, data.totals.gross.currency),
      note: tLocal(ctx.locale, isExpenses ? "expensesCountNote" : "revenueCountNote", {
        count: data.totals.count,
      }),
    }),
  ]);

  const chart =
    data.rows.length === 0
      ? h.text("")
      : reportBarChart(
          h,
          tLocal(ctx.locale, isExpenses ? "chartTitleExpenses" : "chartTitleRevenue"),
          data.rows.slice(0, 12).map((r) => ({
            label: r.label ?? r.key,
            value: parseUserDecimal(r.gross.amount) ?? 0,
            tone: isExpenses ? "secondary" : "primary",
          })),
        );

  const tableEl =
    data.rows.length === 0
      ? emptyState(h, { title: tr.t("reports.suite.empty") })
      : table(h, {
          caption: enumLabel(tr, "reportKind", data.report),
          rows: data.rows,
          rowKey: (r) => r.key,
          columns: [
            {
              header: tLocal(ctx.locale, "groupCol"),
              cell: (r) =>
                r.label ??
                (data.groupBy === "month" ? Format.formatMonth(ctx.locale, r.key) : r.key || "—"),
            },
            {
              header: tLocal(ctx.locale, "count"),
              align: "end",
              numeric: true,
              cell: (r) => String(r.count),
            },
            ...(data.groupBy === "currency"
              ? [
                  {
                    header: tLocal(ctx.locale, "original"),
                    align: "end" as const,
                    numeric: true,
                    cell: (r: RevenueReportRecord["rows"][number]) =>
                      r.original === null
                        ? "—"
                        : moneyText(ctx.locale, r.original.amount, r.original.currency),
                  },
                ]
              : []),
            {
              header: tLocal(ctx.locale, "net"),
              align: "end",
              numeric: true,
              cell: (r) => moneyText(ctx.locale, r.net.amount, r.net.currency),
            },
            {
              header: tLocal(ctx.locale, "vat"),
              align: "end",
              numeric: true,
              cell: (r) => moneyText(ctx.locale, r.vat.amount, r.vat.currency),
            },
            {
              header: tLocal(ctx.locale, "gross"),
              align: "end",
              numeric: true,
              cell: (r) =>
                h.strong.children([moneyText(ctx.locale, r.gross.amount, r.gross.currency)]),
            },
          ],
        });

  return h.div.class("kb-stack").children([
    ...(isExpenses && data.incomplete > 0
      ? [
          banner(h, {
            text: tLocal(ctx.locale, "incompleteNotice", { count: data.incomplete }),
            tone: "info",
          }),
        ]
      : []),
    kpis,
    chart,
    tableEl,
  ]);
};

const renderCashflowReport = (
  h: Html.H<Message>,
  ctx: PageContext,
  data: CashflowReportRecord,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  return h.div.class("kb-stack").children([
    h.div.class("kb-kpi-strip").children([
      kpi(h, {
        label: tr.t("reports.suite.cashflow.in"),
        value: moneyText(ctx.locale, data.totals.in.amount, data.totals.in.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.cashflow.out"),
        value: moneyText(ctx.locale, data.totals.out.amount, data.totals.out.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.cashflow.net"),
        value: moneyText(ctx.locale, data.totals.net.amount, data.totals.net.currency),
      }),
    ]),
    data.points.length === 0
      ? emptyState(h, { title: tr.t("reports.suite.empty") })
      : reportBarChart(
          h,
          tLocal(ctx.locale, "chartTitleCashflow"),
          data.points.map((pt) => ({
            label: pt.month,
            value: parseUserDecimal(pt.in.amount) ?? 0,
            secondary: parseUserDecimal(pt.out.amount) ?? 0,
          })),
          [
            { label: tr.t("reports.suite.cashflow.in"), cls: "kb-chart-swatch--primary" },
            { label: tr.t("reports.suite.cashflow.out"), cls: "kb-chart-swatch--secondary" },
          ],
        ),
    data.points.length === 0
      ? h.text("")
      : table(h, {
          caption: enumLabel(tr, "reportKind", "cashflow"),
          rows: data.points,
          rowKey: (p) => p.month,
          columns: [
            {
              header: tLocal(ctx.locale, "monthCol"),
              cell: (p) => Format.formatMonth(ctx.locale, p.month),
            },
            {
              header: tr.t("reports.suite.cashflow.in"),
              align: "end",
              numeric: true,
              cell: (p) => moneyText(ctx.locale, p.in.amount, p.in.currency),
            },
            {
              header: tr.t("reports.suite.cashflow.out"),
              align: "end",
              numeric: true,
              cell: (p) => moneyText(ctx.locale, p.out.amount, p.out.currency),
            },
            {
              header: tr.t("reports.suite.cashflow.net"),
              align: "end",
              numeric: true,
              cell: (p) => h.strong.children([moneyText(ctx.locale, p.net.amount, p.net.currency)]),
            },
          ],
        }),
  ]);
};

const renderReceivablesReport = (
  h: Html.H<Message>,
  ctx: PageContext,
  data: ReceivablesReportRecord,
  wsSlug: string,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  const allDocs = data.buckets.flatMap((b) => b.documents);
  const bucketLabel = (b: ReceivablesReportRecord["buckets"][number]["bucket"]): string =>
    tLocal(ctx.locale, `aging_${b}`);

  return h.div.class("kb-stack").children([
    h.div.class("kb-kpi-strip").children([
      kpi(h, {
        label: tr.t("reports.suite.receivables.unpaid"),
        value: moneyText(ctx.locale, data.total.amount, data.total.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.receivables.overdue"),
        value: moneyText(ctx.locale, data.overdue.total.amount, data.overdue.total.currency),
        note: tLocal(ctx.locale, "revenueCountNote", { count: data.overdue.count }),
      }),
    ]),
    data.buckets.length === 0
      ? h.text("")
      : reportBarChart(
          h,
          tLocal(ctx.locale, "chartTitleReceivables"),
          data.buckets.map((b) => ({
            label: bucketLabel(b.bucket),
            value: parseUserDecimal(b.total.amount) ?? 0,
            tone: b.bucket === "not_due" ? "primary" : "overdue",
          })),
        ),
    allDocs.length === 0
      ? emptyState(h, { title: tr.t("reports.suite.empty") })
      : table(h, {
          caption: enumLabel(tr, "reportKind", "receivables"),
          rows: allDocs,
          rowKey: (d) => d.id,
          columns: [
            {
              header: tLocal(ctx.locale, "docCol"),
              cell: (d) =>
                h.a
                  .attr(
                    "href",
                    href({
                      _tag: "Document",
                      ws: wsSlug as Route["ws"],
                      id: d.id as never,
                      tab: "preview",
                    }),
                  )
                  .children([mono(h, d.number ?? d.id.slice(0, 8))]),
            },
            {
              header: tLocal(ctx.locale, "customerCol"),
              cell: (d) => d.contact.name,
            },
            {
              header: tLocal(ctx.locale, "agingCol"),
              cell: (d) =>
                d.daysOverdue > 0
                  ? badge(h, tr.t("common.time.daysOverdue", { count: d.daysOverdue }), "overdue")
                  : badge(h, tLocal(ctx.locale, "notDue"), "neutral"),
            },
            {
              header: tLocal(ctx.locale, "dueCol"),
              align: "end",
              numeric: true,
              cell: (d) =>
                h.strong.children([
                  moneyText(ctx.locale, d.outstanding.amount, d.outstanding.currency),
                ]),
            },
            {
              header: tLocal(ctx.locale, "dueCzkCol"),
              align: "end",
              numeric: true,
              cell: (d) =>
                moneyText(ctx.locale, d.outstandingCzk.amount, d.outstandingCzk.currency),
            },
            {
              header: "",
              align: "end",
              cell: (d) =>
                linkButton(h, {
                  label:
                    d.daysOverdue > 0 ? tLocal(ctx.locale, "remind") : tLocal(ctx.locale, "pay"),
                  href: href({
                    _tag: "Document",
                    ws: wsSlug as Route["ws"],
                    id: d.id as never,
                    tab: "payments",
                    dialog: d.daysOverdue > 0 ? "send" : "payment",
                  }),
                  small: true,
                }),
            },
          ],
        }),
  ]);
};

const renderVatSummaryReport = (
  h: Html.H<Message>,
  ctx: PageContext,
  data: VatSummaryReportRecord,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  const isNonVatPayer = ctx.workspace?.taxRegime === "non_vat_payer";
  const outputBaseSum = data.output.reduce(
    (acc, line) => acc + (parseUserDecimal(line.base.amount) ?? 0),
    0,
  );
  const ratio = Math.min(100, Math.round((outputBaseSum / TURNOVER_THRESHOLD_CZK) * 100));

  const thresholdCard = isNonVatPayer
    ? card(h, [
        h.div.class("kb-threshold-card").children([
          h.div
            .class("kb-spread")
            .children([
              h.h2.children([tLocal(ctx.locale, "thresholdTitle")]),
              badge(h, `${ratio} %`, ratio >= 80 ? "overdue" : "proforma"),
            ]),
          h.p.children([
            tr.t("reports.suite.vat.thresholdHint", {
              amount: moneyText(ctx.locale, String(outputBaseSum), "CZK"),
              threshold: moneyText(ctx.locale, String(TURNOVER_THRESHOLD_CZK), "CZK"),
            }),
          ]),
          h.div.class("kb-progress-track").children([
            h.div
              .class(ratio >= 80 ? "kb-progress-fill kb-progress-fill--warn" : "kb-progress-fill")
              .style({ width: `${ratio}%` })
              .children([]),
          ]),
          h.p.class("kb-small kb-muted").children([tLocal(ctx.locale, "thresholdNote")]),
        ]),
      ])
    : h.text("");

  const renderLines = (
    sectionTitle: string,
    lines: VatSummaryReportRecord["output"],
  ): Markup<Message> =>
    card(h, [
      cardTitle(h, sectionTitle),
      lines.length === 0
        ? h.p.class("kb-muted").children([tr.t("reports.suite.empty")])
        : table(h, {
            caption: sectionTitle,
            rows: lines,
            rowKey: (l) => `${l.month}-${l.treatment}-${l.ratePercent}`,
            columns: [
              {
                header: tLocal(ctx.locale, "monthCol"),
                cell: (l) => Format.formatMonth(ctx.locale, l.month),
              },
              {
                header: tLocal(ctx.locale, "vatRateCol"),
                cell: (l) =>
                  `${enumLabel(tr, "vatTreatment", l.treatment as VatTreatment)} (${l.ratePercent} %)`,
              },
              {
                header: tLocal(ctx.locale, "vatBaseCol"),
                align: "end",
                numeric: true,
                cell: (l) => moneyText(ctx.locale, l.base.amount, l.base.currency),
              },
              {
                header: tLocal(ctx.locale, "vatTaxCol"),
                align: "end",
                numeric: true,
                cell: (l) =>
                  h.strong.children([moneyText(ctx.locale, l.vat.amount, l.vat.currency)]),
              },
              {
                header: tLocal(ctx.locale, "vatSourcesCol"),
                align: "end",
                numeric: true,
                cell: (l) => String(l.documents.length),
              },
            ],
          }),
    ]);

  return h.div.class("kb-stack").children([
    thresholdCard,
    h.div.class("kb-kpi-strip").children([
      kpi(h, {
        label: tr.t("reports.suite.vat.output"),
        value: moneyText(ctx.locale, data.totals.output.amount, data.totals.output.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.vat.input"),
        value: moneyText(ctx.locale, data.totals.input.amount, data.totals.input.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.vat.balance"),
        value: moneyText(ctx.locale, data.totals.payable.amount, data.totals.payable.currency),
      }),
    ]),
    reportBarChart(h, tLocal(ctx.locale, "chartTitleVat"), [
      {
        label: tr.t("reports.suite.vat.output"),
        value: parseUserDecimal(data.totals.output.amount) ?? 0,
        tone: "primary",
      },
      {
        label: tr.t("reports.suite.vat.input"),
        value: parseUserDecimal(data.totals.input.amount) ?? 0,
        tone: "secondary",
      },
    ]),
    renderLines(tLocal(ctx.locale, "vatOutputTitle"), data.output),
    renderLines(tLocal(ctx.locale, "vatInputTitle"), data.input),
  ]);
};

const renderProfitReport = (
  h: Html.H<Message>,
  ctx: PageContext,
  data: ProfitReportRecord,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  return h.div.class("kb-stack").children([
    h.div.class("kb-kpi-strip").children([
      kpi(h, {
        label: tr.t("reports.suite.profit.revenue"),
        value: moneyText(ctx.locale, data.totals.revenue.amount, data.totals.revenue.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.profit.expenses"),
        value: moneyText(ctx.locale, data.totals.expenses.amount, data.totals.expenses.currency),
      }),
      kpi(h, {
        label: tr.t("reports.suite.profit.result"),
        value: moneyText(ctx.locale, data.totals.profit.amount, data.totals.profit.currency),
      }),
    ]),
    data.rows.length === 0
      ? emptyState(h, { title: tr.t("reports.suite.empty") })
      : table(h, {
          caption: enumLabel(tr, "reportKind", "profit"),
          rows: data.rows,
          rowKey: (r) => r.month,
          columns: [
            {
              header: tLocal(ctx.locale, "monthCol"),
              cell: (r) => Format.formatMonth(ctx.locale, r.month),
            },
            {
              header: tr.t("reports.suite.profit.revenue"),
              align: "end",
              numeric: true,
              cell: (r) => moneyText(ctx.locale, r.revenue.amount, r.revenue.currency),
            },
            {
              header: tr.t("reports.suite.profit.expenses"),
              align: "end",
              numeric: true,
              cell: (r) => moneyText(ctx.locale, r.expenses.amount, r.expenses.currency),
            },
            {
              header: tr.t("reports.suite.profit.result"),
              align: "end",
              numeric: true,
              cell: (r) =>
                h.strong.children([moneyText(ctx.locale, r.profit.amount, r.profit.currency)]),
            },
          ],
        }),
  ]);
};

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  const loaded = Remote.dataOf(model.data);

  const tabItems = REPORT_TABS.map((kind) => ({
    id: kind,
    label: enumLabel(tr, "reportKind", kind),
    href: href({ _tag: "Reports", ws: route.ws, report: kind, period: route.period }),
  }));

  const groupItems =
    route.report === "revenue"
      ? (["month", "contact", "currency"] as const)
      : route.report === "expenses"
        ? (["month", "contact", "currency", "category"] as const)
        : [];

  const controls = h.div.class("kb-report-controls").children([
    h.div.class("kb-row").children([
      select(h, {
        id: "reports-period",
        label: tr.t("reports.suite.period"),
        value: route.period,
        options: periodOptions(route.period, ctx.locale),
        onChange: (period) => Message.ChangedPeriod({ period }),
      }),
      ...(groupItems.length > 0
        ? [
            segmented(h, {
              label: tr.t("reports.suite.groupBy"),
              selected: model.groupBy,
              items: groupItems.map((g) => ({
                id: g,
                label: enumLabel(tr, "reportGroupBy", g),
              })),
              onSelect: (id) => Message.ChangedGroupBy({ groupBy: id as GroupByLiteral }),
            }),
          ]
        : []),
    ]),
    button(h, {
      label: tr.t("reports.suite.export"),
      variant: "primary",
      icon: icon(h, "download", 16),
      onClick: Message.OpenedExport(),
    }),
  ]);

  const body = (() => {
    if (model.data._tag === "Loading" || model.data._tag === "Idle") {
      return h.div
        .class("kb-stack")
        .children([
          h.div
            .class("kb-kpi-strip")
            .children([
              card(h, [skeleton(h, "40%", "0.8rem"), skeleton(h, "70%", "1.6rem")]),
              card(h, [skeleton(h, "40%", "0.8rem"), skeleton(h, "70%", "1.6rem")]),
              card(h, [skeleton(h, "40%", "0.8rem"), skeleton(h, "70%", "1.6rem")]),
            ]),
          skeletonTable(
            h,
            [
              tLocal(ctx.locale, "groupCol"),
              tLocal(ctx.locale, "net"),
              tLocal(ctx.locale, "vat"),
              tLocal(ctx.locale, "gross"),
            ],
            5,
          ),
        ]);
    }
    if (model.data._tag === "Failed") {
      return banner(h, {
        text: textOf(tr, model.data.failure.text),
        tone: "error",
        action: button(h, {
          label: tr.t("common.action.retry"),
          small: true,
          onClick: Message.ClickedRetry(),
        }),
      });
    }
    if (loaded === undefined) return h.text("");
    switch (loaded.report) {
      case "revenue":
      case "expenses":
        return renderAmountReport(h, ctx, loaded);
      case "cashflow":
        return renderCashflowReport(h, ctx, loaded);
      case "receivables":
        return renderReceivablesReport(h, ctx, loaded, route.ws);
      case "vat_summary":
        return renderVatSummaryReport(h, ctx, loaded);
      case "profit":
        return renderProfitReport(h, ctx, loaded);
    }
  })();

  const exportModal = !model.exportOpen
    ? h.text("")
    : dialog(h, {
        id: "reports-export-dialog",
        title: tr.t("reports.export.title"),
        onClose: Message.ClosedExport(),
        body: [
          h.p
            .class("kb-muted")
            .children([tLocal(ctx.locale, "exportDesc", { period: route.period })]),
          ...(model.exportError !== null
            ? [banner(h, { text: model.exportError, tone: "error" })]
            : []),
          h.div.class("kb-field").children([
            h.span.class("kb-field__label").children([tr.t("reports.export.format")]),
            segmented(h, {
              label: tr.t("reports.export.format"),
              selected: model.exportFormat,
              items: [
                { id: "csv", label: enumLabel(tr, "exportFormat", "csv") },
                { id: "pdf", label: enumLabel(tr, "exportFormat", "pdf") },
              ],
              onSelect: (id) => Message.SelectedExportFormat({ format: id as ExportFormatLiteral }),
            }),
          ]),
        ],
        actions: [
          button(h, {
            label: tr.t("common.action.cancel"),
            onClick: Message.ClosedExport(),
          }),
          button(h, {
            label: tr.t("common.action.download"),
            variant: "primary",
            busy: model.exporting,
            icon: icon(h, "download", 16),
            onClick: Message.SubmittedExport(),
          }),
        ],
      });

  return page(h, [
    pageHeader(h, {
      title: tr.t("reports.suite.title"),
      subtitle: tLocal(ctx.locale, "subtitle"),
    }),
    tabs(h, {
      label: tr.t("reports.suite.title"),
      items: tabItems,
      selected: route.report,
    }),
    controls,
    body,
    exportModal,
  ]);
};
