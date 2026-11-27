import { describe, expect, test } from "bun:test";
import { Html, HtmlServer } from "@effect/ui/html";
import type { ViewModels } from "@kvitbit/ui-port";
import { Effect } from "effect";
import * as Reports from "../../src/page/records/reports";
import { periodToRange, type ReportDataRecord } from "../../src/page/records/shared";
import { ctxFor, DEMO_WORKSPACES, renderPath, signedIn, WS } from "../support";

const SAMPLE_REVENUE: ReportDataRecord = {
  report: "revenue",
  period: { from: "2026-01-01", to: "2026-12-31" },
  groupBy: "month",
  rows: [
    {
      key: "2026-11",
      label: null,
      count: 4,
      net: { amount: "200000.00", currency: "CZK" },
      vat: { amount: "42000.00", currency: "CZK" },
      gross: { amount: "242000.00", currency: "CZK" },
      original: null,
    },
  ],
  totals: {
    count: 4,
    net: { amount: "200000.00", currency: "CZK" },
    vat: { amount: "42000.00", currency: "CZK" },
    gross: { amount: "242000.00", currency: "CZK" },
  },
};

const SAMPLE_VAT: ReportDataRecord = {
  report: "vat_summary",
  period: { from: "2026-01-01", to: "2026-12-31" },
  output: [
    {
      month: "2026-11",
      treatment: "standard",
      ratePercent: "21",
      base: { amount: "1500000.00", currency: "CZK" },
      vat: { amount: "315000.00", currency: "CZK" },
      documents: [{ _tag: "Document", id: "doc-1" }],
    },
  ],
  input: [
    {
      month: "2026-11",
      treatment: "standard",
      ratePercent: "21",
      base: { amount: "20000.00", currency: "CZK" },
      vat: { amount: "4200.00", currency: "CZK" },
      documents: [{ _tag: "Expense", id: "exp-1" }],
    },
  ],
  totals: {
    output: { amount: "315000.00", currency: "CZK" },
    input: { amount: "4200.00", currency: "CZK" },
    payable: { amount: "310800.00", currency: "CZK" },
  },
};

describe("Reports Suite page TEA", () => {
  test("periodToRange converts year, quarter, and month periods accurately", () => {
    expect(periodToRange("2026" as ViewModels.Period)).toEqual({
      from: "2026-01-01" as never,
      to: "2026-12-31" as never,
    });
    expect(periodToRange("2026-Q2" as ViewModels.Period)).toEqual({
      from: "2026-04-01" as never,
      to: "2026-06-30" as never,
    });
    expect(periodToRange("2024-02" as ViewModels.Period)).toEqual({
      from: "2024-02-01" as never,
      to: "2024-02-29" as never,
    });
  });

  test("groupBy switch bumps seq and drops stale responses", () => {
    const route: Reports.Route = {
      _tag: "Reports",
      ws: WS,
      report: "revenue",
      period: "2026" as ViewModels.Period,
    };
    const ctx = ctxFor(route, { locale: "cs" });
    let { model } = Reports.init(route, ctx);
    expect(model.data._tag).toBe("Loading");

    // Switch groupBy to contact (seq 2)
    const grouped = Reports.update(
      model,
      Reports.Message.ChangedGroupBy({ groupBy: "contact" }),
      ctx,
    );
    model = grouped.model;
    expect(grouped.commands?.length).toBe(1);

    // Late seq 1 dropped
    model = Reports.update(
      model,
      Reports.Message.LoadedReport({ seq: 1, report: SAMPLE_REVENUE }),
      ctx,
    ).model;
    expect(model.data._tag).toBe("Loading");

    // Current seq 2 accepted
    model = Reports.update(
      model,
      Reports.Message.LoadedReport({ seq: 2, report: SAMPLE_REVENUE }),
      ctx,
    ).model;
    expect(model.data._tag).toBe("Loaded");
  });

  test("period change navigates to the updated report route", () => {
    const route: Reports.Route = {
      _tag: "Reports",
      ws: WS,
      report: "cashflow",
      period: "2026" as ViewModels.Period,
    };
    const ctx = ctxFor(route);
    const { model } = Reports.init(route, ctx);
    const next = Reports.update(model, Reports.Message.ChangedPeriod({ period: "2026-Q4" }), ctx);
    expect(next.outMessage).toEqual({
      _tag: "Navigate",
      path: `/w/${WS}/reports/cashflow?period=2026-Q4`,
      replace: false,
    });
  });

  test("export dialog opens, switches CSV/PDF format, and triggers download command", () => {
    const route: Reports.Route = {
      _tag: "Reports",
      ws: WS,
      report: "vat_summary",
      period: "2026-Q4" as ViewModels.Period,
    };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Reports.init(route, ctx);
    model = Reports.update(
      model,
      Reports.Message.LoadedReport({ seq: 1, report: SAMPLE_VAT }),
      ctx,
    ).model;

    model = Reports.update(model, Reports.Message.OpenedExport(), ctx).model;
    expect(model.exportOpen).toBe(true);
    expect(model.exportFormat).toBe("csv");

    model = Reports.update(
      model,
      Reports.Message.SelectedExportFormat({ format: "pdf" }),
      ctx,
    ).model;
    expect(model.exportFormat).toBe("pdf");

    const submitted = Reports.update(model, Reports.Message.SubmittedExport(), ctx);
    expect(submitted.model.exporting).toBe(true);
    expect(submitted.commands?.length).toBe(1);

    const done = Reports.update(submitted.model, Reports.Message.CompletedExport(), ctx);
    expect(done.model.exporting).toBe(false);
    expect(done.model.exportOpen).toBe(false);
    expect(done.outMessage?._tag).toBe("Toast");
  });

  test("SSR renders stored contact labels as chart text and escaped titles", async () => {
    const label = '<contact-label class="vip">A & B</contact-label>';
    const route: Reports.Route = {
      _tag: "Reports",
      ws: WS,
      report: "revenue",
      period: "2026" as ViewModels.Period,
    };
    const ctx = ctxFor(route, { locale: "en" });
    const { model } = Reports.init(route, ctx);
    const grouped = Reports.update(
      model,
      Reports.Message.ChangedGroupBy({ groupBy: "contact" }),
      ctx,
    );
    const loaded = Reports.update(
      grouped.model,
      Reports.Message.LoadedReport({
        seq: 2,
        report: {
          ...SAMPLE_REVENUE,
          groupBy: "contact",
          rows: SAMPLE_REVENUE.rows.map((row) => ({ ...row, key: "contact-1", label })),
        },
      }),
      ctx,
    );
    const report = Html.component({
      name: "ContactReportFixture",
      model: Reports.Model,
      message: Reports.Message,
    }).make({
      init: () => loaded.model,
      update: ($) => $.model,
      view: (h, model) => Reports.view(model, ctx, h),
    });
    const { html } = await Effect.runPromise(HtmlServer.renderToHtml(report, {}));
    expect(html).toMatch(
      /data-slot="bar-chart-label"[^>]*>&lt;contact-label[^>]*A &amp; B&lt;\/contact-label&gt;<\/span>/,
    );
    expect(html).toContain(
      'title="&lt;contact-label class=&quot;vip&quot;&gt;A &amp; B&lt;/contact-label&gt;: 242000"',
    );
    expect(html).not.toContain("<contact-label");
  });

  test("SSR renders all report tabs in cs and en including non-VAT payer workspace", async () => {
    const tabs = ["revenue", "expenses", "cashflow", "receivables", "vat-summary"] as const;
    for (const tab of tabs) {
      const res = await renderPath(`/w/${WS}/reports/${tab}?period=2026`, { locale: "cs" });
      expect(res.title).toContain("Přehledy");
      expect(res.html).toContain('data-slot="tabs"');
    }

    const nonVatWs = DEMO_WORKSPACES[1]?.slug ?? WS;
    const enRes = await renderPath(`/w/${nonVatWs}/reports/vat-summary?period=2026`, {
      locale: "en",
      session: signedIn,
    });
    expect(enRes.title).toContain("Reports");
  });
});
