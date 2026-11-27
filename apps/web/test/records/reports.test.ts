import { describe, expect, test } from "bun:test";
import { Html, HtmlServer } from "@effect/ui/html";
import { IsoDate } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import * as Reports from "../../src/page/records/reports";
import { periodOptions, periodToRange, type ReportDataRecord } from "../../src/page/records/shared";
import { ctxFor, DEMO_WORKSPACES, renderPath, signedIn, WS } from "../support";

const escapedContactLabelPattern =
  /kb-bar-chart__label[^>]*>&lt;contact-label[^>]*A &amp; B&lt;\/contact-label&gt;<\/span>/;

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
    expect(periodToRange("2026")).toEqual({
      from: IsoDate.make("2026-01-01"),
      to: IsoDate.make("2026-12-31"),
    });
    expect(periodToRange("2026-Q2")).toEqual({
      from: IsoDate.make("2026-04-01"),
      to: IsoDate.make("2026-06-30"),
    });
    expect(periodToRange("2024-02")).toEqual({
      from: IsoDate.make("2024-02-01"),
      to: IsoDate.make("2024-02-29"),
    });
    expect(periodToRange("0999-01")).toEqual({
      from: IsoDate.make("0999-01-01"),
      to: IsoDate.make("0999-01-31"),
    });
    expect(periodToRange("0000-02")).toEqual({
      from: IsoDate.make("0000-02-01"),
      to: IsoDate.make("0000-02-29"),
    });
  });

  test("renders early-year report links with four-digit selector options", async () => {
    const [year, month] = await Promise.all([
      renderPath(`/w/${WS}/reports/revenue?period=1000`, { locale: "en" }),
      renderPath(`/w/${WS}/reports/revenue?period=0999-01`, { locale: "en" }),
    ]);
    expect(year.html).toContain('value="0999"');
    expect(month.html).toContain('value="0999-01"');
    expect(Arr.map(periodOptions("0000", "en"), (option) => option.value)).toEqual([
      "0000",
      "0000-Q4",
      "0000-Q3",
      "0000-Q2",
      "0000-Q1",
    ]);
  });

  test("groupBy switch bumps seq and drops stale responses", () => {
    const route: Reports.Route = {
      _tag: "Reports",
      ws: WS,
      report: "revenue",
      period: "2026",
    };
    const ctx = ctxFor({ route, locale: "cs" });
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
      period: "2026",
    };
    const ctx = ctxFor({ route });
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
      period: "2026-Q4",
    };
    const ctx = ctxFor({ route, locale: "en" });
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
      period: "2026",
    };
    const ctx = ctxFor({ route, locale: "en" });
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
          rows: Arr.map(SAMPLE_REVENUE.rows, (row) => ({ ...row, key: "contact-1", label })),
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
      view: (h, current) => Reports.view(current, ctx, h),
    });
    const { html } = await Effect.runPromise(HtmlServer.renderToHtml(report, {}));
    expect(html).toMatch(escapedContactLabelPattern);
    expect(html).toContain(
      'title="&lt;contact-label class=&quot;vip&quot;&gt;A &amp; B&lt;/contact-label&gt;: 242000"',
    );
    expect(html).not.toContain("<contact-label");
  });

  test("SSR renders all report tabs in cs and en including non-VAT payer workspace", async () => {
    const tabs = ["revenue", "expenses", "cashflow", "receivables", "vat-summary"] as const;
    const reports = await Promise.all(
      Arr.map(tabs, (tab) => renderPath(`/w/${WS}/reports/${tab}?period=2026`, { locale: "cs" })),
    );
    for (const res of reports) {
      expect(res.title).toContain("Přehledy");
      expect(res.html).toContain("kb-tabs");
    }

    const nonVatWs = DEMO_WORKSPACES[1]?.slug ?? WS;
    const enRes = await renderPath(`/w/${nonVatWs}/reports/vat-summary?period=2026`, {
      locale: "en",
      session: signedIn,
    });
    expect(enRes.title).toContain("Reports");
  });
});
