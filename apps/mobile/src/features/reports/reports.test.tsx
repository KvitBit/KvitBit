import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  DocumentId,
  IsoDate,
  ReportView,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Period } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { ReactElement } from "react";
import {
  fakeTransfer,
  useFakeTransfer as installFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider, type ApiRunner } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { allText, hostTree } from "../../testing/element-tree";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { recordedOverlay } from "../../testing/recorded-overlay";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { loadOverdueDocuments } from "../dashboard/data";
import {
  buildReportExportRequest,
  decodeReportView,
  isValidPeriod,
  parseReportKind,
  periodPresets,
  periodToRange,
  shiftPeriod,
} from "./model";

const transferFake = fakeTransfer();

mock.module("expo-router", () => ({
  ...expoRouterStandIn(),
  router: {
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  },
}));
installFakeTransfer(transferFake);

const { ReportsScreen } = await import("./reports-screen");
const { ReportsProbe } = await import("./test-probe");
const { useTransfer } = await import("../../platform/transfer");

const WS_ID = WorkspaceId.make("01937c7a-0000-7000-8000-000000000001");
const DOC_1 = DocumentId.make("01937c7a-0000-7000-8000-000000000801");

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

describe("reports model", () => {
  test("keeps four-digit years and stops between the first and last supported periods", () => {
    expect(periodToRange(Period.make("0999-01"))).toEqual({
      from: IsoDate.make("0999-01-01"),
      to: IsoDate.make("0999-01-31"),
    });
    expect(periodToRange(Period.make("0000-02"))).toEqual({
      from: IsoDate.make("0000-02-01"),
      to: IsoDate.make("0000-02-29"),
    });
    expect(shiftPeriod(Period.make("1000-01"), -1)).toBe("0999-12");
    expect(shiftPeriod(Period.make("0000-01"), -1)).toBe("0000-01");
    expect(shiftPeriod(Period.make("9999-Q4"), 1)).toBe("9999-Q4");
    expect(shiftPeriod(Period.make("9999"), 1)).toBe("9999");
  });

  test("parses report segments and computes inclusive period ranges", () => {
    expect(parseReportKind("vat-summary")).toBe("vat_summary");
    expect(parseReportKind("receivables")).toBe("receivables");
    expect(parseReportKind("unknown")).toBe("vat_summary");

    expect(isValidPeriod("2026-11")).toBe(true);
    expect(isValidPeriod("2026-Q4")).toBe(true);
    expect(isValidPeriod("2026")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);

    expect(periodToRange(Period.make("2024-02"))).toEqual({
      from: IsoDate.make("2024-02-01"),
      to: IsoDate.make("2024-02-29"),
    });
    expect(periodToRange(Period.make("2026-02"))).toEqual({
      from: IsoDate.make("2026-02-01"),
      to: IsoDate.make("2026-02-28"),
    });
    expect(periodToRange(Period.make("2026-Q4"))).toEqual({
      from: IsoDate.make("2026-10-01"),
      to: IsoDate.make("2026-12-31"),
    });
    expect(periodToRange(Period.make("2026"))).toEqual({
      from: IsoDate.make("2026-01-01"),
      to: IsoDate.make("2026-12-31"),
    });
  });

  test("shifts periods across year boundaries and computes presets", () => {
    expect(shiftPeriod(Period.make("2026-01"), -1)).toBe(Period.make("2025-12"));
    expect(shiftPeriod(Period.make("2026-12"), 1)).toBe(Period.make("2027-01"));
    expect(shiftPeriod(Period.make("2026-Q1"), -1)).toBe(Period.make("2025-Q4"));
    expect(shiftPeriod(Period.make("2026-Q4"), 1)).toBe(Period.make("2027-Q1"));
    expect(shiftPeriod(Period.make("2026"), 1)).toBe(Period.make("2027"));

    const presets = periodPresets(
      DateTime.makeUnsafe("2026-01-15T12:00:00Z").pipe(DateTime.toDateUtc),
    );
    expect(presets.thisMonth).toBe(Period.make("2026-01"));
    expect(presets.lastMonth).toBe(Period.make("2025-12"));
    expect(presets.thisQuarter).toBe(Period.make("2026-Q1"));
    expect(presets.thisYear).toBe(Period.make("2026"));
  });

  test("builds CSV and PDF export download requests", () => {
    const csv = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "vat_summary",
      period: Period.make("2026-11"),
      format: "csv",
    });
    expect(csv.path).toBe(`/workspaces/${WS_ID}/reports/vat_summary/export`);
    expect(csv.query).toEqual({
      format: "csv",
      from: "2026-11-01",
      to: "2026-11-30",
      groupBy: undefined,
    });
    expect(csv.filename).toBe("kvitbit-vat_summary-2026-11.csv");
    expect(csv.contentType).toContain("text/csv");

    const pdf = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "receivables",
      period: Period.make("2026-Q4"),
      format: "pdf",
    });
    expect(pdf.filename).toBe("kvitbit-receivables-2026-Q4.pdf");
    expect(pdf.contentType).toBe("application/pdf");
  });

  test("decodes VAT summary and receivables reports", () => {
    const vat = decodeReportView(
      ReportView.make({
        report: "vat_summary",
        period: { from: "2026-11-01", to: "2026-11-30" },
        output: [
          {
            month: "2026-11",
            treatment: "standard",
            ratePercent: "21",
            base: { amount: "10000.00", currency: "CZK" },
            vat: { amount: "2100.00", currency: "CZK" },
            documents: [{ _tag: "Document", id: DOC_1 }],
          },
        ],
        input: [],
        totals: {
          output: { amount: "2100.00", currency: "CZK" },
          input: { amount: "500.00", currency: "CZK" },
          payable: { amount: "1600.00", currency: "CZK" },
        },
      }),
      "vat_summary",
    );
    if (vat.report !== "vat_summary") throw new Error("Expected a VAT summary");
    expect(vat.totals.payable.amount).toBe("1600.00");
    expect(vat.output).toHaveLength(1);
  });
});

describe("reports screen and API/export integration", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (Str.endsWith("/reports/vat_summary")(url.pathname)) {
          return Response.json({
            report: "vat_summary",
            period: { from: "2026-11-01", to: "2026-11-30" },
            output: [
              {
                month: "2026-11",
                treatment: "standard",
                ratePercent: "21",
                base: { amount: "10000.00", currency: "CZK" },
                vat: { amount: "2100.00", currency: "CZK" },
                documents: [{ _tag: "Document", id: DOC_1 }],
              },
            ],
            input: [],
            totals: {
              output: { amount: "2100.00", currency: "CZK" },
              input: { amount: "500.00", currency: "CZK" },
              payable: { amount: "1600.00", currency: "CZK" },
            },
          });
        }
        if (Str.endsWith("/reports/profit")(url.pathname)) {
          return Response.json({
            report: "profit",
            period: { from: "2026-11-01", to: "2026-11-30" },
            rows: [
              {
                month: "2026-11",
                revenue: { amount: "50000.00", currency: "CZK" },
                expenses: { amount: "12000.00", currency: "CZK" },
                profit: { amount: "38000.00", currency: "CZK" },
              },
            ],
            totals: {
              revenue: { amount: "50000.00", currency: "CZK" },
              expenses: { amount: "12000.00", currency: "CZK" },
              profit: { amount: "38000.00", currency: "CZK" },
            },
          });
        }
        if (Str.endsWith("/reports/receivables")(url.pathname)) {
          return Response.json({
            report: "receivables",
            period: { from: "2026-11-01", to: "2026-11-30" },
            asOf: "2026-11-30",
            buckets: [
              {
                bucket: "1_30",
                count: 1,
                total: { amount: "9500.00", currency: "CZK" },
                documents: [
                  {
                    id: DOC_1,
                    kind: "invoice",
                    number: "2026-0077",
                    contact: { id: null, name: "Late Payer s.r.o." },
                    currency: "CZK",
                    dueOn: "2026-11-10",
                    daysOverdue: 20,
                    outstanding: { amount: "9500.00", currency: "CZK" },
                    outstandingCzk: { amount: "9500.00", currency: "CZK" },
                  },
                ],
              },
            ],
            total: { amount: "9500.00", currency: "CZK" },
            overdue: { total: { amount: "9500.00", currency: "CZK" }, count: 1 },
          });
        }
        return Response.json({ _tag: "NotFound", entity: "Report" }, { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const within = (node: ReactElement) => (
    <TestProviders overlay={recordedOverlay()}>
      <ApiProvider token="tok" origin={server.url.origin}>
        <WorkspaceProvider workspace={WORKSPACE} workspaces={[WORKSPACE]} reload={() => undefined}>
          {node}
        </WorkspaceProvider>
      </ApiProvider>
    </TestProviders>
  );

  test("ReportsScreen renders selector, period picker and CSV/PDF export actions via hostTree", () => {
    const text = allText(
      hostTree(
        <ReportsScreen report="vat_summary" initialPeriod={Period.make("2026-11")} />,
        within,
      ),
    );
    expect(text).toContain("Reports");
    expect(text).toContain("VAT summary");
    expect(text).toContain("Profit");
    expect(text).toContain("Receivables");
    expect(text).toContain("2026-11");
    expect(text).toContain("Export CSV");
    expect(text).toContain("Export PDF");
  });

  test("end-to-end API + Transfer runtime runs VAT, profit, receivables and exports CSV/PDF", async () => {
    installFakeTransfer(transferFake);
    transferFake.downloads.length = 0;
    transferFake.shared.length = 0;

    const observed = {
      api: Option.none<ApiRunner>(),
      transfer: Option.none<ReturnType<typeof useTransfer>>(),
    };
    let vatLoaded = false;

    await root.render(
      within(
        <ReportsProbe
          workspaceId={WS_ID}
          onReady={(a, tr, ok) => {
            observed.api = Option.some(a);
            observed.transfer = Option.some(tr);
            vatLoaded = ok;
          }}
        />,
      ),
    );
    await Effect.runPromise(
      eventually(
        () => vatLoaded && Option.isSome(observed.api) && Option.isSome(observed.transfer),
      ),
    );
    expect(vatLoaded).toBe(true);

    const api = Option.getOrNull(observed.api);
    const transfer = Option.getOrNull(observed.transfer);
    if (api === null || transfer === null) throw new Error("Reports providers did not mount");

    const profitRes = await api.run((c) =>
      c.reports.run({
        params: { workspaceId: WS_ID, report: "profit" },
        query: { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") },
      }),
    );
    if (profitRes._tag !== "Ok") throw new Error("Expected a profit report response");
    const profit = decodeReportView(profitRes.value, "profit");
    if (profit.report !== "profit") throw new Error("Expected a profit report");
    expect(profit.totals.profit.amount).toBe("38000.00");

    const recRes = await api.run((c) =>
      c.reports.run({
        params: { workspaceId: WS_ID, report: "receivables" },
        query: { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") },
      }),
    );
    if (recRes._tag !== "Ok") throw new Error("Expected a receivables report response");
    const receivables = decodeReportView(recRes.value, "receivables");
    if (receivables.report !== "receivables") throw new Error("Expected a receivables report");
    expect(receivables.overdue.count).toBe(1);
    expect(receivables.buckets[0]?.documents[0]?.number).toBe("2026-0077");
    expect(receivables.buckets[0]?.documents[0]?.outstanding.amount).toBe("9500.00");

    const overdue = await api.run((c) =>
      loadOverdueDocuments({
        api: c,
        workspaceId: WS_ID,
        query: {
          from: IsoDate.make("2026-11-30"),
          to: IsoDate.make("2026-11-30"),
        },
      }),
    );
    if (overdue._tag !== "Ok") throw new Error("Expected overdue documents");
    expect(Arr.map(overdue.value, ({ id, outstanding }) => [id, outstanding.amount])).toEqual([
      [DOC_1, "9500.00"],
    ]);

    // Export CSV & PDF via Transfer
    const csvReq = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "vat_summary",
      period: Period.make("2026-11"),
      format: "csv",
    });
    const csvDl = await transfer.download(csvReq);
    expect(csvDl._tag).toBe("Ok");
    if (csvDl._tag === "Ok") await transfer.share(csvDl.value);

    const pdfReq = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "receivables",
      period: Period.make("2026-11"),
      format: "pdf",
    });
    const pdfDl = await transfer.download(pdfReq);
    expect(pdfDl._tag).toBe("Ok");
    if (pdfDl._tag === "Ok") await transfer.share(pdfDl.value);

    expect(transferFake.downloads).toHaveLength(2);
    expect(transferFake.shared).toHaveLength(2);
  });
});
